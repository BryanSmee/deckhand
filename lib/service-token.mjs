// Service tokens (#500, docs/security.md, Service tokens): how one service proves to another
// who calls. The broker signs them as it signs run tokens (tokens.mjs: Ed25519, checked offline
// with its public key), with
//
//   - `sub`, the calling service, and `aud`, the service called (`deckhand:service:<name>`, so
//     a run token is never one, nor the other way round);
//   - `exp`, 15 minutes: each service gets its tokens from the broker at start, and again
//     before they end (serviceTokens());
//   - `ver`, the claims' format, as a run token's.
//
// A token alone isn't enough: it is bound to its caller. The broker hands one only to the
// service it names, proven by the network the request arrived on with Docker (each service is
// attached only to the networks of the services it calls, one per caller and callee), by its
// pod's projected service account token on Kubernetes (#396, #505). And the service called
// checks the same network again (bound()), so a token stolen from one service can't be replayed
// from another. Then each endpoint names the callers it takes, in one table per service
// (serviceGuard()): `aud` alone would let a compromised edge do whatever the github service
// does.
import { Refused } from "./http.mjs";
import { CALLS, SERVICES } from "./services.mjs";
import { inCidr, overlaps, parseCidr } from "./subnets.mjs";
import { signToken, TOKEN_VERSION, TokenError, verifyToken } from "./tokens.mjs";

export const SERVICE_TOKEN_TTL_MS = 15 * 60_000;

export const serviceAudience = (service) => `deckhand:service:${service}`;

// A token for `sub` to call `aud`. `signing`: { privateKey, kid } (tokens.mjs signingKey()).
export function signServiceToken({ sub, aud }, signing, { now = Date.now() } = {}) {
  if (!SERVICES.includes(sub) || !SERVICES.includes(aud)) {
    throw new Error(`no service token from ${sub} to ${aud}: not services`);
  }
  return signToken(
    { ver: TOKEN_VERSION, sub },
    { ...signing, audience: serviceAudience(aud), ttlMs: SERVICE_TOKEN_TTL_MS, now },
  );
}

// The claims of a token for `service`, or a TokenError.
export function verifyServiceToken(token, { keys, service, now = Date.now() }) {
  const claims = verifyToken(token, { keys, audience: serviceAudience(service), now });
  if (!SERVICES.includes(claims.sub)) throw new TokenError("not from a service");
  return claims;
}

// SERVICE_NETWORKS, "edge=172.30.1.0/24,orchestrator=172.30.2.0/24": the subnet of each
// caller's network to this service → (localAddress) → the callers a call arriving there may
// come from, [] for none. The callee's own address on a network is what tells them apart: a
// caller can't choose it, only the network it is attached to. Services that still run in one
// container (the listener's, until #506) share its network: "edge+orchestrator=172.30.3.0/24",
// as the network can't tell them apart.
export function networkCallers(text) {
  const ranges = [];
  for (const part of String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [names, cidr] = part.split("=").map((s) => s.trim());
    const callers = String(names ?? "")
      .split("+")
      .map((s) => s.trim());
    const range = cidr && parseCidr(cidr);
    if (!callers.every((caller) => SERVICES.includes(caller)) || !range) {
      throw new Error(`SERVICE_NETWORKS: expected service=subnet, got ${part}`);
    }
    // Overlapping, the first would take the other's calls: a typo, refused.
    const taken = ranges.find((other) => overlaps(other.cidr, cidr));
    if (taken) {
      throw new Error(`SERVICE_NETWORKS: ${part} overlaps ${taken.names}=${taken.cidr}`);
    }
    ranges.push({ names, callers, cidr, range });
  }
  return (address) => ranges.find(({ range }) => inCidr(address, range))?.callers ?? [];
}

// "GET /repos/:owner/:repo/config", "POST /tokens", "GET /runs/*": one segment for each `:x`,
// the rest of the path for a last `*`.
function routeMatcher(key) {
  const [method, path] = key.split(" ");
  const parts = path.split("/");
  const rest = parts.at(-1) === "*";
  if (rest) parts.pop();
  return (req, pathname) => {
    if (req.method !== method) return false;
    const segments = pathname.split("/");
    if (rest ? segments.length <= parts.length : segments.length !== parts.length) return false;
    return parts.every((part, i) => part.startsWith(":") || part === segments[i]);
  };
}

// The request's path as sent, when it is the one a handler routing on `req.url` reads too:
// one `/` first (not `//host`), no `.` or `..` segment, nothing the URL parser would change.
// Anything else, 400: the guard would allow one endpoint and the handler serve another.
export function pathOf(url) {
  const raw = String(url ?? "").split("?")[0];
  let parsed;
  try {
    parsed = new URL(raw, "http://service").pathname;
  } catch {
    parsed = null;
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || parsed !== raw) {
    throw new Refused(400, "not a plain path");
  }
  return raw;
}

