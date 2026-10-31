// Deckhand's egress proxy: the only way out of the sandboxes' network, which is internal (no
// route out). It handles HTTP CONNECT (HTTPS and anything tunnelled) and plain HTTP requests,
// and for each one asks the listener whether the sandbox at that source address may reach
// that host (POLICY_URL, ../listener/egress.mjs decides). Anything else, or a listener that
// doesn't answer, is refused. No dependencies: node:http, node:net, node:dns.
//
// The proxy resolves the name itself and connects to the address it checked, so a name
// can't be pointed at the host or the cloud's metadata service once allowed: loopback,
// link-local and unspecified addresses are always refused, private ones and those of the
// networks the proxy is on (another run's sandbox or engine, the listener: public ones too,
// when Docker's ranges are) unless the operator allowed the host by name or domain (not only
// through "*").
//
// The hosts the listener says may be cached go through a cache on disk (cached.mjs, cache.mjs):
// their plain HTTP, and their HTTPS, which the proxy decrypts with a certificate from
// Deckhand's CA (authority.mjs), that sandboxes trust, then sends on over TLS it verifies.
// The hosts the listener says to relay (GitHub's, whose calls carry the run token in place of
// a token, ../listener/github-gateway.mjs, and an agent's, in place of the operator's
// credential, ../listener/google.mjs) are decrypted the same way, whether the cache is on or
// not, and each request goes to the listener (RELAY_URL) instead of the host, with the address
// of the sandbox it came from (CLIENT_HEADER). Plain HTTP to the listener's broker (BROKER_URL:
// the agents' APIs, pushes, the run's files) goes to it the same way, for whom the policy allows it.
// Everything else, and every CONNECT to another host, is forwarded as is: a raw tunnel.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, createSecureContext, TLSSocket } from "node:tls";
import { pathToFileURL } from "node:url";
import { blockedAddress, inSubnets, ownSubnets } from "./addresses.mjs";
import { certifiable, createAuthority } from "./authority.mjs";
import { createCache, DEFAULT_ENTRY_MAX, DEFAULT_MAX, parseSize, requestUse } from "./cache.mjs";
import { createCachedPath } from "./cached.mjs";
import { drain, drainable, drainOnSigterm } from "../lib/drain.mjs";
import { untilReached } from "./wait.mjs";

// Where they were first: the tests import them from here.
export { blockedAddress, v6Bytes } from "./addresses.mjs";

// How long a stopping proxy lets its open connections finish (DRAIN_SECONDS): 25 s where it is
// the only copy, which Docker Compose stops before it starts the next, so that sandboxes'
// connections aren't refused long; as long as an agent call (10 minutes) where a second copy
// takes the new ones meanwhile, a Kubernetes rolling update (docs/services.md, The proxy's
// handover).
const DRAIN_MS = 25_000;

// DRAIN_SECONDS → milliseconds; DRAIN_MS when unset, an error when it isn't a whole number.
export function drainMs(text) {
  if (text === undefined || text === "") return DRAIN_MS;
  if (!/^\d+$/.test(text)) throw new Error(`DRAIN_SECONDS: expected seconds, got ${text}`);
  return Number(text) * 1000;
}

// The header that names, on a relayed request, the sandbox it came from: the listener binds a
// run's token to its sandbox (../listener/broker-http.mjs, which believes it from
// the proxy alone). Whatever the client sent in it is replaced.
export const CLIENT_HEADER = "x-deckhand-client";

// "host:443", "[::1]:443" → { host, port }; null when it isn't one.
export function target(authority) {
  const match = /^(?:\[([0-9a-f:.]+)\]|([^:\[\]]+)):(\d{1,5})$/i.exec(authority ?? "");
  const port = Number(match?.[3]);
  if (!match || port < 1 || port > 65535) return null;
  return { host: (match[1] ?? match[2]).toLowerCase().replace(/\.$/, ""), port };
}

