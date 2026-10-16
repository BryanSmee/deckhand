// The egress proxy's cache of plain HTTP answers, for the hosts the operator lists in
// `cached_hosts` (the listener says which, ../listener/egress.mjs): package mirrors and
// downloads that every run fetches again otherwise. Shared by every sandbox, so only what
// is the same for anyone is kept: a GET without credentials, answered 200 for everyone.
//
// On disk, one entry per URL (and Accept-Encoding): `<sha256>.body` and its metadata,
// `<sha256>.json` (status, headers, stored at, last used, size). Each file is written to a
// temporary one and renamed into place, so an interrupted download leaves nothing behind.
// Over `max` bytes in all, the least recently used entries go. No dependencies.
import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

// How a request uses the cache: "skip" (forwarded as before: not a GET, credentials, a
// range, no-store), "revalidate" (the client wants it checked: no-cache, max-age=0) or "use".
export function requestUse(req) {
  const h = req.headers;
  if (req.method !== "GET" || h.authorization || h.cookie || h.range) return "skip";
  const cc = directives(h["cache-control"]);
  if (cc.has("no-store")) return "skip";
  if (cc.has("no-cache") || cc.get("max-age") === "0" || /no-cache/i.test(h.pragma ?? "")) {
    return "revalidate";
  }
  return "use";
}

// Whether the client asked only for a change: its If-None-Match / If-Modified-Since.
export const conditional = (req) =>
  "if-none-match" in req.headers || "if-modified-since" in req.headers;

// Whether an answer may be kept for everyone: a 200 that isn't private, sets no cookie and
// varies on nothing but Accept-Encoding (which is part of the key), within `entryMax`.
export function storable(status, headers, entryMax) {
  if (status !== 200 || headers["set-cookie"]) return false;
  const cc = directives(headers["cache-control"]);
  if (cc.has("private") || cc.has("no-store")) return false;
  const vary = [...directives(headers.vary).keys()];
  if (vary.some((v) => v !== "accept-encoding")) return false;
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
  const enabled = max > 0 && !!dir;
  const limit = Math.min(entryMax, max);
  const bodyPath = (key) => join(dir, `${key}.body`);
  const metaPath = (key) => join(dir, `${key}.json`);
  const temp = () => join(dir, `tmp-${randomBytes(8).toString("hex")}`);

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

  async function evict() {
    if (total <= max) return;
    const oldest = [...index].sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [key] of oldest) {
      if (total <= max) break;
      log(`cache: removed ${key}, least recently used`);
      await remove(key);
    }
  }

  async function writeMeta(key, meta) {
    const path = temp();
    await writeFile(path, JSON.stringify(meta));
    await rename(path, metaPath(key));
  }

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
    get size() {
      return total;
    },
    has: (key) => index.has(key),

    key(url, acceptEncoding) {
      const encoding = String(acceptEncoding ?? "")
        .toLowerCase()
        .replace(/\s+/g, "");
      return createHash("sha256").update(`${encoding}\n${url}`).digest("hex");
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

    // A new entry, written as its body comes: write() each chunk (false once over the limit:
    // dropped), then commit() once complete (`expected`: its Content-Length, checked), or
    // abort().
    writer(key, { url, status, headers }) {
      const path = temp();
      const stream = createWriteStream(path, { flags: "wx" });
      let size = 0;
      let done = false;
      const closed = new Promise((resolve) => stream.on("close", resolve));
      stream.on("error", () => abort());
      function abort() {
        if (done) return;
        done = true;
        stream.destroy();
        closed.then(() => unlink(path).catch(() => {}));
      }
      return {
        write(chunk) {
          if (done) return false;
          size += chunk.length;
          if (size > limit) {
            abort();
            return false;
          }
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
            await remove(key);
            return false;
          }
          add(key, size, at);
          await evict();
          return true;
        },
      };
    },
  };
}
