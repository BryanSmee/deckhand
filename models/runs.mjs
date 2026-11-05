// Whose a sandbox's agent call is, as the models service tells (#504), and what it keeps of each
// run's calls. A call carries its run's agent token (lib/tokens.mjs AGENT_AUDIENCE), checked here
// offline with the broker's public keys, and the network (or pod) it came from, which the egress
// proxy (or the listener, relaying) vouches for (lib/broker-client.mjs SANDBOX_HEADER): the
// token only works from the sandbox it is bound to. Its `agent` claim says which provider, and
// which of its credentials, the run may use: a run of one agent never gets another's.
//
// The broker is asked whether the run still goes (GET /runs/:id), every RECORD_MS at most: an
// ended run's token opens nothing. Its record also names the provider of a token signed before
// tokens had an `agent` claim (a sandbox that outlived the update).
//
// What changes during a run (its provider's last status, when a plan's limit resets, why its last
// call failed) is in the store, by the run's id (GET /runs/:id/api, for the orchestrator's reply
// and fallbacks); the calls refused it go on the `models` stream, for its log.
import { isToken, TokenError, verifyToken, AGENT_AUDIENCE } from "../lib/tokens.mjs";
import { SANDBOX_HEADER } from "../lib/broker-client.mjs";
import { keepLast } from "../lib/capped.mjs";

// What a run's token sent from elsewhere than its sandbox gets.
export const NOT_ITS_SANDBOX = "this run's token only works from its own sandbox";

// How long the broker's word on a run is taken, and how long, the broker away, the last one is.
export const RECORD_MS = 30_000;
export const RECORD_STALE_MS = 10 * 60_000;
// How long a run's API state is kept: as long as its agent token.
export const STATE_TTL_MS = 8 * 24 * 60 * 60_000;

export const STREAM = "models";
const STREAM_MAX = 10_000;
// The runs whose views this copy keeps (their in-flight count, their state as last set).
const MAX_VIEWS = 1000;

export const stateKey = (id) => `api:${id}`;
const EMPTY = { apiStatus: null, apiReset: null, apiError: null };

// `keys`: { get(kid) } → the broker's run keys; `unknownKey()`: read again (a key the copy hasn't
// seen); `record(id)`: the broker's run (GET /runs/:id) → { provider, credential, sandbox }, null
// once it ended; `store`: the service's.
export function createRuns({
  keys,
  unknownKey = async () => {},
  record,
  store,
  now = Date.now,
  log = () => {},
}) {
  const records = new Map(); // id → { at, value }
  const views = new Map(); // id → view()

  // The broker's run, as fresh as RECORD_MS; its last answer while it doesn't answer, for
  // RECORD_STALE_MS. Throws past that.
  async function liveRecord(id) {
    const cached = records.get(id);
    if (cached && now() - cached.at < RECORD_MS) return cached.value;
    try {
      const value = await record(id);
      keepLast(records, id, { at: now(), value }, MAX_VIEWS);
      return value;
    } catch (error) {
      if (cached && now() - cached.at < RECORD_STALE_MS) return cached.value;
      throw error;
    }
  }

  // `field` of the run's stored API state set to `value`, the others left as they are: the other
  // copy (or this one before a restart) may have set them. Written only if nobody changed it
  // meanwhile; else read and merged again.
  // `ifUnset`: only when the store has none (the other copy may have set one).
  async function setField(id, field, value, { ifUnset = false } = {}) {
    for (;;) {
      const before = await store.get(stateKey(id));
      if (before && before[field] === value) return;
      if (ifUnset && before?.[field] != null) return;
      const after = { ...EMPTY, ...before, [field]: value };
      if (await store.compareAndSet(stateKey(id), before, after, { ttlMs: STATE_TTL_MS })) return;
    }
  }

  // Its API state, saved field by field as it changes: a chain per run, so that this copy's last
  // change to a field is the one kept.
  function view(id, provider, credential) {
    const known = views.get(id);
    if (known && known.provider === provider && known.credential === credential) return known;
    const state = { ...EMPTY };
    let chain = Promise.resolve();
    const save = (field, value, options) => {
      chain = chain
        .then(() => setField(id, field, value, options))
        .catch((error) => log(`Models: run ${id}'s API state (${error.message})`));
    };
    const run = {
      id,
      provider,
      credential,
      // What upstream.mjs redacts from the paths it notes, besides the call's token: nothing
      // more here, the GitHub tokens are the listener's.
      tokens: [],
      note(message) {
        store
          .append(STREAM, { type: "note", run: id, message, at: now() }, { maxLength: STREAM_MAX })
          .catch((error) => log(`Models: run ${id}'s note (${error.message})`));
      },
      saved: () => chain,
      // Why its last call failed, unless one is said already, by this copy or the other: a
      // provider's failure stays what the reply quotes, over a path refused after it.
      failedIfUnset(message) {
        if (state.apiError != null) return;
        state.apiError = message;
        save("apiError", message, { ifUnset: true });
      },
    };
    for (const field of Object.keys(state)) {
      Object.defineProperty(run, field, {
        enumerable: true,
        get: () => state[field],
        set: (value) => {
          // Saved even when this copy's own value is the same: the other copy may have changed
          // the stored one since (setField() skips the write when the store has it already).
          state[field] = value;
          save(field, value);
        },
      });
    }
    keepLast(views, id, run, MAX_VIEWS);
    return run;
  }

  // The run an agent call's token names, once checked: { run, claims } or { status, message }.
  // `req`: the call, whose SANDBOX_HEADER the caller vouched for (http.mjs).
  async function check(token, req) {
    const unknown = { status: 401, message: "unknown or finished run" };
    if (!isToken(token)) return unknown;
    const verify = () => verifyToken(token, { keys, audience: AGENT_AUDIENCE, now: now() });
    let claims;
    try {
      try {
        claims = verify();
      } catch (error) {
        // Signed with a key this copy hasn't read yet (the broker's changed): read again.
        if (!(error instanceof TokenError) || !/unknown key/.test(error.message)) throw error;
        await unknownKey();
        claims = verify();
      }
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      return { status: 401, message: `this run token is refused: ${error.message}` };
    }
    const sandbox = String(req.headers[SANDBOX_HEADER] ?? "");
    if (!sandbox || !claims.sandbox || claims.sandbox !== sandbox) {
      return { status: 403, message: NOT_ITS_SANDBOX };
    }
    let found;
    try {
      found = await liveRecord(claims.jti);
    } catch (error) {
      log(`Models: the broker, about run ${claims.jti} (${error.message})`);
      return { status: 503, message: "the broker can't say whether this run still goes" };
    }
    // A token outlives nothing: a run that ended has none that works.
    if (!found) return unknown;
    if (found.sandbox && found.sandbox !== claims.sandbox) {
      return { status: 403, message: NOT_ITS_SANDBOX };
    }
    // The token's claim: none, no provider.
    const agent = claims.agent ?? null;
    const provider = typeof agent?.provider === "string" ? agent.provider : null;
    const credential = typeof agent?.credential === "string" ? agent.credential : null;
    return { run: view(claims.jti, provider, credential), claims };
  }

  // The run's API state (GET /runs/:id/api): what this copy (its saves under way included) or
  // the other saved. The other copy's under way are a few milliseconds' worth: the run's agent
  // has exited by the time the orchestrator asks.
  async function state(id) {
    await views.get(id)?.saved();
    return { ...EMPTY, ...(await store.get(stateKey(id))) };
  }

  return { check, state };
}
