// The runs the github service serves (#502), in its store, so that its two copies agree on each
// one: what the orchestrator decided of it (PUT /runs/:id: its repo, mode, issue, branches,
// capabilities, the network or pod its tokens are bound to…), and what changes while it runs,
// changed with compare-and-set (update()): the issues it created, the comments it posted, the
// reactions it added, the workflow runs it reran. Also shared between the copies: its calls in
// flight (a counter), what GitHub advertised to its git (a fetch's pack request may reach the
// other copy), and the reactions the listener added (claim(), noted before GitHub is asked).
//
// The gateways (../listener/github-gateway.mjs, git-gateway.mjs) see a run as the listener's
// broker gave it (../listener/broker.mjs): check() and bySandbox() give them the same object
// for the same run in this copy (their per-run memories are by object), its fields and state
// read again from the store on each call.
import { createHash } from "node:crypto";
import { isToken, RUN_AUDIENCE, TokenError, verifyToken } from "../lib/tokens.mjs";
import { NOT_ITS_SANDBOX } from "../listener/broker.mjs";
import { IDLE_MS } from "../listener/upstream.mjs";

// A run lasts 7 days at most (its agent token's lifetime): its record, a day more.
export const RUN_TTL_MS = 8 * 24 * 60 * 60_000;
// The listener's reactions are kept that long (the run that could take one off is over by then).
export const CLAIM_TTL_MS = 30 * 24 * 60 * 60_000;
// The events the orchestrator reads (pushes, notes for a run's log, pull requests changed).
export const STREAM = "github";
const STREAM_MAX = 10_000;

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

// What the orchestrator says of a run (PUT /runs/:id), checked: anything else is dropped.
export function runFields(body) {
  const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === "string") : []);
  const string = (value) => (typeof value === "string" && value ? value : null);
  const repo = string(body?.repo);
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  return {
    repo: repo.toLowerCase(),
    push: body.push === true,
    mode: string(body.mode),
    issue: Number.isInteger(body.issue) ? body.issue : null,
    base: string(body.base),
    reason: string(body.reason),
    branches: strings(body.branches),
    fork: body.fork === true,
    caps: strings(body.caps),
    decided: body.decided === true,
    sandbox: string(body.sandbox),
    // Whom its writes may assign (ALLOWED_USERS, narrowed by the repo's `users`, lower case),
    // and the label its questions wait under: the orchestrator's settings, as the run started.
    users: strings(body.users).map((u) => u.toLowerCase()),
    needsInputLabel: string(body.needsInputLabel),
    // A run from before tokens: its secret's hash, never the secret.
    secretHash: /^[0-9a-f]{64}$/.test(body.secretHash ?? "") ? body.secretHash : null,
  };
}