// A Refused with why, in a word its metrics count (`reason`: expired, invalid, unknown_caller,
// not_allowed; the broker's deckhand_tokens_refused_total).
const refusal = (status, message, reason) =>
  Object.assign(new Refused(status, message), { reason });

// What a service checks first on every call from another: → (req) → the caller's name, or a
// Refused (lib/http.mjs) saying why not, which the service answers with:
//
//   - 401: no token, or one that isn't valid for `service` (its key, `aud`, `exp`);
//   - 403: from a network that isn't its caller's (`bound`), or an endpoint `routes` doesn't
//     give it: every route matching it must name the caller. An endpoint that isn't in
//     `routes` is refused to every caller;
//   - 400: a path that isn't plain (`//host/…`, dot segments), which a handler could route on
//     differently.
//
// `routes`: { "METHOD /path": [callers] }, the service's one table. `keys`: kid → public key.
// `bound`: networkCallers()'s, or null where the network can't tell (Kubernetes, whose
// NetworkPolicies and the pod's own service account do that).
export function serviceGuard({ service, keys, routes, bound, now = Date.now }) {
  if (bound === undefined) throw new Error(`${service}: bound: networkCallers(), or null`);
  const table = Object.entries(routes).map(([key, callers]) => {
    for (const caller of callers) {
      if (!SERVICES.includes(caller)) throw new Error(`${service}: ${key}: ${caller}?`);
    }
    return { matches: routeMatcher(key), callers };
  });
  return (req) => {
    const header = req.headers.authorization ?? "";
    const token = /^Bearer (\S+)$/.exec(header)?.[1];
    if (!token) throw refusal(401, "a service token is needed", "invalid");
    let claims;
    try {
      claims = verifyServiceToken(token, { keys, service, now: now() });
    } catch (error) {
      if (error instanceof TokenError) {
        throw refusal(401, `service token: ${error.message}`, error.code);
      }
      throw error;
    }
    const caller = claims.sub;
    if (bound && !bound(req.socket.localAddress).includes(caller)) {
      throw refusal(403, `${caller}'s token, from another service's network`, "unknown_caller");
    }
    const pathname = pathOf(req.url);
    // Every route that matches must take the caller, whatever their order: a broad `*` listed
    // before a narrower route never widens it.
    const routes = table.filter(({ matches }) => matches(req, pathname));
    if (!routes.length || !routes.every((route) => route.callers.includes(caller))) {
      throw refusal(403, `${caller} may not ${req.method} ${pathname}`, "not_allowed");
    }
    return caller;
  };
}

// The broker's side: the tokens `caller` asks for, one per service in `audiences`, each one it
// calls (CALLS) → { [aud]: token }. `caller` is the service proven by the request (its network,
// its pod's token), never one it names itself.
export function issueServiceTokens(caller, audiences, signing, { now = Date.now() } = {}) {
  if (!caller) throw refusal(403, "not from a service", "unknown_caller");
  const wanted = [...new Set(audiences)];
  const refused = wanted.filter((aud) => !CALLS[caller]?.includes(aud));
  if (!wanted.length || refused.length) {
    const message = `${caller} doesn't call ${refused.join(", ") || "anything"}`;
    throw refusal(403, message, "not_allowed");
  }
  return Object.fromEntries(
    wanted.map((aud) => [aud, signServiceToken({ sub: caller, aud }, signing, { now })]),
  );
}

// The calling side: a service's tokens for the services it calls, from the broker's
// `request(audiences)` (→ { [aud]: token }), asked for at start (start()) and again two thirds
// into their lifetime, so a call never carries one about to end. A broker that doesn't answer
// is asked again a little later, while the tokens held last. `header(aud)`: the Authorization
// header for a call to `aud`.
export function serviceTokens({
  audiences,
  request,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryMs = 5000,
  log = () => {},
}) {
  let tokens = {};
  let until = 0;
  let timer = null;
  let stopped = false;

  async function refresh() {
    const fresh = await request(audiences);
    for (const aud of audiences) {
      if (typeof fresh?.[aud] !== "string") throw new Error(`the broker sent no token for ${aud}`);
    }
    tokens = { ...fresh };
    until = now() + SERVICE_TOKEN_TTL_MS;
    return tokens;
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimer(renew, ms);
    timer.unref?.();
  }

  async function renew() {
    try {
      await refresh();
      schedule((SERVICE_TOKEN_TTL_MS * 2) / 3);
    } catch (error) {
      log(`Service tokens: not renewed (${error.message}), trying again`);
      schedule(retryMs);
    }
  }

  return {
    // The first tokens: a service doesn't start without them.
    async start() {
      await refresh();
      schedule((SERVICE_TOKEN_TTL_MS * 2) / 3);
    },
    async header(aud) {
      if (!audiences.includes(aud)) throw new Error(`no service token for ${aud}`);
      // The renewal failed until its last minute: asked for now, the call waits for it.
      if (now() >= until - 60_000) await refresh();
      return `Bearer ${tokens[aud]}`;
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
    },
  };
}
