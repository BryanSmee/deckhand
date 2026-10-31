// The broker's live runs and their tokens (#505): the only service holding the signing key
// (../lib/tokens.mjs signingKey()), it signs each run's first tokens, renews them, and signs the
// services' own (../lib/service-token.mjs). Every other service checks them offline, with the
// public keys it serves (GET /keys).
//
// The live runs are in the store, not in memory: two copies of the broker, both active, share
// them, so a run ended through one can't renew through the other, and a copy that starts
// carries on with the runs the last one knew. A record holds what the run's tokens claim, the
// network or pod they are bound to (`sandbox`), and the hashes of its tokens still valid, never
// a token: the last one signed is kept sealed (seal.mjs), for a renewal asked again within a
// minute. What changes during a run (its pushes, its writes, the installation tokens it got)
// is the services' that see it, by the run's id, the tokens' `jti`.
//
// Each change goes on the `runs` stream (started, renewed, a screenshot, ended), which the
// orchestrator reads and acknowledges (GET /events): a copy stopping between a change and its
// event's handling loses nothing.
import { createHash, createPublicKey } from "node:crypto";
import {
  AGENT_AUDIENCE,
  AGENT_TOKEN_TTL_MS,
  isToken,
  keyId,
  LEGACY_KEY_MS,
  RENEW_GRACE_MS,
  RUN_AUDIENCE,
  signToken,
  TOKEN_VERSION,
  TOKEN_TTL_MS,
  TokenError,
  verifyToken,
} from "../lib/tokens.mjs";
import { createSeal } from "./seal.mjs";

export { AGENT_TOKEN_TTL_MS, LEGACY_KEY_MS, RENEW_GRACE_MS, TOKEN_TTL_MS };

// What a run's token sent from elsewhere than its sandbox gets.
export const NOT_ITS_SANDBOX = "this run's token only works from its own sandbox";

// How soon after a run token was signed a renewal gets that one again rather than a new one: a
// process that asks in a loop can't pile up valid tokens, nor push the one the sandbox holds out
// of the run's list.
export const RENEW_MIN_MS = 60_000;

// How long a run's record lasts without a renewal or a word from the orchestrator: what ends a
// run whose end never reached the broker (an orchestrator that died meanwhile). Past the
// renewal's grace, so a sandbox that couldn't renew for that long is gone anyway.
export const RECORD_TTL_MS = RENEW_GRACE_MS + 24 * 60 * 60_000;

export const STREAM = "runs";
const STREAM_MAX = 10_000;

const hash = (token) => createHash("sha256").update(token).digest("hex");
const runKey = (id) => `run:${id}`;
const INDEX = "runs";
const LEGACY = "legacy-keys";
const FIRST_START = "first-start";

// The claims a run's tokens carry: what doesn't change during the run, nothing secret.
function claimsOf(record) {
  return {
    ver: TOKEN_VERSION,
    jti: record.id,
    repo: record.repo,
    mode: record.mode,
    issue: record.issue,
    fork: record.fork,
    branches: record.branches,
    sandbox: record.sandbox,
    caps: [],
  };
}

// What the orchestrator says of a run (PUT /runs/:id, POST /runs/:id/tokens), checked: the
// claims' fields and its screenshots' folder. Anything else is dropped.
export function runFields(body) {
  const text = (v) => (typeof v === "string" && v ? v : null);
  return {
    repo: text(body?.repo)?.toLowerCase() ?? null,
    mode: text(body?.mode),
    issue: Number.isInteger(body?.issue) ? body.issue : null,
    fork: body?.fork === true,
    branches: Array.isArray(body?.branches) ? body.branches.filter((b) => text(b)) : [],
    sandbox: text(body?.sandbox),
    shots: text(body?.shots),
  };
}

// The hashes of a run's tokens the orchestrator sends (PUT /runs/:id), checked: { hash, exp, at:
// 0 }, the newest last.
export function issuedFields(list) {
  return (Array.isArray(list) ? list : [])
    .filter((t) => /^[0-9a-f]{64}$/.test(t?.hash ?? "") && Number.isFinite(t?.exp))
    .map(({ hash: h, exp }) => ({ hash: h, exp, at: 0 }))
    .slice(-20);
}