// `store`: the service's; `keys()`: kid → the broker's public keys run tokens are checked with;
// `unknownKey()`: resolves once they were read again (a token naming a key not known yet).
export function createRuns({
  store,
  keys = () => new Map(),
  unknownKey = async () => {},
  now = Date.now,
  log = () => {},
}) {
  const key = (id) => `runs/${id}`;
  const stateKey = (id) => `runs/${id}/state`;
  // id → the run's object in this copy.
  const objects = new Map();

  const event = (fields) =>
    store
      .append(STREAM, { ...fields, at: fields.at ?? now() }, { maxLength: STREAM_MAX })
      .catch((error) => log(`GitHub service: an event (${fields.type}): ${error.message}`));

  // The orchestrator's: `created`, `reruns`, a restored run's from before this service, taken
  // only when the store has none.
  async function put(id, body) {
    const fields = runFields(body);
    if (!fields) return false;
    const before = await store.get(key(id));
    await store.set(key(id), fields, { ttlMs: RUN_TTL_MS });
    if (before?.sandbox && before.sandbox !== fields.sandbox) {
      await store.delete(`sandboxes/${before.sandbox}`);
    }
    if (fields.sandbox) await store.set(`sandboxes/${fields.sandbox}`, id, { ttlMs: RUN_TTL_MS });
    if (fields.secretHash) {
      await store.set(`secrets/${fields.secretHash}`, id, { ttlMs: RUN_TTL_MS });
    }
    const list = (value) =>
      Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : [];
    await store.setIfAbsent(
      stateKey(id),
      { created: list(body.created), reruns: list(body.reruns) },
      { ttlMs: RUN_TTL_MS },
    );
    return true;
  }

  async function state(id) {
    return (await store.get(stateKey(id))) ?? null;
  }

  // The run is over: nothing names it any more. → its last state, or null.
  async function end(id) {
    const fields = await store.get(key(id));
    const last = await state(id);
    await store.delete(key(id));
    await store.delete(stateKey(id));
    await store.delete(`inflight/${id}`);
    await store.deleteBlob(`advertised/${id}`);
    if (fields?.sandbox && (await store.get(`sandboxes/${fields.sandbox}`)) === id) {
      await store.delete(`sandboxes/${fields.sandbox}`);
    }
    if (fields?.secretHash) await store.delete(`secrets/${fields.secretHash}`);
    objects.delete(id);
    return last;
  }

  // The run's object, its fields and state as the store has them now; null once it ended.
  async function load(id) {
    if (typeof id !== "string" || !id) return null;
    const [fields, found] = await Promise.all([store.get(key(id)), state(id)]);
    if (!fields) {
      objects.delete(id);
      return null;
    }
    let run = objects.get(id);
    if (!run) {
      run = {
        id,
        // The installation tokens used for it: what its writes are redacted of (the gateway).
        tokens: new Set(),
        note: (message) => void event({ type: "note", run: id, message }),
        pushed: ({ branch, at }) => void event({ type: "pushed", run: id, branch, at }),
        update: (fn) => update(run, fn),
      };
      objects.set(id, run);
    }
    Object.assign(run, fields, {
      created: found?.created ?? [],
      reruns: found?.reruns ?? [],
    });
    return run;
  }

  // `fn(state)` on the latest { created, reruns }, written only if no other change came first
  // (compare-and-set), else applied again to that one. → what `fn` returned; nothing is written
  // when that is falsy. The run's lists are what was written, or found.
  async function update(run, fn) {
    for (;;) {
      const stored = await store.get(stateKey(run.id));
      const current = stored ?? { created: [], reruns: [] };
      const next = structuredClone(current);
      next.created ??= [];
      next.reruns ??= [];
      const result = fn(next);
      if (!result) {
        Object.assign(run, { created: current.created ?? [], reruns: current.reruns ?? [] });
        return result;
      }
      if (await store.compareAndSet(stateKey(run.id), stored, next, { ttlMs: RUN_TTL_MS })) {
        Object.assign(run, { created: next.created, reruns: next.reruns });
        return result;
      }
    }
  }

  // The run a credential names, once checked against the network (or pod) the call came from,
  // as the egress proxy vouches for it (or the listener, relaying): { run, claims } or
  // { status, message }, as the listener's broker answers (broker.mjs check()).
  async function check(credential, sandbox) {
    const unknown = { status: 401, message: "unknown or finished run" };
    if (!credential) return unknown;
    const from = typeof sandbox === "string" ? sandbox : "";
    if (!isToken(credential)) {
      const run = await load(await store.get(`secrets/${hash(credential)}`));
      if (!run) return unknown;
      if (!from || run.sandbox !== from) return { status: 403, message: NOT_ITS_SANDBOX };
      return { run, claims: null };
    }
    const verify = () =>
      verifyToken(credential, { keys: keys(), audience: RUN_AUDIENCE, now: now() });
    let claims;
    try {
      try {
        claims = verify();
      } catch (error) {
        if (!(error instanceof TokenError) || !/unknown key/.test(error.message)) throw error;
        await unknownKey();
        claims = verify();
      }
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      return { status: 401, message: `this run token is refused: ${error.message}` };
    }
    const run = await load(claims.jti);
    if (!run) return unknown;
    if (!from || !claims.sandbox || claims.sandbox !== from) {
      return { status: 403, message: NOT_ITS_SANDBOX };
    }
    return { run, claims };
  }

  // The run whose sandbox the call came from, for a call without a credential (git's first
  // request, a download): the proxy vouches for the sandbox itself, never its engine.
  async function bySandbox(sandbox) {
    if (typeof sandbox !== "string" || !sandbox) return null;
    return load(await store.get(`sandboxes/${sandbox}`));
  }

  // MAX_IN_FLIGHT across the copies: a counter in the store. It expires with a call's longest
  // idle time, from its first call: a copy that stops in the middle of calls leaves them counted
  // that long at most.
  const inFlight = {
    async take(run, max) {
      const n = await store.increment(`inflight/${run.id}`, 1, { ttlMs: IDLE_MS });
      if (n <= max) return true;
      await inFlight.release(run);
      return false;
    },
    async release(run) {
      const n = await store.increment(`inflight/${run.id}`, -1, { ttlMs: IDLE_MS });
      // Counted again after it expired: from nothing.
      if (n < 0) await store.increment(`inflight/${run.id}`, -n, { ttlMs: IDLE_MS });
    },
  };

  // What GitHub advertised to the run's git (../listener/github-forks.mjs `shared`): appended
  // to one blob per run, as JSON lines.
  const advertised = {
    async save(run, repo, entries) {
      const lines = entries.map(([oid, kind]) => `${JSON.stringify([repo, oid, kind])}\n`);
      await store.appendBlob(`advertised/${run.id}`, lines.join(""));
    },
    async load(run, repo) {
      const blob = await store.readBlob(`advertised/${run.id}`);
      if (!blob) return [];
      const found = [];
      for (const line of blob.toString("utf8").split("\n")) {
        try {
          const [at, oid, kind] = JSON.parse(line);
          if (at === repo) found.push([oid, kind]);
        } catch {
          // A blank line, or one cut short.
        }
      }
      return found;
    },
  };

  // The reactions the listener added (../listener/comments.mjs), which a run never removes:
  // noted before GitHub is asked, so that no run's removal through either copy slips in between.
  const claimKey = (repo, subject, content) =>
    `claims/${String(repo).toLowerCase()} ${subject} ${content}`;
  async function claim(repo, subject, content, held) {
    if (held) await store.set(claimKey(repo, subject, content), now(), { ttlMs: CLAIM_TTL_MS });
    else await store.delete(claimKey(repo, subject, content));
  }
  async function reacted(repo, subject, content) {
    return (await store.get(claimKey(repo, subject, content))) !== null;
  }

  return {
    put,
    state,
    end,
    load,
    check,
    bySandbox,
    inFlight,
    advertised,
    claim,
    reacted,
    event,
  };
}
