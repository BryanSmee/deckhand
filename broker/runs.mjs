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
import { createHash } from "node:crypto";
import {
  AGENT_AUDIENCE,
  AGENT_TOKEN_TTL_MS,
  isToken,
  RENEW_GRACE_MS,
  RUN_AUDIENCE,
  signToken,
  TOKEN_VERSION,
  TOKEN_TTL_MS,
  TokenError,
  verifyToken,
} from "../lib/tokens.mjs";
import { createSeal } from "./seal.mjs";

export { AGENT_TOKEN_TTL_MS, RENEW_GRACE_MS, TOKEN_TTL_MS };

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
    // What the run's start decided it gets (the listener's capabilities.mjs): names only.
    caps: record.caps ?? [],
    // The provider of the run's agent, and the credential of its it names (null: the default),
    // which the models service reads (#504): a run of one agent never gets another's.
    ...(record.provider && {
      agent: { provider: record.provider, credential: record.credential ?? null },
    }),
  };
}

// A capability's name, as the listener's catalogue spells them (`pull`, `image:repo`).
const CAP = /^[a-z][a-z0-9:_-]{0,63}$/;

// What the orchestrator says of a run (PUT /runs/:id, POST /runs/:id/tokens), checked: the
// claims' fields (its agent's provider and credential among them) and its screenshots' folder.
// Anything else is dropped.
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
    caps: Array.isArray(body?.caps) ? body.caps.filter((c) => CAP.test(c ?? "")).slice(0, 64) : [],
    provider: text(body?.provider),
    credential: text(body?.credential),
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

  // kid → public key: what checks a run token or a service's.
  const runKeys = () => new Map([[key.kid, key.publicKey]]);
  const serviceKeys = runKeys;

  // The public keys, as GET /keys serves them: PEMs by kid.
  async function publicKeys() {
    const own = [{ kid: key.kid, pem: key.publicKey.export({ type: "spki", format: "pem" }) }];
    return { service: own, run: own };
  }

  // A run the orchestrator knows is going (PUT /runs/:id): one it restarted with, whose sandbox
  // already holds its tokens. What the broker keeps of its tokens stays.
  // `issued`: the hashes of the run tokens its sandbox was handed ({ hash, exp }), as the
  // orchestrator saved them: a record the broker doesn't have yet starts with them, so that
  // past its expiry only the newest of them renews, as the listener that signed them ruled.
  async function put(id, fields, issued = []) {
    // What the orchestrator doesn't know leaves what the broker has.
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
        keys: runKeys(),
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
  // run, or the last one presented (one a broker that lost the run's record signed). An older one, left behind in a process's environment say, is dead once expired. A
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
        // Started again on another sandbox meanwhile (another copy): the old one's isn't its.
        if (run.sandbox && run.sandbox !== claims.sandbox) {
          return ((answer = { status: 403, message: NOT_ITS_SANDBOX }), undefined);
        }
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
    // Only those found gone: another copy may have added one meanwhile. Their files go too,
    // unless the run started again meanwhile (its id is reused): read once more right before.
    for (const id of dead) {
      if (await get(id)) dead.delete(id);
      else await expired(id);
    }
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
    put,
    issue,
    check,
    renew,
    end,
    get,
    list,
    event,
    publicKeys,
    runKeys,
    serviceKeys,
  };
}