// Asks the listener: { allowed, private, cache, decrypt, relay }. Fails closed: no `decrypt`,
// a tunnel. A listener restarting is waited for (wait.mjs; `wait`: its clock, in the tests),
// unless the client left (`gone()`). `broker`: the host is the broker's, whose calls the proxy
// forwards (BROKER_URL): the listener allows them for its runs' sandboxes and engines only.
export function listenerPolicy(url, timeoutMs = 5000, wait = {}) {
  return async (ip, host, { gone, broker } = {}) => {
    try {
      const query = new URLSearchParams({ ip, host, ...(broker && { broker: "1" }) });
      const res = await untilReached(
        () => fetch(`${url}?${query}`, { signal: AbortSignal.timeout(timeoutMs) }),
        { ...wait, ...(gone && { gone }) },
      );
      if (!res.ok) return { allowed: false };
      const answer = await res.json();
      return {
        allowed: answer.allowed === true,
        private: answer.private === true,
        cache: answer.cache === true,
        decrypt: answer.decrypt === true,
        relay: answer.relay === true,
      };
    } catch {
      return { allowed: false };
    }
  };
}

// A dot segment ("." or "..", plain or percent-encoded), which the URL parser would resolve.
// Dots elsewhere are a path's own: GitHub's compare (`main...feature`), a search's date range
// in the query (`2026-01-01..2026-02-01`), a file named `a%2Ejs`.
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;

// Where a relayed request goes: <relayUrl>/<host><path>, or null for a path that isn't plain
// origin-form ("/…") or that could climb out of <relayUrl>/<host>/ once parsed (a dot segment
// or a "\\" in its path), and checked again on the parsed URL.
export function relayTarget(relayUrl, host, path) {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const pathname = path.split("?")[0];
  if (DOT_SEGMENT.test(pathname) || pathname.includes("\\")) return null;
  let url;
  try {
    url = new URL(`${relayUrl}/${host}${path}`);
  } catch {
    return null;
  }
  const base = new URL(`${relayUrl}/${host}/`);
  return url.origin === base.origin && url.pathname.startsWith(base.pathname) ? url : null;
}

// Where relayed requests go without RELAY_URL: the broker's /relay, on POLICY_URL's host.
export function defaultRelayUrl(policyUrl) {
  const relay = new URL("/relay", policyUrl);
  if (relay.port === "8082") relay.port = "8081";
  return relay.href;
}

// Where the sandboxes' calls to the broker go without BROKER_URL: RELAY_URL's origin.
export function defaultBrokerUrl(relayUrl) {
  return new URL(relayUrl).origin;
}

// Whether a call to the broker is its egress policy's, which the broker answers the proxy alone:
// forwarded, it would be asked on the sandbox's behalf. `pathname`: the parsed URL's, its dot
// segments resolved.
export function policyPath(pathname) {
  return /^\/egress(?:[/?]|$)/i.test(pathname);
}

class Refused extends Error {}

// The most a CONNECT's client may send before its answer (a ClientHello sent early).
export const EARLY_MAX = 16 * 1024;

