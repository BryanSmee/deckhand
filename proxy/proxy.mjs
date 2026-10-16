// Deckhand's egress proxy: the only way out of the sandboxes' network, which is internal (no
// route out). It handles HTTP CONNECT (HTTPS and anything tunnelled) and plain HTTP requests,
// and for each one asks the listener whether the sandbox at that source address may reach
// that host (POLICY_URL, ../listener/egress.mjs decides). Anything else, or a listener that
// doesn't answer, is refused. No dependencies: node:http, node:net, node:dns.
//
// The proxy resolves the name itself and connects to the address it checked, so a name
// can't be pointed at the host or the cloud's metadata service once allowed: loopback,
// link-local and unspecified addresses are always refused, private ones unless the operator
// allowed the host by name or domain (not only through "*").
//
// The hosts the listener says may be cached go through a cache on disk (cache.mjs): their
// plain HTTP, and their HTTPS, which the proxy decrypts with a certificate from Deckhand's
// CA (authority.mjs), that sandboxes trust, then sends on over TLS it verifies. Everything
// else, and every CONNECT to another host, is forwarded as is: a raw tunnel.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, isIP } from "node:net";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { pathToFileURL } from "node:url";
import { certifiable, createAuthority } from "./authority.mjs";
import {
  conditional,
  createCache,
  DEFAULT_ENTRY_MAX,
  DEFAULT_MAX,
  fits,
  isFresh,
  notModified,
  parseSize,
  requestUse,
  storable,
} from "./cache.mjs";

function v4(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 ? parts : null;
}

// An IPv6 address as its 16 bytes, whatever way it is written (compressed or not, hex or
// dotted IPv4 tail, zone id); null when it isn't one. Strings can't be compared reliably:
// `::ffff:a9fe:a9fe` is `::ffff:169.254.169.254`.
export function v6Bytes(address) {
  const ip = address.replace(/%.*$/, "");
  if (isIP(ip) !== 6) return null;
  const [head, tail] = ip.split("::");
  const groups = (part) => (part ? part.split(":") : []);
  const words = (list) =>
    list.flatMap((group) => {
      if (!group.includes(".")) return [parseInt(group, 16)];
      const [a, b, c, d] = v4(group);
      return [(a << 8) | b, (c << 8) | d];
    });
  const before = words(groups(head));
  const after = words(groups(tail));
  const all =
    tail === undefined
      ? before
      : [...before, ...Array(8 - before.length - after.length).fill(0), ...after];
  return all.flatMap((word) => [word >> 8, word & 0xff]);
}

// The IPv4 address an IPv6 one stands for: IPv4-mapped (`::ffff:0:0/96`), IPv4-translated
// (`::ffff:0:0:0/96`), IPv4-compatible (`::/96`, so `::` and `::1` too), NAT64
// (`64:ff9b::/96`) and 6to4 (`2002::/16`, the address in its next 4 bytes), which all reach
// that IPv4 address through a translator or relay; null otherwise.
function embeddedV4(bytes) {
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6).join(".");
  const prefix = bytes.slice(0, 12).join(",");
  const mapped = "0,0,0,0,0,0,0,0,0,0,255,255";
  const translated = "0,0,0,0,0,0,0,0,255,255,0,0";
  const compatible = "0,0,0,0,0,0,0,0,0,0,0,0";
  const nat64 = "0,100,255,155,0,0,0,0,0,0,0,0";
  return [mapped, translated, compatible, nat64].includes(prefix)
    ? bytes.slice(12).join(".")
    : null;
}

// Whether the proxy refuses to connect to `address`. `privateOk`: the operator allowed the
// host by name, so a LAN or Docker address is what they meant.
export function blockedAddress(address, privateOk) {
  let ip = address.toLowerCase();
  const bytes = v6Bytes(ip);
  if (bytes) ip = embeddedV4(bytes) ?? ip;
  if (isIP(ip) === 4) {
    const [a, b] = v4(ip);
    if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return true;
    // Benchmarking (198.18/15): no one's address on the internet.
    if (a === 198 && (b === 18 || b === 19)) return true;
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b < 128);
    return isPrivate && !privateOk;
  }
  if (bytes) {
    const [a, b] = bytes;
    // Multicast, link-local (fe80::/10) and the deprecated site-local (fec0::/10).
    if (a === 0xff || (a === 0xfe && b >= 0x80)) return true;
    // Unique local (fc00::/7), and NAT64's local-use prefix (64:ff9b:1::/48), which a
    // network's own translator maps to IPv4 addresses we can't see.
    const isPrivate = (a & 0xfe) === 0xfc || bytes.slice(0, 6).join(",") === "0,100,255,155,0,1";
    return isPrivate && !privateOk;
  }
  return true;
}

