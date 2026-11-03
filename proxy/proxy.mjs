// Deckhand's egress proxy: the only way out of the sandboxes' network, which is internal (no
// route out). It handles HTTP CONNECT (HTTPS and anything tunnelled) and plain HTTP requests
// (an absolute-form https:// one too, which some clients send in place of a CONNECT), and for
// each one asks the orchestrator whether the sandbox at that source address may reach
// that host (POLICY_URL, ../listener/egress.mjs decides). Anything else, or an orchestrator that
// doesn't answer, is refused. No dependencies: node:http, node:net, node:dns.
//
// The proxy resolves the name itself and connects to the address it checked, so a name
// can't be pointed at the host or the cloud's metadata service once allowed: loopback,
// link-local and unspecified addresses are always refused, private ones and those of the
// networks the proxy is on (another run's sandbox or engine, the services: public ones too,
// when Docker's ranges are) unless the operator allowed the host by name or domain (not only
// through "*").
//
// The hosts the policy says may be cached go through a cache on disk (cached.mjs, cache.mjs):
// their plain HTTP, and their HTTPS, which the proxy decrypts with a certificate from
// Deckhand's CA (authority.mjs), that sandboxes trust, then sends on over TLS it verifies.
// The hosts the policy says to relay (GitHub's, whose calls carry the run token in place of a
// token, ../listener/github-gateway.mjs, and an agent's, in place of the operator's credential,
// ../models/google.mjs) are decrypted the same way, whether the cache is on or not, and each
// request goes to a service instead of the host: GitHub's to the github service
// (GITHUB_SERVICE_URL, #502), an agent's to the models service (MODELS_SERVICE_URL, #504).
// Plain HTTP to the services' names sandboxes call (../lib/services.mjs SANDBOX_URLS) goes to
// that service, for whom the policy allows it: what a sandbox calls the broker about its own run
// (`/run/…`: its token's renewal, its inbox and files) to the broker service
// (BROKER_SERVICE_URL, ../broker/, #505), its pushes (`/git/…`) to the github service, its
// agents' API calls (`/anthropic/`, `/openai/`, `/google/`) to the models service. Each is
// vouched for with the proxy's own service token: the network (or pod) it came from, as the
// policy said.
// Everything else, and every CONNECT to another host, is forwarded as is: a raw tunnel.
// A second port (ENGINE_PROXY_PORT) is the container engines', where one shares its sandbox's
// address (a Kubernetes pod): the policy is told, and answers as for an engine on Docker.
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
import { egressMetrics } from "./metrics.mjs";
import {
  AGENT_TOKEN_HEADERS,
  agentTokenOf,
  createBrokerCaller,
  RUN_AUTH_HEADER,
  RUN_TOKEN_HEADER,
  SANDBOX_HEADER,
} from "../lib/broker-client.mjs";
import { drain, drainable, drainOnSigterm } from "../lib/drain.mjs";
import { healthAnswer, healthInfo } from "../lib/health.mjs";
import { sendJson } from "../lib/http.mjs";
import { createLogger, REQUEST_HEADER } from "../lib/log.mjs";
import { metricsPort, startMetrics } from "../lib/metrics.mjs";
import { ENGINE_PROXY_PORT, SANDBOX_URLS } from "../lib/services.mjs";
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

// The header that named, on a relayed request, the address of the sandbox it came from: no
// service reads it, and a client's own is dropped.
export const CLIENT_HEADER = "x-deckhand-client";

// What the services read a sandbox's call by (lib/broker-client.mjs), and the request ID their
// lines are logged under (lib/log.mjs): whatever the client sent in them is dropped, so a
// sandbox's call gets an ID of its own at the service, never another webhook's.
const VOUCHED = [CLIENT_HEADER, SANDBOX_HEADER, RUN_TOKEN_HEADER, RUN_AUTH_HEADER, REQUEST_HEADER];

// "host:443", "[::1]:443" → { host, port }; null when it isn't one.
export function target(authority) {
  const match = /^(?:\[([0-9a-f:.]+)\]|([^:\[\]]+)):(\d{1,5})$/i.exec(authority ?? "");
  const port = Number(match?.[3]);
  if (!match || port < 1 || port > 65535) return null;
  return { host: (match[1] ?? match[2]).toLowerCase().replace(/\.$/, ""), port };
}