// A connection to `url`'s host, once made (over TLS for https:, verified against `ca`).
function dial(url, ca) {
  return new Promise((resolve, reject) => {
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const socket =
      url.protocol === "https:"
        ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host, ca })
        : connect(port, host);
    socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

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
  policy, // (client ip, host) → { allowed, private, cache, decrypt, relay }
  lookup = (host) => dnsLookup(host, { all: true }),
  blocked = blockedAddress,
  // The subnets of the networks it is on, read at each connection: the listener attaches it to
  // each run's network as the run starts.
  subnets = () => ownSubnets(networkInterfaces()),
  cache = null, // createCache()'s, or none
  authority = null, // createAuthority()'s, ready: HTTPS to cached and relayed hosts is decrypted
  relayUrl = null, // where relayed requests go: <relayUrl>/<host><path>
  brokerUrl = null, // the broker, as sandboxes call it: its plain HTTP is forwarded to it
  upstreamCa, // what verifies the hosts' certificates, and an https: relayUrl's; default: Node's trust store
  // How relayed requests wait for a listener restarting (wait.mjs): { limitMs, now, sleep }.
  wait = {},
  now = Date.now,
  log = () => {},
}) {
  // { address to connect to, whether its answers may be cached, and its HTTPS decrypted to do
  // so, or relayed }, or a Refused saying why not.
  async function decide(client, host, gone) {
    const ip = client.replace(/^::ffff:/, "");
    const {
      allowed,
      private: privateOk,
      cache: cacheOk,
      decrypt,
      relay,
    } = await policy(ip, host, { gone });
    if (!allowed) {
      log(`refused ${host} for ${ip}`);
      throw new Refused(
        `Deckhand's egress proxy refused ${host}: it is not among the hosts this sandbox may reach. ` +
          "The operator adds it to `hosts` in their grants folder: grants/<owner>/<repo>.yaml for one repository, grants/default.yaml for all.",
      );
    }
    // Relayed: its requests go to the listener, never to the host's address.
    if (relay === true) return { address: null, cache: false, decrypt: true, relay: true };
    let addresses;
    try {
      addresses = isIP(host) ? [{ address: host }] : await lookup(host);
    } catch {
      throw new Refused(`Deckhand's egress proxy could not resolve ${host}`, { cause: 502 });
    }
    const own = privateOk ? [] : subnets();
    const usable = addresses.find(
      (a) => !blocked(a.address, privateOk) && !inSubnets(a.address, own),
    );
    if (!usable) {
      log(`refused ${host} for ${ip}: private address`);
      throw new Refused(
        `Deckhand's egress proxy refused ${host}: it resolves to a private address`,
      );
    }
    return {
      address: usable.address,
      cache: cacheOk === true,
      decrypt: decrypt === true,
      relay: relay === true,
    };
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
    // Read while the policy is asked, so that a client that hangs up is seen (a socket nobody
    // reads never hears its end), and stops the wait for a restarting listener. What it sent
    // meanwhile goes on with `head`.
    const early = [head];
    let kept = head?.length ?? 0;
    const keep = (chunk) => {
      early.push(chunk);
      kept += chunk.length;
      // More than a TLS ClientHello before the 200: no client waits for an answer that way, and
      // the proxy, every run's, keeps none of it.
      if (kept > EARLY_MAX) client.destroy();
    };
    client.on("data", keep);
    const gone = () => client.readableEnded || client.destroyed;
    let decision;
    try {
      decision = await decide(req.socket.remoteAddress, to.host, gone);
    } catch (error) {
      return refuse(client, error);
    } finally {
      client.off("data", keep);
      client.pause();
    }
    if (gone()) return client.destroy();
    head = Buffer.concat(early.filter(Boolean));
    // Never a tunnel: the sandbox's calls would reach the host with the run's token alone.
    if (decision.relay) {
      if (authority && relayUrl && certifiable(to.host)) {
        return intercept(client, head, to, decision.address, req.socket.remoteAddress, true);
      }
      log(`refused ${to.host}: no CA or RELAY_URL to relay it`);
      return refuse(
        client,
        new Refused(`Deckhand's egress proxy can't relay ${to.host}: it has no CA`),
      );
    }
    if (decision.cache && decision.decrypt && cache?.enabled && authority && certifiable(to.host)) {
      return intercept(client, head, to, decision.address, req.socket.remoteAddress);
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
  // that is verified (send()), or to the listener when `relay`. A client that doesn't start
  // with TLS, or a host the CA can't make a certificate for, gets the raw tunnel; never a
  // relayed host. `from`: the client's address, which a relayed request names.
  async function intercept(client, head, to, address, from, relay = false) {
    let context;
    try {
      context = await contextFor(to.host);
    } catch (error) {
      log(`no certificate for ${to.host}${relay ? "" : ", tunnelled"}: ${error.message}`);
      if (relay)
        return refuse(client, new Refused(`Deckhand's egress proxy can't relay ${to.host}`));
      return pipe(client, head, to, address, false);
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const first = head?.length ? head : await firstChunk(client);
    if (!first) return client.destroy();
    // A TLS record starts with 22, a handshake.
    if (first[0] !== 22) return relay ? client.destroy() : pipe(client, first, to, address, true);
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
    tls.deckhand = { to, address, relay, from, busy: 0 };
    decrypted.add(tls);
    tls.on("close", () => decrypted.delete(tls));
    inside.emit("connection", tls);
  }

  // The decrypted tunnels' connections, each with its requests in flight (`busy`): a drain
  // closes them once idle, as Node does for the proxy's own.
  const decrypted = new Set();
  let draining = false;
  function closeIdle() {
    for (const tls of decrypted) if (!tls.deckhand.busy) tls.end();
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
  const inside = drainable(
    createServer((req, res) => {
      const { to, address, relay: toListener, from } = req.socket.deckhand;
      req.socket.deckhand.busy++;
      res.on("close", () => {
        req.socket.deckhand.busy--;
        if (draining) closeIdle();
      });
      if (!req.url.startsWith("/")) {
        res.writeHead(400, { "content-type": "text/plain" });
        return res.end("Deckhand's egress proxy: expected a path\n");
      }
      if (toListener) return relayed(req, res, to.host, from).catch(() => res.destroy());
      const name = isIP(to.host) === 6 ? `[${to.host}]` : to.host;
      const url = new URL(`https://${name}:${to.port}${req.url}`);
      relay(req, res, { address, url, host: to.host }, true);
    }),
  );

  const broker = brokerUrl ? new URL(brokerUrl).origin : null;

  // Plain HTTP: the request line holds the absolute URL. The CA's certificate, the
  // listener's to hand to sandboxes, at /deckhand-ca.crt; /ready, for a readiness probe: a
  // draining proxy takes no new connection, so it doesn't answer it.
  async function forward(req, res) {
    if (req.url === "/ready") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ready\n");
    }
    if (req.url === "/deckhand-ca.crt") {
      // Made again when near its end: each run asks for it.
      const pem = authority
        ? await authority.ready().then(
            () => authority.certificate(),
            () => null,
          )
        : null;
      res.writeHead(pem ? 200 : 404, {
        "content-type": pem ? "application/x-pem-file" : "text/plain",
      });
      return res.end(pem ?? "Deckhand's egress proxy has no CA\n");
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
    if (url.origin === broker) return toBroker(req, res, url).catch(() => res.destroy());
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    let decision;
    try {
      decision = await decide(
        req.socket.remoteAddress,
        host,
        () => req.socket.readableEnded || req.socket.destroyed,
      );
    } catch (error) {
      res.writeHead(error.cause === 502 ? 502 : 403, { "content-type": "text/plain" });
      return res.end(`${error instanceof Refused ? error.message : "refused"}\n`);
    }
    // A relayed host has no address to go to: its calls are the listener's, over HTTPS only.
    if (decision.relay) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end(`Deckhand's egress proxy relays ${host} over HTTPS only\n`);
    }
    relay(req, res, { address: decision.address, url, host }, decision.cache);
  }

  // A sandbox's call to the broker (#511): on to it, naming the sandbox, whose network the
  // broker binds the run's token to, as for a relayed request. Only for whom the listener says may (its runs'
  // sandboxes and engines, not a build or an install), and never its policy's path: the broker
  // would take the question for the proxy's own. `url`: parsed, its dot segments resolved.
  async function toBroker(req, res, url) {
    const forbid = (why) => {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`Deckhand's egress proxy: ${why}\n`);
    };
    // Its path and query set on a copy of the broker's URL, never parsed again: "//host/x" would
    // read as another host's URL. No credentials in the URL become a header either.
    const to = new URL(broker);
    to.pathname = url.pathname;
    to.search = url.search;
    if (to.origin !== broker || policyPath(to.pathname)) {
      return forbid("the broker answers that to the proxy alone");
    }
    const from = req.socket.remoteAddress;
    const { allowed } = await policy(from.replace(/^::ffff:/, ""), to.hostname, {
      gone: () => req.socket.readableEnded || req.socket.destroyed,
      broker: true,
    });
    if (req.socket.destroyed) return;
    if (!allowed) return forbid("only a running sandbox reaches the listener's broker");
    return toListener(req, res, to, from);
  }

  // A relayed host's request, to the listener as <relayUrl>/<host><path>: the listener checks
  // the run's token and sends it on with the operator's credential (../listener/google.mjs).
  // Only under <relayUrl>/<host>/: the URL parser resolves "..", so a path that climbs out
  // would reach the listener's other endpoints (/egress) from the proxy's address. `from`: the
  // client's address.
  async function relayed(req, res, host, from) {
    const url = relayTarget(relayUrl, host, req.url);
    if (!url) {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("Deckhand's egress proxy: not a path it relays\n");
    }
    return toListener(req, res, url, from);
  }

  // A request on to the listener at `url`, naming its client (`from`). A listener restarting is
  // waited for: the request is sent once a connection is made, and never again (wait.mjs).
  async function toListener(req, res, url, from) {
    const headers = { ...req.headers, host: url.host };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("proxy-")) delete headers[name];
    }
    headers[CLIENT_HEADER] = String(from ?? "").replace(/^::ffff:/, "");
    // A connection per request, as it can't be pooled: closed once answered.
    headers.connection = "close";
    delete headers["keep-alive"];
    let upstream = null;
    let gone = false;
    res.on("close", () => {
      gone = true;
      if (!res.writableFinished) upstream?.destroy();
    });
    let socket;
    try {
      socket = await untilReached(() => dial(url, upstreamCa), { ...wait, gone: () => gone });
    } catch {
      return unreachable(res, "the listener");
    }
    if (gone) return socket.destroy();
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    upstream = send(
      url,
      { method: req.method, headers, createConnection: () => socket },
      (answer) => {
        // That connection's, not the client's, which stays open for its next request.
        const { connection, "keep-alive": keepAlive, ...rest } = answer.headers;
        res.writeHead(answer.statusCode, rest);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => unreachable(res, "the listener"));
    req.pipe(upstream);
  }

  // A request on to its host: through the cache when the host's answers may be kept and the
  // request may use it, else as is.
  function relay(req, res, { address, url, host }, cacheOk) {
    const headers = { ...req.headers, host: url.host };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("proxy-")) delete headers[name];
    }
    // Only a relayed request names its client: nobody else may pass the name on (should a host
    // the operator names lead back to the listener).
    delete headers[CLIENT_HEADER];
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
  // under Deckhand's CA. A connection per request, never pooled: one sandbox's requests
  // can't leave a host's connection out of step (request smuggling) for another's, whose
  // answer the cache would keep for everyone.
  function send({ address, url, host }, method, headers, onAnswer) {
    const options = {
      host: address,
      method,
      path: url.pathname + url.search,
      headers,
      setHost: false,
      agent: false,
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

  const server = drainable(createServer(forward));
  server.on("connect", (req, client, head) => {
    tunnel(req, client, head).catch(() => client.destroy());
  });
  // On SIGTERM: no new connection, those open finish (tunnels, and requests in decrypted ones)
  // → whether all did within the grace period (../lib/drain.mjs).
  server.drain = (options) => {
    draining = true;
    closeIdle();
    return drain(server, { ...options, also: [inside] });
  };
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // The listener's egress policy. Compose names its own port (8082), which stays open while the
  // broker's drains on a restart; the default stays the broker's, which every listener's
  // Service has, so a deployment that relied on it keeps working (docs/setup.md).
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
  // The CA lives next to the cache, in the proxy's volume, cache on or off: relayed hosts need
  // it too.
  let authority = createAuthority({ dir: join(dir, "ca"), log });
  try {
    await authority.ready();
  } catch (error) {
    log(`HTTPS isn't cached or relayed: no CA (${error.message})`);
    authority = null;
  }
  // The listener's broker, where POLICY_URL is (on 8081 beside the policy's 8082, else POLICY_URL
  // names the broker's port, as before it had its own): relayed requests go to its /relay/.
  const relayUrl = (process.env.RELAY_URL || defaultRelayUrl(url)).replace(/\/$/, "");
  // The broker as sandboxes call it (the listener's BROKER_URL): their plain HTTP to it is
  // forwarded there, and waits for a listener restarting.
  const brokerUrl = process.env.BROKER_URL || defaultBrokerUrl(relayUrl);
  const https = authority ? ", HTTPS too" : "";
  const proxy = createProxy({
    policy: listenerPolicy(url),
    cache,
    authority,
    relayUrl,
    brokerUrl,
    log,
  });
  proxy.listen(port, () =>
    log(`Egress proxy on :${port}, asking ${url}; cache ${cache.enabled ? `on${https}` : "off"}`),
  );
  // On SIGTERM, the requests in flight get DRAIN_SECONDS, then what is still open (long-lived
  // tunnels: a raw one is never known to be idle) is cut. Alone, a short grace, before compose's
  // stop_grace_period (30 s): `docker compose up` starts the next proxy only once this one
  // exited, and nothing in a sandbox tries a refused connection again. Beside a second copy,
  // which takes the new connections, as long as an agent call.
  drainOnSigterm([proxy], { graceMs: drainMs(process.env.DRAIN_SECONDS), log });
}
