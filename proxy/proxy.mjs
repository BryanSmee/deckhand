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
// The hosts the listener says may be cached go through a cache on disk (cached.mjs, cache.mjs):
// their plain HTTP, and their HTTPS, which the proxy decrypts with a certificate from
// Deckhand's CA (authority.mjs), that sandboxes trust, then sends on over TLS it verifies.
// Everything else, and every CONNECT to another host, is forwarded as is: a raw tunnel.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, isIP } from "node:net";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { pathToFileURL } from "node:url";
import { blockedAddress } from "./addresses.mjs";
import { certifiable, createAuthority } from "./authority.mjs";
import { createCache, DEFAULT_ENTRY_MAX, DEFAULT_MAX, parseSize, requestUse } from "./cache.mjs";
import { createCachedPath } from "./cached.mjs";

// Where they were first: the tests import them from here.
export { blockedAddress, v6Bytes } from "./addresses.mjs";

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

  const cached = cache ? createCachedPath({ cache, send, unreachable, now }) : null;

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