// `store`: lib/store.mjs's. `key`: { privateKey, publicKey, kid }.
// `expired(id)`: a run whose record expired (its end never reached the broker), for its files.
export function createRuns({ store, key, now = Date.now, expired = async () => {} }) {
  const seal = createSeal(key.privateKey);
  const event = (type, run, extra = {}) =>
    store.append(STREAM, { type, run, at: now(), ...extra }, { maxLength: STREAM_MAX });

  // Read, changed by `fn` (→ the new value, or undefined: nothing to write), written only if no
  // other copy changed it meanwhile; else again. → fn's value.
  async function update(name, fn, options) {
    for (;;) {
      const before = await store.get(name);
      const after = fn(before === null ? null : structuredClone(before));
      if (after === undefined) return before;
      if (await store.compareAndSet(name, before, after, options)) return after;
    }
  }

  // When the first broker on this store started: kept, a later copy finds it.
  // Read when a key is imported, again after a failure (a store not reachable yet): nothing
  // waits on the store while the broker starts. The first copy to start on the store writes it
  // (server.mjs), so a later import doesn't count as the first start.
  let firstStart = null;
  const started = () =>
    (firstStart ??= store
      .setIfAbsent(FIRST_START, now())
      .then(() => store.get(FIRST_START))
      .catch((error) => {
        firstStart = null;
        throw error;
      }));

  const index = (fn) => update(INDEX, (ids) => fn(ids ?? {}));

  function sign(record, audience, ttlMs) {
    return signToken(claimsOf(record), {
      privateKey: key.privateKey,
      kid: key.kid,
      audience,
      ttlMs,
      now: now(),
    });
  }

  // The legacy keys still valid, kid → public key; read from the store a little while.
  let legacy = { at: -Infinity, keys: new Map() };
  async function legacyKeys() {
    if (now() - legacy.at < 10_000) return legacy.keys;
    const saved = (await store.get(LEGACY)) ?? [];
    const keys = new Map(
      saved.filter((k) => k.until > now()).map((k) => [k.kid, createPublicKey(k.pem)]),
    );
    legacy = { at: now(), keys };
    return keys;
  }

  // kid → public key: what checks a run token (with the legacy keys) or a service's (without).
  async function runKeys() {
    return new Map([[key.kid, key.publicKey], ...(await legacyKeys())]);
  }
  const serviceKeys = () => new Map([[key.kid, key.publicKey]]);

  // The public keys, as GET /keys serves them: PEMs by kid.
  async function publicKeys() {
    const pem = (k) => k.export({ type: "spki", format: "pem" });
    const run = [...(await runKeys())].map(([kid, k]) => ({ kid, pem: pem(k) }));
    return { service: [{ kid: key.kid, pem: pem(key.publicKey) }], run };
  }

  // A legacy key's public part (POST /keys): taken for run tokens, for LEGACY_KEY_MS from its
  // first import. Its own key is never one.
  async function importKey(pem) {
    // During the migration only: within LEGACY_KEY_MS of the broker's first start, when a
    // listener that signed tokens itself can still have runs going.
    const first = await started();
    if (now() - first > LEGACY_KEY_MS) {
      return { status: 409, message: "an old key is only taken in the broker's first days" };
    }
    let publicKey;
    try {
      publicKey = createPublicKey(pem);
    } catch {
      return { status: 400, message: "not a public key" };
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return { status: 400, message: "not an Ed25519 key" };
    }
    const kid = keyId(publicKey);
    if (kid === key.kid) return { kid };
    const exported = publicKey.export({ type: "spki", format: "pem" });
    await update(LEGACY, (keys) => {
      const live = (keys ?? []).filter((k) => k.until > now());
      if (live.some((k) => k.kid === kid)) return live;
      return [...live, { kid, pem: exported, until: now() + LEGACY_KEY_MS }];
    });
    legacy.at = -Infinity;
    return { kid };
  }

  // A run the orchestrator knows is going (PUT /runs/:id): one a listener restarted with, or
  // from before the broker service, whose sandbox already holds its tokens. What the broker
  // keeps of its tokens stays.
  // `issued`: the hashes of the run tokens its sandbox was handed ({ hash, exp }), as the
  // orchestrator saved them: a record the broker doesn't have yet starts with them, so that
  // past its expiry only the newest of them renews, as the listener that signed them ruled.
  async function put(id, fields, issued = []) {
    // What the orchestrator doesn't know (a run from before tokens, its sandbox not looked up
    // yet) leaves what the broker has.
    const known = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
    const record = await update(
      runKey(id),
      (old) => ({
        presented: null,
        last: null,
        ...old,
        issued: old?.issued?.length ? old.issued : issuedFields(issued),
        ...known,
        id,
      }),
      { ttlMs: RECORD_TTL_MS },
    );
    await index((ids) => (ids[id] ? undefined : { ...ids, [id]: true }));
    return record;
  }

  // The run's first tokens (POST /runs/:id/tokens), once its sandbox's network (or pod) is known:
  // → { token, agentToken }, or { status, message }. Its record starts again: the tokens a
  // sandbox of a previous start held are no longer its.
  async function issue(id, fields) {
    if (!fields.sandbox) return { status: 400, message: "no sandbox to bind the tokens to" };
    if (!fields.repo) return { status: 400, message: "no repo" };
    const record = { ...fields, id, issued: [], presented: null, last: null };
    const agentToken = sign(record, AGENT_AUDIENCE, AGENT_TOKEN_TTL_MS);
    const token = sign(record, RUN_AUDIENCE, TOKEN_TTL_MS);
    record.issued = [{ hash: hash(token), exp: now() + TOKEN_TTL_MS, at: now() }];
    record.last = seal.seal(token);
    await store.set(runKey(id), record, { ttlMs: RECORD_TTL_MS });
    await index((ids) => (ids[id] ? undefined : { ...ids, [id]: true }));
    await event("started", id);
    return { token, agentToken };
  }

  // The run a sandbox's token names, once checked: { record, claims } or { status, message }.
  // `sandbox`: the network (or pod) the call came from, as the proxy vouches for it.
  // `graceMs`: how long past its expiry it is still taken (a renewal's).
  async function check(token, sandbox, graceMs = 0) {
    const unknown = { status: 401, message: "unknown or finished run" };
    if (!isToken(token)) return unknown;
    let claims;
    try {
      claims = verifyToken(token, {
        keys: await runKeys(),
        audience: RUN_AUDIENCE,
        now: now(),
        graceMs,
      });
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      return { status: 401, message: `this run token is refused: ${error.message}` };
    }
    // A token outlives nothing: a run that ended has none that works.
    const record = await store.get(runKey(claims.jti));
    if (!record) return unknown;
    if (!sandbox || !claims.sandbox || claims.sandbox !== sandbox) {
      return { status: 403, message: NOT_ITS_SANDBOX };
    }
    // A record bound elsewhere (the run started again): the old sandbox's token is no longer
    // the run's.
    if (record.sandbox && record.sandbox !== claims.sandbox) {
      return { status: 403, message: NOT_ITS_SANDBOX };
    }
    return { record, claims };
  }

  // A new run token for the one the sandbox sends (POST /run/token), taken up to
  // RENEW_GRACE_MS past its expiry: { token } or { status, message }. An ended run's is
  // refused. Past its expiry, only the token the sandbox holds renews: the newest signed for the
  // run, or the last one presented (which a listener from before the broker service may have
  // signed). An older one, left behind in a process's environment say, is dead once expired. A
  // run whose tokens the broker never knew can't tell: it takes it. Asked again within
  // RENEW_MIN_MS of the last one signed: that one.
  async function renew(token, sandbox) {
    if (!isToken(token)) return { status: 401, message: "only a run token is renewed" };
    const checked = await check(token, sandbox, RENEW_GRACE_MS);
    if (!checked.record) return checked;
    const { claims } = checked;
    const presented = hash(token);
    let answer = null;
    const record = await update(
      runKey(claims.jti),
      (run) => {
        // Ended meanwhile (another copy): nothing.
        if (!run)
          return ((answer = { status: 401, message: "unknown or finished run" }), undefined);
        const newest = run.issued.at(-1)?.hash;
        const expired = claims.exp * 1000 <= now();
        if (expired && newest && presented !== newest && presented !== run.presented) {
          answer = { status: 401, message: "this run token is refused: expired" };
          return undefined;
        }
        run.sandbox ??= claims.sandbox;
        run.presented = presented;
        if (!run.issued.some((t) => t.hash === presented)) {
          run.issued = [{ hash: presented, exp: claims.exp * 1000, at: 0 }, ...run.issued];
        }
        const last = run.issued.at(-1);
        const again = last.at && now() - last.at < RENEW_MIN_MS && last.exp > now();
        const kept = again && seal.open(run.last);
        if (kept) {
          answer = { token: kept };
          return run;
        }
        const fresh = sign(run, RUN_AUDIENCE, TOKEN_TTL_MS);
        const valid = (t) => t.exp > now() || t.hash === run.presented;
        run.issued = [
          ...run.issued.filter(valid),
          { hash: hash(fresh), exp: now() + TOKEN_TTL_MS, at: now() },
        ];
        run.last = seal.seal(fresh);
        answer = { token: fresh, renewed: true };
        return run;
      },
      { ttlMs: RECORD_TTL_MS },
    );
    if (!answer.token) return answer;
    if (answer.renewed) await event("renewed", record.id);
    return { token: answer.token };
  }

  // The run is over (DELETE /runs/:id): its tokens are refused from now on, by every copy.
  // → whether it was live.
  async function end(id) {
    const had = await store.delete(runKey(id));
    await index((ids) => {
      if (!ids[id]) return undefined;
      const { [id]: gone, ...rest } = ids;
      return rest;
    });
    if (had) await event("ended", id);
    return had;
  }

  const get = (id) => store.get(runKey(id));

  // The live runs' ids (GET /runs): those whose record expired are dropped from the list.
  async function list() {
    const ids = Object.keys((await store.get(INDEX)) ?? {});
    const live = [];
    const dead = new Set();
    for (const id of ids) (await get(id)) ? live.push(id) : dead.add(id);
    // Only those found gone: another copy may have added one meanwhile. Their files go too.
    for (const id of dead) await expired(id);
    if (dead.size) {
      await index((all) =>
        Object.fromEntries(
          Object.keys(all)
            .filter((id) => !dead.has(id))
            .map((id) => [id, true]),
        ),
      );
    }
    return live;
  }

  return {
    started,
    put,
    issue,
    check,
    renew,
    end,
    get,
    list,
    event,
    importKey,
    publicKeys,
    runKeys,
    serviceKeys,
  };
}
