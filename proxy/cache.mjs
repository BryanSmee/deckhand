// The egress proxy's cache of plain HTTP answers, for the hosts the operator lists in
// `cached_hosts` (the listener says which, ../listener/egress.mjs): package mirrors and
// downloads that every run fetches again otherwise. Shared by every sandbox, so only what
// is the same for anyone is kept: a GET without credentials, answered 200 for everyone.
//
// On disk, one entry per URL (and Accept-Encoding, Accept): `<sha256>.body` and its metadata,
// `<sha256>.json` (status, headers, stored at, last used, size). Each file is written to a
// temporary one and renamed into place, so an interrupted download leaves nothing behind.
// Over `max` bytes in all, the least recently used entries go. No dependencies.
import { createHash } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, tempPath } from "./atomic.mjs";

export const DEFAULT_MAX = 10 * 1024 ** 3;
export const DEFAULT_ENTRY_MAX = 1024 ** 3;

// "10g", "512m", "1048576" → bytes; `fallback` when unset. Throws on anything else.
export function parseSize(text, fallback) {
  if (text === undefined || text === "") return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(String(text).trim());
  if (!match) throw new Error(`expected a size in bytes or with k, m, g, t: ${text}`);
  const power = " kmgt".indexOf(match[2].toLowerCase() || " ");
  return Math.floor(Number(match[1]) * 1024 ** power);
}

// Not kept: they describe one connection, or one client.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
  "content-length",
  "x-deckhand-cache",
]);

export function keptHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_BY_HOP.has(k)));
}

function directives(value) {
  const list = new Map();
  for (const part of String(value ?? "").split(",")) {
    const [name, arg] = part.trim().toLowerCase().split("=");
    if (name) list.set(name, arg?.replace(/^"|"$/g, ""));
  }
  return list;
}

// Request headers that may carry a credential, by name (Private-Token, X-JFrog-Art-Api,
// X-Goog-Api-Key…): the host may answer them with what isn't everyone's. Not the proxy's
// own, which never reach the host, nor npm's `npm-auth-type`, sent on every request: it
// names a login flow, not a secret.
const CREDENTIAL = /auth|token|key|secret|password|credential|^x-jfrog-/;
const NOT_CREDENTIALS = new Set(["npm-auth-type"]);
const credentialLike = (name) =>
  !name.startsWith("proxy-") && !NOT_CREDENTIALS.has(name) && CREDENTIAL.test(name);

// A GET with a body: a host that answers before reading it reads the body as the next
// request on its connection (request smuggling), and only the key's request is checked.
const withBody = (h) =>
  Number(h["content-length"]) > 0 || h["transfer-encoding"] !== undefined || "expect" in h;

// How a request uses the cache: "skip" (forwarded as before: not a GET, a body, credentials,
// a range, no-store), "revalidate" (the client wants it checked: no-cache, max-age=0) or "use".
export function requestUse(req) {
  const h = req.headers;
  if (req.method !== "GET" || withBody(h) || h.cookie || h.range) return "skip";
  if (Object.keys(h).some(credentialLike)) return "skip";
  const cc = directives(h["cache-control"]);
  if (cc.has("no-store")) return "skip";
  if (cc.has("no-cache") || cc.get("max-age") === "0" || /no-cache/i.test(h.pragma ?? "")) {
    return "revalidate";
  }
  return "use";
}

// The only request headers that reach the host on the cache path, with `host`: what the
// answer is kept for has to be what anyone asking for the key would send. Anything else
// (X-HTTP-Method-Override, X-Forwarded-Host, hop-by-hop ones) could shape an answer kept for
// every repository.
const FORWARDED = [
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "if-none-match",
  "if-modified-since",
];

export function forwardedHeaders(headers, host) {
  const kept = { host };
  for (const name of FORWARDED) if (headers[name] !== undefined) kept[name] = headers[name];
  return kept;
}

// Whether the client asked only for a change: its If-None-Match / If-Modified-Since.
export const conditional = (req) =>
  "if-none-match" in req.headers || "if-modified-since" in req.headers;

// The request headers an answer varies on besides Accept and Accept-Encoding, which are part
// of the key: it is kept only for requests that send none of them (`Vary: Origin` on a
// mirror, for one without Origin), and only served to those.
const KEYED = new Set(["accept-encoding", "accept"]);
const varied = (headers) => [...directives(headers.vary).keys()].filter((v) => !KEYED.has(v));
export const fits = (req, headers) => varied(headers).every((v) => req.headers[v] === undefined);