// Asks the orchestrator: { allowed, private, cache, decrypt, relay, source, reason }. Fails
// closed: no `decrypt`, a tunnel; no answer, refused (`reason` "policy_error"). An orchestrator
// restarting is waited for (wait.mjs; `wait`: its clock, in the tests), unless the client left
// (`gone()`). `forward`: the host is a service's name, whose plain HTTP the proxy forwards
// (SANDBOX_URLS): the policy allows it for the runs' sandboxes and engines only. `engine`: it
// came in on the engines' port (ENGINE_PROXY_PORT), so it is the engine's of the run at that
// address.
export function egressPolicy(url, timeoutMs = 5000, wait = {}) {
  return async (ip, host, { gone, forward, engine } = {}) => {
    try {
      const query = new URLSearchParams({
        ip,
        host,
        ...(forward && { forward: "1" }),
        ...(engine && { engine: "1" }),
      });
      const res = await untilReached(
        () => fetch(`${url}?${query}`, { signal: AbortSignal.timeout(timeoutMs) }),
        { ...wait, ...(gone && { gone }) },
      );
      if (!res.ok) return { allowed: false, reason: "policy_error" };
      const answer = await res.json();
      return {
        allowed: answer.allowed === true,
        private: answer.private === true,
        cache: answer.cache === true,
        decrypt: answer.decrypt === true,
        relay: answer.relay === true,
        // A relayed host whose calls are an agent's: to the models service (#504).
        models: answer.models === true,
        // For a service's name, GitHub's hosts and an agent's relayed one: the network (or pod)
        // of the run's sandbox.
        sandbox: typeof answer.sandbox === "string" && answer.sandbox ? answer.sandbox : null,
        // A relayed host whose calls go to the github service (#502).
        service: answer.service === "github" ? "github" : null,
        // Who asked, and why it was refused, for the metrics (metrics.mjs): strings, which the
        // metrics' declared values bound.
        ...(typeof answer.source === "string" && { source: answer.source }),
        ...(typeof answer.reason === "string" && { reason: answer.reason }),
      };
    } catch {
      return { allowed: false, reason: "policy_error" };
    }
  };
}

// A dot segment ("." or "..", plain or percent-encoded), which the URL parser would resolve.
// Dots elsewhere are a path's own: GitHub's compare (`main...feature`), a search's date range
// in the query (`2026-01-01..2026-02-01`), a file named `a%2Ejs`.
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;

// Where a relayed request goes: <relayUrl>/<host><path> (a service's /relay), or null for a path
// that isn't plain origin-form ("/…") or that could climb out of <relayUrl>/<host>/ once parsed
// (a dot segment or a "\\" in its path), and checked again on the parsed URL.
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

class Refused extends Error {}