// "host:443", "[::1]:443" → { host, port }; null when it isn't one.
export function target(authority) {
  const match = /^(?:\[([0-9a-f:.]+)\]|([^:\[\]]+)):(\d{1,5})$/i.exec(authority ?? "");
  const port = Number(match?.[3]);
  if (!match || port < 1 || port > 65535) return null;
  return { host: (match[1] ?? match[2]).toLowerCase().replace(/\.$/, ""), port };
}

// Asks the listener: { allowed, private, cache, decrypt }. Fails closed: no `decrypt`, a
// tunnel.
export function listenerPolicy(url, timeoutMs = 5000) {
  return async (ip, host) => {
    try {
      const query = new URLSearchParams({ ip, host });
      const res = await fetch(`${url}?${query}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { allowed: false };
      const answer = await res.json();
      return {
        allowed: answer.allowed === true,
        private: answer.private === true,
        cache: answer.cache === true,
        decrypt: answer.decrypt === true,
      };
    } catch {
      return { allowed: false };
    }
  };
}

class Refused extends Error {}

// The first bytes a socket receives, read off it (null when it closes first).
function firstChunk(socket) {
  return new Promise((resolve) => {
    const done = (chunk) => {
      socket.off("readable", readable);
      socket.off("close", closed);
      resolve(chunk);
    };
    const readable = () => {
      const chunk = socket.read();
      if (chunk) done(chunk);
    };
    const closed = () => done(null);
    socket.on("readable", readable);
    socket.on("close", closed);
  });
}

export function createProxy({
  policy, // (client ip, host) → { allowed, private, cache, decrypt }
  lookup = (host) => dnsLookup(host, { all: true }),
  blocked = blockedAddress,
  cache = null, // createCache()'s, or none
  authority = null, // createAuthority()'s, ready: HTTPS to cached hosts is decrypted
  upstreamCa, // what verifies the hosts' certificates; default: Node's trust store
  now = Date.now,
  log = () => {},
}) {
  // { address to connect to, whether its answers may be cached, and its HTTPS decrypted to do
  // so }, or a Refused saying why not.
  async function decide(client, host) {
    const ip = client.replace(/^::ffff:/, "");
    const { allowed, private: privateOk, cache: cacheOk, decrypt } = await policy(ip, host);
    if (!allowed) {
      log(`refused ${host} for ${ip}`);
      throw new Refused(
        `Deckhand's egress proxy refused ${host}: it is not among the hosts this sandbox may reach. ` +
          "The operator adds it to `hosts` in their grants folder: grants/<owner>/<repo>.yaml for one repository, grants/default.yaml for all.",
      );
    }
    let addresses;
    try {
      addresses = isIP(host) ? [{ address: host }] : await lookup(host);
    } catch {
      throw new Refused(`Deckhand's egress proxy could not resolve ${host}`, { cause: 502 });
    }
    const usable = addresses.find((a) => !blocked(a.address, privateOk));
    if (!usable) {
      log(`refused ${host} for ${ip}: private address`);
      throw new Refused(
        `Deckhand's egress proxy refused ${host}: it resolves to a private address`,
      );
    }
    return { address: usable.address, cache: cacheOk === true, decrypt: decrypt === true };
  }

  function refuse(socket, error) {
    const status = error.cause === 502 ? "502 Bad Gateway" : "403 Forbidden";
    const text = error instanceof Refused ? error.message : "Deckhand's egress proxy failed";
    socket.end(
      `HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${text}\n`,
    );
  }

  // CONNECT host:port: a raw tunnel once allowed, or, to a host whose answers may be cached,
  // TLS ended here (intercept()).
  async function tunnel(req, client, head) {
    client.on("error", () => {});
    const to = target(req.url);
    if (!to) return refuse(client, new Refused("expected CONNECT host:port"));
    let decision;
    try {
      decision = await decide(req.socket.remoteAddress, to.host);
    } catch (error) {
      return refuse(client, error);
    }
    if (decision.cache && decision.decrypt && cache?.enabled && authority && certifiable(to.host)) {
      return intercept(client, head, to, decision.address);
    }
    pipe(client, head, to, decision.address, false);
  }

  // Bytes both ways, unread. `answered`: the client already got its 200.
  function pipe(client, head, to, address, answered) {
    let connected = false;
    const upstream = connect(to.port, address, () => {
      connected = true;
      if (!answered) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      if (connected || answered) return client.destroy();
      const why = `Deckhand's egress proxy could not reach ${to.host}:${to.port}`;
      refuse(client, new Refused(why, { cause: 502 }));
    });
    client.on("close", () => upstream.destroy());
  }

  // The tunnel's TLS ends here, with a certificate for the host from Deckhand's CA: its
  // requests go through the cache like plain HTTP (relay()), and on to the host over TLS
  // that is verified (send()). A client that doesn't start with TLS, or a host the CA can't
  // make a certificate for, gets the raw tunnel.
  async function intercept(client, head, to, address) {
    let context;
    try {
      context = await contextFor(to.host);
    } catch (error) {
      log(`no certificate for ${to.host}, tunnelled: ${error.message}`);
      return pipe(client, head, to, address, false);
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const first = head?.length ? head : await firstChunk(client);
    if (!first) return client.destroy();
    // A TLS record starts with 22, a handshake.
    if (first[0] !== 22) return pipe(client, first, to, address, true);
    // What was read already is handed back: the TLS socket reads it first.
    client.unshift(first);
    const tls = new TLSSocket(client, {
      isServer: true,
      secureContext: context,
      ALPNProtocols: ["http/1.1"],
    });
    tls.on("error", (error) => {
      log(`TLS with the client for ${to.host}: ${error.code ?? error.message}`);
      tls.destroy();
    });
    tls.deckhand = { to, address };
    inside.emit("connection", tls);
  }

  // One secure context per host, while its certificate lasts.
  const contexts = new Map(); // host → { cert, context }
  async function contextFor(host) {
    const { key, cert } = await authority.certFor(host);
    const known = contexts.get(host);
    if (known?.cert === cert) return known.context;
    const context = createSecureContext({ key, cert });
    contexts.set(host, { cert, context });
    return context;
  }

  // Requests inside an intercepted tunnel: to its host, whatever their Host header says.
  const inside = createServer((req, res) => {
    const { to, address } = req.socket.deckhand;
    if (!req.url.startsWith("/")) {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("Deckhand's egress proxy: expected a path\n");
    }
    const name = isIP(to.host) === 6 ? `[${to.host}]` : to.host;
    const url = new URL(`https://${name}:${to.port}${req.url}`);
    relay(req, res, { address, url, host: to.host }, true);
  });

  // Plain HTTP: the request line holds the absolute URL. The CA's certificate, the
  // listener's to hand to sandboxes, at /deckhand-ca.crt.
  async function forward(req, res) {
    if (req.url === "/deckhand-ca.crt") {
      const pem = authority?.certificate();
      res.writeHead(pem ? 200 : 404, {
        "content-type": pem ? "application/x-pem-file" : "text/plain",
      });
      return res.end(pem ?? "Deckhand's egress proxy has no CA: its cache is off\n");
    }
    let url;
    try {
      url = new URL(req.url);
    } catch {
      url = null;
    }
    if (url?.protocol !== "http:") {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("Deckhand's egress proxy: expected an http:// URL or CONNECT\n");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    let decision;
    try {
      decision = await decide(req.socket.remoteAddress, host);
    } catch (error) {
      res.writeHead(error.cause === 502 ? 502 : 403, { "content-type": "text/plain" });
      return res.end(`${error instanceof Refused ? error.message : "refused"}\n`);
    }
    relay(req, res, { address: decision.address, url, host }, decision.cache);
  }

  // A request on to its host: through the cache when the host's answers may be kept and the
  // request may use it, else as is.
  function relay(req, res, { address, url, host }, cacheOk) {
    const headers = { ...req.headers, host: url.host };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("proxy-")) delete headers[name];
    }
    const to = { address, url, host, headers };
    const use = cache?.enabled && cacheOk ? requestUse(req) : "skip";
    if (use !== "skip") return cached(req, res, to, use);
    const upstream = send(to, req.method, headers, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", (error) => unreachable(res, host, error));
    req.pipe(upstream);
  }

  // HTTPS goes on over TLS verified against the trust store (`upstreamCa` in the tests): a
  // certificate that doesn't verify fails the request, rather than reaching the client
  // under Deckhand's CA.
  function send({ address, url, host }, method, headers, onAnswer) {
    const options = {
      host: address,
      method,
      path: url.pathname + url.search,
      headers,
      setHost: false,
    };
    if (url.protocol !== "https:")
      return httpRequest({ ...options, port: url.port || 80 }, onAnswer);
    return httpsRequest(
      {
        ...options,
        port: url.port || 443,
        // The name the certificate must have; an address is checked as one.
        servername: isIP(host) ? undefined : host,
        ca: upstreamCa,
      },
      onAnswer,
    );
  }

  function unreachable(res, host, error) {
    const why = error?.code?.startsWith("ERR_TLS") || /CERT|SIGNATURE/.test(error?.code ?? "");
    if (why) log(`refused ${host}'s certificate: ${error.code}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(
      why
        ? `Deckhand's egress proxy refused ${host}'s certificate (${error.code})\n`
        : `Deckhand's egress proxy could not reach ${host}\n`,
    );
  }

  // A GET on a cached host: from disk when fresh, revalidated when stale (a 304 serves it),
  // else downloaded, streamed to the client and stored as it comes when it may be.
  async function cached(req, res, to, use) {
    const key = cache.key(to.url.href, req.headers["accept-encoding"], req.headers.accept);
    let entry = await cache.get(key);
    // Kept for requests without the headers it varies on: one sending them goes on as is.
    if (entry && !fits(req, entry.meta.headers)) {
      await entry.file.close();
      return passThrough(req, res, to);
    }
    if (entry && use === "use" && isFresh(entry.meta, now()))
      return serve(req, res, key, entry, "hit");
    // A client checking its own copy, with nothing here to check it against: as before.
    if (!entry && conditional(req)) return passThrough(req, res, to);
    const headers = { ...to.headers };
    for (const name of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since"]) {
      delete headers[name];
    }
    if (entry?.meta.headers.etag) headers["if-none-match"] = entry.meta.headers.etag;
    if (entry?.meta.headers["last-modified"]) {
      headers["if-modified-since"] = entry.meta.headers["last-modified"];
    }
    const upstream = send(to, "GET", headers, async (answer) => {
      if (entry && answer.statusCode === 304) {
        answer.resume();
        const meta = await cache.refresh(key, entry.meta, answer.headers);
        return serve(req, res, key, { ...entry, meta }, "revalidated");
      }
      await entry?.file.close();
      entry = null;
      const keep = storable(answer.statusCode, answer.headers, cache.limit, req);
      // What was kept is no longer what the host answers.
      if (!keep && cache.has(key)) cache.remove(key);
      const writer = keep
        ? cache.writer(key, {
            url: to.url.href,
            status: answer.statusCode,
            headers: answer.headers,
          })
        : null;
      res.writeHead(answer.statusCode, { ...answer.headers, "x-deckhand-cache": "miss" });
      let ended = false;
      answer.on("data", (chunk) => writer?.write(chunk));
      answer.on("end", () => {
        ended = true;
        writer?.commit(answer.headers["content-length"]);
      });
      answer.on("error", () => writer?.abort());
      // A client gone mid-download: the rest isn't fetched, nothing is kept.
      res.on("close", () => {
        if (ended) return;
        writer?.abort();
        answer.destroy();
      });
      answer.pipe(res);
    });
    upstream.on("error", async (error) => {
      await entry?.file.close();
      unreachable(res, to.host, error);
    });
    upstream.end();
  }

  function passThrough(req, res, to) {
    const upstream = send(to, req.method, to.headers, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", (error) => unreachable(res, to.host, error));
    upstream.end();
  }

  // A kept answer, or a 304 when it matches the client's own validators.
  function serve(req, res, key, { meta, file }, how) {
    cache.touch(key, meta);
    const headers = { ...meta.headers, "x-deckhand-cache": how };
    if (notModified(req, meta.headers)) {
      file.close();
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(meta.status, { ...headers, "content-length": meta.size });
    const body = file.createReadStream();
    body.on("error", () => res.destroy());
    body.pipe(res);
  }

  const server = createServer(forward);
  server.on("connect", (req, client, head) => {
    tunnel(req, client, head).catch(() => client.destroy());
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.POLICY_URL || "http://listener:8081/egress";
  const port = Number(process.env.PORT ?? 3128);
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  const dir = process.env.EGRESS_CACHE_DIR || "/cache";
  const cache = createCache({
    dir,
    max: parseSize(process.env.EGRESS_CACHE_MAX, DEFAULT_MAX),
    entryMax: parseSize(process.env.EGRESS_CACHE_ENTRY_MAX, DEFAULT_ENTRY_MAX),
    log,
  });
  // The CA lives next to the cache, in the proxy's volume, and only with the cache on.
  let authority = null;
  if (cache.enabled) {
    authority = createAuthority({ dir: join(dir, "ca"), log });
    try {
      await authority.ready();
    } catch (error) {
      log(`HTTPS isn't cached: no CA (${error.message})`);
      authority = null;
    }
  }
  const https = authority ? ", HTTPS too" : "";
  createProxy({ policy: listenerPolicy(url), cache, authority, log }).listen(port, () =>
    log(`Egress proxy on :${port}, asking ${url}; cache ${cache.enabled ? `on${https}` : "off"}`),
  );
}