// Whether an answer to `req` may be kept for everyone: a 200 that isn't private, varies on
// nothing the request sent but the key's headers, within `entryMax`. A cookie it sets is
// dropped, never kept (keptHeaders()): the request had none, so the answer is the one anyone
// gets, and CDNs set theirs on everything (Cloudflare's __cf_bm on npm's registry).
export function storable(status, headers, entryMax, req = { headers: {} }) {
  if (status !== 200) return false;
  const cc = directives(headers["cache-control"]);
  if (cc.has("private") || cc.has("no-store")) return false;
  if (directives(headers.vary).has("*") || !fits(req, headers)) return false;
  const length = headers["content-length"];
  return length === undefined || Number(length) <= entryMax;
}

// How long an entry stays fresh after it was stored, in ms: s-maxage or max-age, else
// Expires, else a tenth of its age since Last-Modified (a day at most), else 0 (always
// revalidated).
export function lifetime(headers) {
  const cc = directives(headers["cache-control"]);
  if (cc.has("no-cache")) return 0;
  for (const name of ["s-maxage", "max-age"]) {
    if (cc.has(name)) return Math.max(0, Number(cc.get(name)) || 0) * 1000;
  }
  const date = Date.parse(headers.date) || 0;
  if (headers.expires !== undefined) {
    const expires = Date.parse(headers.expires);
    return Number.isNaN(expires) || !date ? 0 : Math.max(0, expires - date);
  }
  const modified = Date.parse(headers["last-modified"]);
  if (date && !Number.isNaN(modified) && modified < date) {
    return Math.min((date - modified) / 10, 24 * 3600 * 1000);
  }
  return 0;
}

export function isFresh(meta, now) {
  const age = (Number(meta.headers.age) || 0) * 1000 + (now - meta.storedAt);
  return age < lifetime(meta.headers);
}