// The services' names, as sandboxes call them (SANDBOX_URLS): origin → the service. What each
// takes there (`paths`): the broker, a sandbox's calls about its own run; the github service, its
// pushes; the models service, its agents' API calls. Nothing else: the proxy's own service token
// goes with them.
const FORWARDED = new Map([
  [new URL(SANDBOX_URLS.broker).origin, { name: "broker", paths: /^\/run\// }],
  [new URL(SANDBOX_URLS.github).origin, { name: "github", paths: /^\/git\// }],
  [
    new URL(SANDBOX_URLS.models).origin,
    { name: "models", paths: /^\/(?:anthropic|openai|google)\// },
  ],
]);
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
  // The subnets of the networks it is on, read at each connection: the runner attaches it to
  // each run's network as the run starts.
  subnets = () => ownSubnets(networkInterfaces()),
  cache = null, // createCache()'s, or none
  authority = null, // createAuthority()'s, ready: HTTPS to cached and relayed hosts is decrypted
  // The broker service, where the sandboxes' `/run/…` calls go: { url, header() → the proxy's
  // service token for it } (../lib/broker-client.mjs). None: they are refused.
  brokerService = null,
  // The github service (#502), where GitHub's relayed hosts and the pushes go, the same way.
  githubService = null,
  // The models service, where the agents' calls go (#504), the same way.
  modelsService = null,
  upstreamCa, // what verifies the hosts' certificates, and an https: service's; default: Node's trust store
  // How forwarded requests wait for a service restarting (wait.mjs): { limitMs, now, sleep }.
  wait = {},
  now = Date.now,
  log = () => {},
  // Its connections are a run's container engine's (ENGINE_PROXY_PORT): the policy is told.
  engine = false,
  // What GET /health says: when it started, its version (../lib/health.mjs).
  health = healthInfo(),
  // Its metrics (metrics.mjs egressMetrics()), the same for both ports'.
  metrics = egressMetrics(),
}) {
  const asEngine = engine ? { engine: true } : {};
  // The policy's answer about `socket`'s connection to `host`, timed. Its `source` said always:
  // the engines' port's are an engine's.
  async function ask(socket, host, options) {
    const ip = (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const done = metrics.policyTimer();
    const answer = await policy(ip, host, { ...options, ...asEngine });
    done();
    return { source: engine ? "engine" : "unknown", ...answer, ip };
  }

  // A connection decided, counted (`reason` when refused).
  const counted = (socket, answer, allowed, reason) =>
    metrics.connection(socket, { source: answer.source, allowed, reason });

  // { address to connect to, whether its answers may be cached, and its HTTPS decrypted to do
  // so, or relayed, and who asked (`source`) }, or a Refused saying why not. Its refusals are
  // counted, not what it allows: the caller counts it once it goes on (tunnel(), forward()).
  async function decide(socket, host, gone) {
    const answer = await ask(socket, host, { gone });
    const {
      ip,
      allowed,
      private: privateOk,
      cache: cacheOk,
      decrypt,
      relay,
      service,
      models,
      sandbox,
      source,
    } = answer;
    if (!allowed) {
      log(`refused ${host} for ${ip}`);
      counted(socket, answer, false, answer.reason ?? "not_granted");
      throw new Refused(
        `Deckhand's egress proxy refused ${host}: it is not among the hosts this sandbox may reach. ` +
          "The operator adds it to `hosts` in their grants folder: grants/<owner>/<repo>.yaml for one repository, grants/default.yaml for all.",
      );
    }
    // Relayed: its requests go to the github or the models service, never to the host's
    // address.
    if (relay === true) {
      return {
        address: null,
        cache: false,
        decrypt: true,
        relay: true,
        service,
        models: models === true,
        sandbox: sandbox ?? null,
        source,
      };
    }
    let addresses;
    try {
      addresses = isIP(host) ? [{ address: host }] : await lookup(host);
    } catch {
      counted(socket, answer, false, "unresolved");
      throw new Refused(`Deckhand's egress proxy could not resolve ${host}`, { cause: 502 });
    }
    const own = privateOk ? [] : subnets();
    const usable = addresses.find(
      (a) => !blocked(a.address, privateOk) && !inSubnets(a.address, own),
    );
    if (!usable) {
      log(`refused ${host} for ${ip}: private address`);
      counted(socket, answer, false, "private_address");
      throw new Refused(
        `Deckhand's egress proxy refused ${host}: it resolves to a private address`,
      );
    }
    return {
      address: usable.address,
      cache: cacheOk === true,
      decrypt: decrypt === true,
      relay: relay === true,
      source,
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
    // reads never hears its end), and stops the wait for a restarting orchestrator. What it sent
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
      decision = await decide(client, to.host, gone);
    } catch (error) {
      return refuse(client, error);
    } finally {
      client.off("data", keep);
      client.pause();
    }
    if (gone()) return client.destroy();
    head = Buffer.concat(early.filter(Boolean));
    // Never a tunnel: the sandbox's calls would reach the host with the run's token alone. To
    // the service whose host it is: GitHub's to the github service, an agent's to the models
    // service.
    if (decision.relay) {
      const service = decision.service === "github" ? githubService : null;
      if ((service || (decision.models && modelsService)) && authority && certifiable(to.host)) {
        counted(client, decision, true);
        return intercept(client, head, to, decision.address, decision);
      }
      log(`refused ${to.host}: no CA, or no service to relay it to`);
      counted(client, decision, false, "no_relay");
      return refuse(
        client,
        new Refused(
          `Deckhand's egress proxy can't relay ${to.host}: it has no CA, or no service for it`,
        ),
      );
    }
    if (decision.cache && decision.decrypt && cache?.enabled && authority && certifiable(to.host)) {
      counted(client, decision, true);
      return intercept(client, head, to, decision.address);
    }
    counted(client, decision, true);
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
  // that is verified (send()), or to the github or the models service when `relay`. A client
  // that doesn't start with TLS, or a host the CA can't make a certificate for, gets the raw
  // tunnel; never a relayed host. `relayed`: the policy's decision for a relayed host, null for a
  // cached one.
  async function intercept(client, head, to, address, relayed = null) {
    const relay = !!relayed;
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
    tls.deckhand = {
      to,
      address,
      relay,
      busy: 0,
      // GitHub's: to the github service, with the network the policy vouched for.
      github: relayed?.service === "github",
      // An agent's: to the models service, likewise.
      models: relayed?.models === true,
      sandbox: relayed?.sandbox ?? null,
    };
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
      const { to, address, relay: relayed, github, models, sandbox } = req.socket.deckhand;
      req.socket.deckhand.busy++;
      res.on("close", () => {
        req.socket.deckhand.busy--;
        if (draining) closeIdle();
      });
      if (!req.url.startsWith("/")) {
        res.writeHead(400, { "content-type": "text/plain" });
        return res.end("Deckhand's egress proxy: expected a path\n");
      }
      if (relayed) return toRelayed(req, res, to.host, req.url, { github, models, sandbox });
      const name = isIP(to.host) === 6 ? `[${to.host}]` : to.host;
      const url = new URL(`https://${name}:${to.port}${req.url}`);
      relay(req, res, { address, url, host: to.host }, true);
    }),
  );

  // A relayed host's request (`path`: origin-form): GitHub's to the github service, an agent's to
  // the models service, none else.
  function toRelayed(req, res, host, path, { github, models, sandbox }) {
    const service = github ? githubService : models ? modelsService : null;
    const url = service && relayTarget(`${service.url}/relay`, host, path);
    if (!url) {
      res.writeHead(service ? 400 : 502, { "content-type": "text/plain" });
      return res.end(
        service
          ? "Deckhand's egress proxy: not a path it relays\n"
          : `Deckhand's egress proxy has no service to relay ${host} to\n`,
      );
    }
    const sent = github ? toGithub(req, res, url, sandbox) : toModels(req, res, url, sandbox);
    return sent.catch(() => res.destroy());
  }

  // Plain HTTP: the request line holds the absolute URL. An https:// one too, from clients that
  // send their HTTPS requests that way rather than through a CONNECT (busybox wget, Alpine's,
  // #635): it reached the proxy unencrypted, so the proxy sends it on over TLS it verifies, as
  // the policy says for a CONNECT to that host; cached only where a CONNECT's would be (its
  // HTTPS decrypted: never an engine's). The CA's certificate, the
  // orchestrator's to hand to sandboxes, at /deckhand-ca.crt; /ready, for a readiness probe: 503
  // once draining, on a connection kept alive from before (new ones aren't taken); /health, every
  // service's answer (../lib/health.mjs), for the orchestrator's status page.
  async function forward(req, res) {
    // Only an https:// URL's client may half-close (server.httpAllowHalfOpen, below): any other's
    // end before its answer is the client gone, as Node has it by default, which stops its
    // download (a client gone and one half-closed look the same, until a write fails).
    if (!/^https:/i.test(req.url)) {
      const left = () => req.socket.destroy();
      req.socket.once("end", left);
      res.on("close", () => req.socket.off("end", left));
    }
    if (req.url === "/health") return sendJson(res, healthAnswer(health));
    if (req.url === "/ready") {
      // Not before the broker answered it: its relayed calls need its service tokens, and a new
      // pod's NetworkPolicies may let it out a few seconds after it starts (#391).
      const waiting = !draining && brokerService?.ready?.() === false;
      const status = draining ? "draining" : waiting ? "waiting for the broker" : "ready";
      res.writeHead(draining || waiting ? 503 : 200, { "content-type": "text/plain" });
      return res.end(`${status}\n`);
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
    const https = url?.protocol === "https:";
    if (url?.protocol !== "http:" && !https) {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("Deckhand's egress proxy: expected an http:// or https:// URL, or CONNECT\n");
    }
    const forwarded = FORWARDED.get(url.origin);
    if (forwarded) return toNamed(req, res, url, forwarded).catch(() => res.destroy());
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    // Its request sent, an https:// one's client half-closes (busybox wget): not gone yet.
    const gone = () => (!https && req.socket.readableEnded) || req.socket.destroyed;
    let decision;
    try {
      decision = await decide(req.socket, host, gone);
    } catch (error) {
      res.writeHead(error.cause === 502 ? 502 : 403, { "content-type": "text/plain" });
      return res.end(`${error instanceof Refused ? error.message : "refused"}\n`);
    }
    // A relayed host has no address to go to: its calls are a service's, over HTTPS only.
    if (decision.relay && https) {
      counted(req.socket, decision, true);
      const { service, models, sandbox } = decision;
      const to = { github: service === "github", models, sandbox };
      return toRelayed(req, res, host, url.pathname + url.search, to);
    }
    if (decision.relay) {
      counted(req.socket, decision, false, "no_relay");
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end(`Deckhand's egress proxy relays ${host} over HTTPS only\n`);
    }
    // As tunnel() has it: HTTPS cached only where its CONNECT would be decrypted, never an
    // agent provider's (certifiable(), authority.mjs EXCLUDED) nor with no CA.
    const cacheOk =
      decision.cache && (!https || (decision.decrypt && !!authority && certifiable(host)));
    counted(req.socket, decision, true);
    relay(req, res, { address: decision.address, url, host }, cacheOk);
  }

  // A sandbox's call to a service's name (#511): on to that service, with the network (or pod) it
  // came from, which the service binds the run's tokens to. Only for whom the orchestrator says
  // may (its runs' sandboxes and engines, not a build or an install), and only on the paths that
  // service takes from sandboxes. `url`: parsed, its dot segments resolved.
  async function toNamed(req, res, url, { name, paths }) {
    const forbid = (status, why) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(`Deckhand's egress proxy: ${why}\n`);
    };
    if (!paths.test(url.pathname)) return forbid(404, `not a path of the ${name} service's`);
    const answer = await ask(req.socket, url.hostname, {
      gone: () => req.socket.readableEnded || req.socket.destroyed,
      forward: true,
    });
    const { allowed, sandbox } = answer;
    if (req.socket.destroyed) return;
    counted(req.socket, answer, allowed, answer.reason ?? "not_forwarded");
    if (!allowed) return forbid(403, `only a running sandbox reaches the ${name} service`);
    const service = { broker: brokerService, github: githubService, models: modelsService }[name];
    if (!service) return unavailable(res, name);
    // Its path and query set on a copy of the service's URL, never parsed again: "//host/x"
    // would read as another host's URL. No credentials in the URL become a header either.
    const to = new URL(service.url);
    to.pathname = url.pathname;
    to.search = url.search;
    if (name === "models") return toModels(req, res, to, sandbox);
    if (name === "github") return toGithub(req, res, to, sandbox);
    // A run token's calls about its own run: to the broker service, the token apart.
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    let authorization;
    try {
      authorization = await serviceHeader(req, service);
    } catch {
      return unavailable(res, "broker");
    }
    return onward(req, res, to, "broker", {
      authorization,
      [RUN_TOKEN_HEADER]: token,
      [SANDBOX_HEADER]: sandbox ?? "",
    });
  }

  // The proxy's own token for `service`, from a broker that may be restarting too: waited for as
  // the call is.
  function serviceHeader(req, service) {
    return untilReached(() => service.header(), { ...wait, gone: () => req.socket.destroyed });
  }

  // A sandbox's call on to the github service at `url` (a relayed GitHub host's request as
  // /relay/<host><path>, or a push): its Authorization moved to RUN_AUTH_HEADER, for the
  // service's gateway, the proxy's own in its place, the network (or pod) vouched for.
  async function toGithub(req, res, url, sandbox) {
    let authorization;
    try {
      authorization = await serviceHeader(req, githubService);
    } catch {
      return unavailable(res, "github");
    }
    return onward(req, res, url, "github", {
      authorization,
      [RUN_AUTH_HEADER]: req.headers.authorization ?? "",
      [SANDBOX_HEADER]: sandbox ?? "",
    });
  }

  // An agent's call, to the models service at `url`: its agent token moved to RUN_TOKEN_HEADER,
  // the proxy's own service token in its place, and the network (or pod) `sandbox` it came from,
  // as the policy said. Waited for as the call is, as for the broker.
  async function toModels(req, res, url, sandbox) {
    let authorization;
    try {
      authorization = await serviceHeader(req, modelsService);
    } catch {
      return unavailable(res, "models");
    }
    return onward(
      req,
      res,
      url,
      "models",
      {
        authorization,
        [RUN_TOKEN_HEADER]: agentTokenOf(req.headers),
        [SANDBOX_HEADER]: sandbox ?? "",
      },
      AGENT_TOKEN_HEADERS,
    );
  }

  // A service (`target`: "broker", "github", "models") that didn't answer: counted, and said.
  const serviceName = (target) => (target === "broker" ? "the broker" : `the ${target} service`);
  function unavailable(res, target) {
    metrics.gateway(target, "unreachable");
    unreachable(res, serviceName(target));
  }

  // A request on to the `target` service at `url`, with `extra` headers over its own, without
  // those of `drop`. A service restarting is waited for: the request is sent once a connection
  // is made, and never again (wait.mjs). Counted with its answer's status.
  async function onward(req, res, url, target, extra = {}, drop = []) {
    const headers = { ...req.headers, host: url.host };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("proxy-") || VOUCHED.includes(name) || drop.includes(name)) {
        delete headers[name];
      }
    }
    Object.assign(headers, extra);
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
      return unavailable(res, target);
    }
    if (gone) return socket.destroy();
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    upstream = send(
      url,
      { method: req.method, headers, createConnection: () => socket },
      (answer) => {
        metrics.gateway(target, String(answer.statusCode));
        // That connection's, not the client's, which stays open for its next request.
        const { connection, "keep-alive": keepAlive, ...rest } = answer.headers;
        res.writeHead(answer.statusCode, rest);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      // Once answered, its status is counted already: the answer was cut.
      if (res.headersSent) return unreachable(res, serviceName(target));
      unavailable(res, target);
    });
    req.pipe(upstream);
  }

  // A request on to its host: through the cache when the host's answers may be kept and the
  // request may use it, else as is.
  function relay(req, res, { address, url, host }, cacheOk) {
    const headers = { ...req.headers, host: url.host };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("proxy-")) delete headers[name];
    }
    // What the services read a sandbox's call by: nobody may pass it on (should a host the
    // operator names lead back to one).
    for (const name of VOUCHED) delete headers[name];
    const to = { address, url, host, headers };
    const use = cache?.enabled && cacheOk ? requestUse(req) : "skip";
    if (use !== "skip") return cached(req, res, to, use);
    if (cache?.enabled && cacheOk) metrics.cache("bypassed");
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

  const cached = cache
    ? createCachedPath({ cache, send, unreachable, now, count: metrics.cache })
    : null;

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
  // A client that half-closes once its request is sent still gets its answer: busybox wget does
  // for an https:// URL, even through a proxy (#635), and Node otherwise ends the connection
  // before answering (an undocumented property of node:http's server, there since Node 0.x).
  // Only for those URLs: forward() ends the others when their client does.
  server.httpAllowHalfOpen = true;
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
  // The orchestrator's egress policy, on its own port.
  const url = process.env.POLICY_URL || "http://orchestrator:8082/egress";
  const port = Number(process.env.PORT ?? 3128);
  const log = createLogger({ service: "egress" });
  // Its metrics (../lib/metrics.mjs, metrics.mjs), on their own port when METRICS_PORT is set:
  // from its environment alone (compose.yaml's EGRESS_METRICS_PORT), never config.yaml's, as
  // every sandbox reaches the proxy, and so that port (docs/security.md).
  let registry;
  try {
    ({ registry } = startMetrics({
      service: "egress",
      port: metricsPort(process.env.METRICS_PORT),
      log,
    }));
  } catch (error) {
    log.error(`Egress proxy: ${error.message}`);
    process.exit(1);
  }
  const dir = process.env.EGRESS_CACHE_DIR || "/cache";
  const cache = createCache({
    dir,
    max: parseSize(process.env.EGRESS_CACHE_MAX, DEFAULT_MAX),
    entryMax: parseSize(process.env.EGRESS_CACHE_ENTRY_MAX, DEFAULT_ENTRY_MAX),
    log,
  });
  const metrics = egressMetrics(registry, { cache });
  // The CA lives next to the cache, in the proxy's volume, cache on or off: relayed hosts need
  // it too.
  let authority = createAuthority({ dir: join(dir, "ca"), log });
  try {
    await authority.ready();
  } catch (error) {
    log(`HTTPS isn't cached or relayed: no CA (${error.message})`);
    authority = null;
  }
  // The services sandboxes' calls go to, each one address: the proxy can't try a streamed call
  // again elsewhere, so a service's copies are behind one name (a Service on Kubernetes), not
  // listed as the orchestrator may list them. The broker service (#505): their calls about their
  // own run, with the proxy's own service token (asked for in the background: the proxy serves
  // the rest meanwhile); the github service (#502): GitHub's relayed hosts and the pushes; the
  // models service (#504): the agents' calls. Each with the proxy's token for it, from the
  // broker.
  const urls = {
    BROKER_SERVICE_URL: process.env.BROKER_SERVICE_URL || SANDBOX_URLS.broker,
    GITHUB_SERVICE_URL: process.env.GITHUB_SERVICE_URL || SANDBOX_URLS.github,
    MODELS_SERVICE_URL: process.env.MODELS_SERVICE_URL || SANDBOX_URLS.models,
  };
  for (const [name, value] of Object.entries(urls)) {
    if (!/^https?:\/\/[^,\s]+$/.test(value)) {
      log.error(
        `${name}: ${value} is not one http(s) URL: the egress proxy takes one address, which balances between the service's copies`,
      );
      process.exit(1);
    }
    urls[name] = value.replace(/\/$/, "");
  }
  const caller = createBrokerCaller({
    url: urls.BROKER_SERVICE_URL,
    audiences: ["broker", "github", "models"],
    podTokenFile: process.env.SERVICE_ACCOUNT_TOKEN_FILE || null,
    log,
  });
  caller.start();
  const brokerService = caller;
  const githubService = { url: urls.GITHUB_SERVICE_URL, header: () => caller.header("github") };
  const modelsService = { url: urls.MODELS_SERVICE_URL, header: () => caller.header("models") };
  const https = authority ? ", HTTPS too" : "";
  const options = {
    policy: egressPolicy(url),
    cache,
    authority,
    brokerService,
    githubService,
    modelsService,
    log,
    metrics,
  };
  const proxy = createProxy(options);
  proxy.listen(port, () =>
    log(`Egress proxy on :${port}, asking ${url}; cache ${cache.enabled ? `on${https}` : "off"}`),
  );
  // The same, for the container engines that share their sandbox's address (#573).
  const engines = createProxy({ ...options, engine: true });
  engines.listen(ENGINE_PROXY_PORT, () =>
    log(`Container engines' egress on :${ENGINE_PROXY_PORT}`),
  );
  // On SIGTERM, the requests in flight get DRAIN_SECONDS, then what is still open (long-lived
  // tunnels: a raw one is never known to be idle) is cut. Alone, a short grace, before compose's
  // stop_grace_period (30 s): `docker compose up` starts the next proxy only once this one
  // exited, and nothing in a sandbox tries a refused connection again. Beside a second copy,
  // which takes the new connections, as long as an agent call.
  drainOnSigterm([proxy, engines], { graceMs: drainMs(process.env.DRAIN_SECONDS), log });
}
