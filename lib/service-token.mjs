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
import { inCidr, parseCidr } from "./subnets.mjs";
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
// caller's network to this service → (localAddress) → the caller a call arriving there may
// come from, or null. The callee's own address on a network is what tells them apart: a caller
// can't choose it, only the network it is attached to.
export function networkCallers(text) {
  const ranges = [];
  for (const part of String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [caller, cidr] = part.split("=").map((s) => s.trim());
    const range = cidr && parseCidr(cidr);
    if (!SERVICES.includes(caller) || !range) {
      throw new Error(`SERVICE_NETWORKS: expected service=subnet, got ${part}`);
    }
    ranges.push({ caller, range });
  }
  return (address) => ranges.find(({ range }) => inCidr(address, range))?.caller ?? null;
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

// What a service checks first on every call from another: → (req) → the caller's name, or a
// Refused (lib/http.mjs) saying why not, which the service answers with:
//
//   - 401: no token, or one that isn't valid for `service` (its key, `aud`, `exp`);
//   - 403: from a network that isn't its caller's (`bound`), or an endpoint `routes` doesn't
//     give it. An endpoint that isn't in `routes` is refused to every caller.
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
    if (!token) throw new Refused(401, "a service token is needed");
    let claims;
    try {
      claims = verifyServiceToken(token, { keys, service, now: now() });
    } catch (error) {
      if (error instanceof TokenError) throw new Refused(401, `service token: ${error.message}`);
      throw error;
    }
    const caller = claims.sub;
    if (bound && bound(req.socket.localAddress) !== caller) {
      throw new Refused(403, `${caller}'s token, from another service's network`);
    }
    const { pathname } = new URL(req.url, "http://service");
    const route = table.find(({ matches }) => matches(req, pathname));
    if (!route?.callers.includes(caller)) {
      throw new Refused(403, `${caller} may not ${req.method} ${pathname}`);
    }
    return caller;
  };
}

// The broker's side: the tokens `caller` asks for, one per service in `audiences`, each one it
// calls (CALLS) → { [aud]: token }. `caller` is the service proven by the request (its network,
// its pod's token), never one it names itself.
export function issueServiceTokens(caller, audiences, signing, { now = Date.now() } = {}) {
  if (!caller) throw new Refused(403, "not from a service");
  const wanted = [...new Set(audiences)];
  const refused = wanted.filter((aud) => !CALLS[caller]?.includes(aud));
  if (!wanted.length || refused.length) {
    throw new Refused(403, `${caller} doesn't call ${refused.join(", ") || "anything"}`);
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