// Whether the client's own validators match a kept answer: it gets a 304.
export function notModified(req, headers) {
  const tags = req.headers["if-none-match"];
  if (tags !== undefined) {
    const weak = (t) => t.trim().replace(/^W\//, "");
    return (
      !!headers.etag &&
      (tags.trim() === "*" || tags.split(",").some((t) => weak(t) === weak(headers.etag)))
    );
  }
  const since = Date.parse(req.headers["if-modified-since"]);
  const modified = Date.parse(headers["last-modified"]);
  return !Number.isNaN(since) && !Number.isNaN(modified) && modified <= since;
}

// The store. `max`: bytes in all (0: no cache), `entryMax`: per entry; `now`: the clock.
export function createCache({
  dir,
  max = DEFAULT_MAX,
  entryMax = DEFAULT_ENTRY_MAX,
  now = Date.now,
  log = () => {},
}) {
  const index = new Map(); // key → { size, lastUsed }
  let total = 0;
  // Bytes of downloads being written, not kept yet (their Content-Length when they have one,
  // reserved as they start): on disk too, so counted against `max`.
  let pending = 0;
  const enabled = max > 0 && !!dir;
  const limit = Math.min(entryMax, max);
  // At most this much being written: downloads read slowly, or dropped before the end, never
  // evict more than half of what is kept (or one entry, for a cache that small).
  const pendingMax = Math.max(limit, max / 2);
  const bodyPath = (key) => join(dir, `${key}.body`);
  const metaPath = (key) => join(dir, `${key}.json`);

  const drop = (key) => {
    const entry = index.get(key);
    if (!entry) return;
    index.delete(key);
    total -= entry.size;
  };
  const add = (key, size, lastUsed) => {
    drop(key);
    index.set(key, { size, lastUsed });
    total += size;
  };

  async function remove(key) {
    drop(key);
    await Promise.all([unlink(metaPath(key)), unlink(bodyPath(key))].map((p) => p.catch(() => {})));
  }

  function oldest() {
    let found = null;
    for (const [key, { lastUsed }] of index) {
      if (!found || lastUsed < found.lastUsed) found = { key, lastUsed };
    }
    return found.key;
  }

  // Room for `bytes` more being written: the least recently used entries go (out of the
  // index at once, their files in the background). False when downloads take their share.
  function makeRoom(bytes) {
    if (pending + bytes > pendingMax) return false;
    while (total + pending + bytes > max && index.size) {
      const key = oldest();
      log(`cache: removed ${key}, least recently used`);
      remove(key);
    }
    return total + pending + bytes <= max;
  }

  const writeMeta = (key, meta) => atomicWrite(metaPath(key), JSON.stringify(meta));

  // What a previous proxy left: complete entries only.
  function load() {
    mkdirSync(dir, { recursive: true });
    const names = readdirSync(dir);
    for (const name of names) {
      const path = join(dir, name);
      if (name.startsWith("tmp-")) {
        unlinkSync(path);
        continue;
      }
      const key = /^([0-9a-f]{64})\.json$/.exec(name)?.[1];
      if (!key) continue;
      try {
        const meta = JSON.parse(readFileSync(path, "utf8"));
        if (statSync(bodyPath(key)).size !== meta.size) throw new Error("size");
        add(key, meta.size, meta.lastUsed ?? meta.storedAt);
      } catch {
        for (const p of [path, bodyPath(key)]) {
          try {
            unlinkSync(p);
          } catch {}
        }
      }
    }
    for (const name of names) {
      const key = /^([0-9a-f]{64})\.body$/.exec(name)?.[1];
      if (key && !index.has(key)) {
        try {
          unlinkSync(join(dir, name));
        } catch {}
      }
    }
  }

  let ready = enabled;
  if (enabled) {
    try {
      load();
    } catch (error) {
      log(`cache: off, ${dir} can't be used (${error.code ?? error.message})`);
      ready = false;
    }
  }

  return {
    get enabled() {
      return ready;
    },
    limit,
    // Bytes on disk: kept, and being written.
    get size() {
      return total + pending;
    },
    has: (key) => index.has(key),

    // Accept too, when the client sends one: npm's registry answers its packuments by it.
    key(url, acceptEncoding, accept) {
      const norm = (v) =>
        String(v ?? "")
          .toLowerCase()
          .replace(/\s+/g, "");
      const tail = accept === undefined ? "" : `\n${norm(accept)}`;
      return createHash("sha256")
        .update(`${norm(acceptEncoding)}\n${url}${tail}`)
        .digest("hex");
    },

    // The entry's metadata and its body, opened (so removing it meanwhile doesn't cut it
    // short), or null. One being replaced meanwhile may not match its metadata: a miss, and
    // the new one is there next time.
    async get(key) {
      if (!index.has(key)) return null;
      let file;
      try {
        const meta = JSON.parse(await readFile(metaPath(key)));
        file = await open(bodyPath(key));
        if ((await file.stat()).size !== meta.size) throw new Error("size");
        return { meta, file };
      } catch {
        await file?.close();
        return null;
      }
    },

    // Used now: last to be removed. Written in the background.
    touch(key, meta) {
      const entry = index.get(key);
      if (!entry) return;
      entry.lastUsed = now();
      writeMeta(key, { ...meta, lastUsed: entry.lastUsed }).catch(() => {});
    },

    // A 304 confirmed it: its new headers, stored now.
    async refresh(key, meta, headers) {
      const fresh = { ...meta, headers: { ...meta.headers, ...keptHeaders(headers) } };
      fresh.storedAt = fresh.lastUsed = now();
      if (index.has(key)) {
        index.get(key).lastUsed = fresh.lastUsed;
        await writeMeta(key, fresh).catch(() => {});
      }
      return fresh;
    },

    remove,

    // A new entry, written as its body comes: write() each chunk (false once over the limit,
    // or with no room left: dropped), then commit() once complete (`expected`: its
    // Content-Length, checked), or abort(). Room for its Content-Length is made once, as it
    // starts; one without makes room as it comes. Null when the downloads being written take
    // their share: the answer goes on without being kept.
    writer(key, { url, status, headers }) {
      const length = headers?.["content-length"];
      const reserved = length === undefined ? null : Number(length);
      if (reserved !== null && !makeRoom(reserved)) return null;
      pending += reserved ?? 0;
      const path = tempPath(dir);
      const stream = createWriteStream(path, { flags: "wx" });
      let size = 0;
      let done = false;
      const closed = new Promise((resolve) => stream.on("close", resolve));
      stream.on("error", () => abort());
      // Its bytes stay counted until its file is gone, or kept.
      const release = () => (pending -= reserved ?? size);
      function abort() {
        if (done) return;
        done = true;
        stream.destroy();
        closed.then(() => unlink(path).catch(() => {})).then(release);
      }
      return {
        write(chunk) {
          if (done) return false;
          const over = size + chunk.length > (reserved ?? limit);
          if (over || (reserved === null && !makeRoom(chunk.length))) {
            abort();
            return false;
          }
          size += chunk.length;
          if (reserved === null) pending += chunk.length;
          stream.write(chunk);
          return true;
        },
        abort,
        async commit(expected) {
          if (done) return false;
          if (expected !== undefined && Number(expected) !== size) {
            abort();
            return false;
          }
          done = true;
          stream.end();
          await closed;
          if (stream.errored) {
            await unlink(path).catch(() => {});
            release();
            return false;
          }
          const at = now();
          const meta = {
            url,
            status,
            headers: keptHeaders(headers),
            storedAt: at,
            lastUsed: at,
            size,
          };
          try {
            await rename(path, bodyPath(key));
            await writeMeta(key, meta);
          } catch (error) {
            log(`cache: storing ${url}: ${error.code ?? error.message}`);
            await unlink(path).catch(() => {});
            release();
            await remove(key);
            return false;
          }
          release();
          add(key, size, at);
          makeRoom(0);
          return true;
        },
      };
    },
  };
}
