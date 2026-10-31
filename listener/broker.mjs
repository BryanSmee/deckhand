// The listener's side of the runs' tokens: each run's sandbox holds a run token
// (lib/tokens.mjs) instead of any GitHub token, a JWT the broker service signs and renews
// (../broker/, #505), which alone holds the signing key; the listener checks it offline, with
// the broker's public keys: the GitHub gateway (github-gateway.mjs), where the egress proxy
// relays the sandbox's GitHub calls, swaps it for a token limited to the run's repo, which the
// sandbox never sees; the git gateway (git-gateway.mjs) lets it push the branches it names. The
// models service's agent endpoints (../models/) take another token, for their own audience, in
// place of the operator's credential.
//
// A token only works from its own sandbox: its `sandbox` claim is the ID of the run's network
// (Docker) or of its pod (Kubernetes), and each call's is the runner's answer for its source
// address (or the one the egress proxy names when it relays it): a token that leaks, to a
// research run on the open web say, gives another sandbox neither GitHub, a push nor the
// operator's credential. A run's network goes with it, so its tokens die with it too.
//
// What changes during a run (the issues it created, its pushes, the installation tokens it got,
// its provider's last answer) stays here, by the run's id, the token's `jti`. Its first tokens
// come from the broker service (`issuer`), which is told when the run ends.
//
// Runs started before tokens hold a random secret instead, found here by its hash and bound to
// its sandbox by address (sentBy()), until they end: that path goes in a later release
// (docs/architecture.md, Restarts).
import { createHash, randomBytes } from "node:crypto";
import { isToken, RUN_AUDIENCE, TokenError, verifyToken } from "../lib/tokens.mjs";

// What a run's token or secret sent from elsewhere than its sandbox gets.
export const NOT_ITS_SANDBOX = "this run's token only works from its own sandbox";

// A token's `exp` (ms), unchecked: for the list of a run's tokens to redact, never to trust one.
function expOf(token) {
  try {
    const exp = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url")).exp;
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// Secrets are kept by hash: the map never holds a usable one, and lookups don't compare secrets.
// Each run's entry does hold the installation tokens the GitHub gateway used for it (`tokens`),
// for redaction: github-app.mjs caches them anyway.
function hash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

// Where a broker without the broker service gets its tokens (the tests that sign none): nowhere.
export const NO_ISSUER = {
  issue: async () => {
    throw new Error("no broker service to sign the run's tokens");
  },
  put: async () => {},
  end: async () => {},
};

// Where a broker without the github service tells its runs: nowhere.
export const NO_GATEWAY = { put: async () => {}, end: async () => {} };

// Whether `branch` (without refs/heads/) is one of `patterns`: the same name, or one that
// starts with a pattern's text before its final "*" ("issue-12-*"). Case-sensitive, as git is.
export function branchAllowed(patterns, branch) {
  if (!branch) return false;
  return patterns.some((p) =>
    p.endsWith("*")
      ? branch.length > p.length - 1 && branch.startsWith(p.slice(0, -1))
      : branch === p,
  );
}

// A request's source address, without IPv4's IPv6 prefix.
export function addressOf(req) {
  return (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
}

export function createBroker({
  // (run, address) → whether that address is the run's sandbox's or its engine's
  // (broker-http.mjs runAt()), for the secrets of runs from before tokens. None: every such
  // request is refused.
  sentFrom = async () => false,
  // req → the address of the sandbox that sent it: the one the egress proxy names when it
  // relayed or forwarded the call (broker-http.mjs clientAddress()), else its source address.
  clientOf = async (req) => addressOf(req),
  // address → the ID of the network (or pod) it is on, as the runner tells (runner/), or null:
  // what binds a token to its sandbox. None: every token is refused.
  sandboxOf = async () => null,
  // The broker service (broker-service.mjs createBrokerService()): { issue(id, fields) →
  // { token, agentToken }, put(id, fields), end(id) }.
  issuer = NO_ISSUER,
  // The github service (../github/client.mjs runs), which serves the runs' GitHub and git
  // calls: { put(id, fields), end(id) }, told each run with what its gateways check, once its
  // sandbox is known, and its end. None: nowhere (the tests').
  gateway = NO_GATEWAY,
  // () → kid → public key: what run tokens are checked with, the broker service's (and a key
  // of the listener's from before it, while its tokens may still be presented).
  keys = () => new Map(),
  // () → a promise, once the keys were read again: called when a token names an unknown key.
  unknownKey = async () => {},
  now = Date.now,
  random = () => randomBytes(32).toString("hex"),
}) {
  // id → { id, repo, push, mode, branches, sandbox, issued, provider, credential, note,
  // pushed, tokens }: `id`, the run's (its tokens' `jti`),
  // `sandbox`, the network or pod its tokens are bound to (issue()), `agentToken` and `issued`,
  // its agent's token and its run tokens still valid ({ token, exp, at }), the newest last
  // (secretsOf()), `provider`, where the models service sends its agent's API calls
  // (../models/anthropic.mjs; null: nowhere, no credential), `credential`, the one of the
  // provider's it names (`key` for `claude@anthropic:key`; null: the default one), both
  // claimed by its tokens, `note`, a line in its log (provide()), `pushed`, what the git
  // gateway calls when GitHub took a push of the run's (watchPushes()). `tokens`: the
  // installation tokens the GitHub gateway used for it, which its output must not publish
  // (runs.mjs).
  const runs = new Map();
  // hash(secret) → the same entry, for a run from before tokens (register()'s `secret`).
  const secrets = new Map();

  // What its token reads is its capabilities' (`caps`, github-app.mjs readsOf()); each write
  // the GitHub gateway checked gets the one permission it needs besides (github-writes.mjs
  // writePermissions()).
  // `push`: whether it may push and change its pull requests whatever its capabilities: a run
  // saved before capabilities, restarted (restart.mjs), as its kind of run said; the others
  // push only with the `push` capability (grant()). Not its token's to say: fail closed. `mode`: the run's (modes.mjs), for what the GitHub gateway refuses
  // a review and the policies' input (`allow_github`, `allow_push`). `issue`: the number of its issue or pull request, and
  // `base`, its repo's default branch, for what its writes may reach (github-writes.mjs), and
  // `created`, the list of the issues it created ({ number, at }), the comments it posted
  // ({ comment, at }) and the reactions it added ({ reaction, at }: github-writes.mjs
  // answered()), which the GitHub gateway adds to: the run's live state's own list, saved with
  // it (restart.mjs), and `reruns`, the same for the GitHub Actions runs it reran
  // ({ run_id, sha, at }). `reason`: why the listener started it itself ("review-fix",
  // "ci-fix", "conflict"), null for a comment's: the policies read it (github-writes.mjs).
  // `id`: the run's (runs.mjs), its tokens' `jti`; a restarted listener passes the same one, so
  // they still name it, with its agent token (`agentToken`) and run tokens (`issued`), for
  // redaction, and the network or
  // pod they are bound to (`sandbox`), which its renewed ones carry. `secret`: a run's from before tokens, when a restarted listener picks
  // it up; without an `id`, a new one (the tests' runs). → the handle the other calls take: the
  // run's id, or its secret.
  function register(
    repo,
    {
      push = false,
      mode = null,
      issue = null,
      base = null,
      created = [],
      reruns = [],
      reason = null,
      id = null,
      secret = id ? null : random(),
      agentToken = null,
      sandbox = null,
      issued = [],
      caps = null,
    } = {},
  ) {
    const run = {
      id: id ?? random(),
      repo: repo.toLowerCase(),
      push: push === true,
      mode,
      issue: Number.isInteger(issue) ? issue : null,
      base,
      created: Array.isArray(created) ? created : [],
      reruns: Array.isArray(reruns) ? reruns : [],
      reason: typeof reason === "string" ? reason : null,
      // No branch until allow() names them: a run that can push still pushes nothing else.
      branches: [],
      fork: false,
      // Its capabilities (capabilities.mjs), once its start decided them (grant()); a restarted
      // run's as saved (restart.mjs). None until then: its token reads nothing, nor clones.
      caps: [],
      decided: false,
      sandbox: typeof sandbox === "string" && sandbox ? sandbox : null,
      issued: (Array.isArray(issued) ? issued : [])
        .filter(isToken)
        .map((token) => ({ token, exp: expOf(token), at: 0 })),
      agentToken,
      provider: null,
      credential: null,
      tokens: new Set(),
    };
    if (Array.isArray(caps)) withCaps(run, caps);
    runs.set(run.id, run);
    if (secret) {
      run.secret = hash(secret);
      secrets.set(run.secret, run);
    }
    return secret ?? run.id;
  }

  // The live run of a handle (register()'s), or undefined. For the listener's own lookups
  // only: a service finds a call's run with check(), as a run's id is no secret.
  function runOf(handle) {
    if (!handle) return undefined;
    return runs.get(handle) ?? secrets.get(hash(handle));
  }

  // The provider of the run's agent (agents/), once its settings are read: before issue(), its
  // tokens claim it. `note(message)`: a line in the run's log, for the calls the GitHub gateway
  // or the models service refused it (models-service.mjs consume()).
  // `credential`: the provider's credential the run's entry names, if any (`claude@anthropic:key`).
  function provide(handle, provider, note = null, credential = null) {
    const run = runOf(handle);
    if (run) Object.assign(run, { provider, credential, note });
  }

  // `changed()`: called when the run created an issue, posted a comment, added or removed a
  // reaction, or reran a workflow run (github-writes.mjs answered()), or got a new run token
  // (keep()), so its saved state keeps it.
  function watchChanges(handle, changed) {
    const run = runOf(handle);
    if (run) run.changed = changed;
  }

  // `pushed({ branch, at })`: called by the git gateway for each push of the run's GitHub took.
  function watchPushes(handle, pushed) {
    const run = runOf(handle);
    if (run) run.pushed = pushed;
  }

  // The branches a run may push and whose pull requests it may mark ready: names, or
  // prefixes ending in "*" (branchAllowed()), none for a run that neither may push (`push`, a
  // work run) nor has the `push` capability (grant(), before this): preparation.mjs passes none
  // without it. `fork`: whether a fork's pull request started it, so its code may run there anyway
  // (github-forks.mjs): a work run is checked until it says so. Before issue(): the tokens carry
  // them.
  function allow(handle, branches, fork = false) {
    const run = runOf(handle);
    if (!run) return;
    const push = run.push || run.caps.includes("push");
    Object.assign(run, { branches: push ? [...branches] : [], fork: fork === true });
  }

  // The capabilities the run's start decided (capabilities.mjs outcomeOf()'s `used`), which its
  // tokens carry (`caps`). Before issue().
  function grant(handle, caps) {
    const run = runOf(handle);
    if (run) withCaps(run, caps);
  }

  // What its token reads follows them (github-app.mjs readsOf()), and a run without `pull` gets
  // nothing from GitHub at all (github-gateway.mjs).
  // `decided`: whether they are (a run before grant() has none yet, which says nothing of them).
  function withCaps(run, caps) {
    run.caps = caps.filter((c) => typeof c === "string");
    run.decided = true;
  }

  // What the broker service is told of the run: what its tokens claim, the network or pod they
  // are bound to, and its screenshots' folder (`shots`, uploads go there).
  function fieldsOf(run) {
    return {
      repo: run.repo,
      mode: run.mode,
      issue: run.issue,
      fork: run.fork,
      branches: run.branches,
      sandbox: run.sandbox,
      shots: run.shots ?? null,
      caps: run.caps,
      // Its agent's provider and credential (provide()), which its agent token claims: the
      // models service gives its calls that one alone (../models/runs.mjs).
      provider: run.provider,
      credential: run.credential,
    };
  }

  // What the github service is told of the run (../github/runs.mjs runFields()): what its
  // gateways check its calls against, the network or pod its calls come from, and, for a run
  // from before tokens, its secret's hash (never the secret). `created` and `reruns`: taken only
  // when the service has none (a run restored from before it).
  function gatewayFields(run) {
    return {
      repo: run.repo,
      push: run.push,
      mode: run.mode,
      issue: run.issue,
      base: run.base,
      reason: run.reason,
      branches: run.branches,
      fork: run.fork,
      caps: run.caps,
      decided: run.decided,
      sandbox: run.sandbox,
      secretHash: run.secret ?? null,
      created: run.created,
      reruns: run.reruns,
    };
  }

  // A run token the sandbox was handed, in the run's list (secretsOf()), saved with the run's
  // state (changed()), so a restart still redacts it. The ones it renews come from the broker
  // service alone: redact() knows their shape.
  function keep(run, token, at) {
    run.issued = [...run.issued.filter((t) => t.token !== token), { token, exp: expOf(token), at }];
    run.changed?.();
  }

  // The run's first tokens, from the broker service, once its sandbox's network (or pod) is
  // known: `sandbox`, its ID; `shots`, its screenshots' folder (null: none). → { token,
  // agentToken }: the run token, which the sandbox renews with the broker service, and the
  // agent's, for the agents' API endpoints. Throws for a run that ended, or a broker service
  // that refused.
  async function issue(handle, sandbox, shots = null) {
    const run = runOf(handle);
    if (!run) throw new Error("no such run: it ended");
    if (!sandbox) throw new Error("no sandbox to bind the run's tokens to");
    run.sandbox = String(sandbox);
    run.shots = shots;
    run.issued = [];
    const { token, agentToken } = await issuer.issue(run.id, fieldsOf(run));
    // Ended meanwhile: its tokens name nothing.
    if (runOf(handle) !== run) {
      issuer.end(run.id).catch(() => {});
      throw new Error("no such run: it ended");
    }
    run.agentToken = agentToken;
    keep(run, token, now());
    // Before the sandbox starts: its first GitHub call finds its run there.
    await gateway.put(run.id, gatewayFields(run));
    return { token, agentToken };
  }

  // A run a restarted listener picked up: the broker service is told it still goes, with what
  // its tokens claim, so they still renew there (a run from before the broker service, whose
  // listener signed them, too). A run from before tokens has nothing there.
  async function restore(handle, shots = null) {
    const run = runOf(handle);
    if (!run) return;
    await gateway.put(run.id, gatewayFields(run));
    if (run.secret) return;
    run.shots = shots;
    // The hashes of the tokens it handed the sandbox, for the broker's rule past their expiry
    // (only the newest renews), should it not have the run yet.
    const issued = run.issued.map((t) => ({ hash: hash(t.token), exp: t.exp }));
    await issuer.put(run.id, { ...fieldsOf(run), issued });
  }

  // The run a call's credential (a token, or a secret from before tokens) names, once checked:
  // { run, claims } or { status, message }. `from`: the call (its request: the address is
  // clientOf()'s, the one the egress proxy names for a call it relayed or forwarded) or the
  // address it came from; `audience`: the service's.
  async function check(credential, from, audience = RUN_AUDIENCE) {
    const ip = typeof from === "string" ? from : from ? await clientOf(from) : "";
    const unknown = { status: 401, message: "unknown or finished run" };
    if (!credential) return unknown;
    if (!isToken(credential)) {
      const run = secrets.get(hash(credential));
      if (!run) return unknown;
      if (!(await sentBy(run, null, ip))) return { status: 403, message: NOT_ITS_SANDBOX };
      return { run, claims: null };
    }
    const verify = () => verifyToken(credential, { keys: keys(), audience, now: now() });
    let claims;
    try {
      try {
        claims = verify();
      } catch (error) {
        // Signed with a key the listener doesn't have yet (the broker's changed): read again.
        if (!(error instanceof TokenError) || !/unknown key/.test(error.message)) throw error;
        await unknownKey();
        claims = verify();
      }
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      return { status: 401, message: `this run token is refused: ${error.message}` };
    }
    // A token outlives nothing: a run that ended has none that works.
    const run = runs.get(claims.jti);
    if (!run) return unknown;
    if (!ip || !claims.sandbox || (await sandboxOf(ip)) !== claims.sandbox) {
      return { status: 403, message: NOT_ITS_SANDBOX };
    }
    return { run, claims };
  }

  // The tokens signed for the run that its output must not publish (runs.mjs).
  function secretsOf(handle) {
    const run = runOf(handle);
    return run ? [run.agentToken, ...run.issued.map((t) => t.token)].filter(Boolean) : [];
  }

  // Its run tokens alone, for its saved state (restart.mjs): after a restart, the one the sandbox
  // holds is redacted before it is next renewed.
  function issuedOf(handle) {
    return (runOf(handle)?.issued ?? []).map((t) => t.token);
  }

  // Whether `req` comes from `run`'s own sandbox: its source address, not just the secret.
  // `ip`: the sandbox's address, when the caller already has it; else clientOf()'s, the one the
  // egress proxy vouches for when the call came through it. For the secrets of runs from before
  // tokens.
  async function sentBy(run, req, ip) {
    ip ??= await clientOf(req);
    return !!ip && (await sentFrom(run, ip)) === true;
  }

  // The run is over: its tokens and secret name nothing here from now on, and the broker
  // service is told (`issuer.end()`, which tries again until it hears), so they renew nowhere.
  function revoke(handle) {
    const run = runOf(handle);
    if (!run) return Promise.resolve();
    runs.delete(run.id);
    if (run.secret) secrets.delete(run.secret);
    gateway.end(run.id);
    return run.secret ? Promise.resolve() : issuer.end(run.id);
  }

  return {
    register,
    allow,
    grant,
    provide,
    watchPushes,
    watchChanges,
    issue,
    restore,
    check,
    secretsOf,
    issuedOf,
    revoke,
    runOf,
    gatewayFields: (handle) => (runOf(handle) ? gatewayFields(runOf(handle)) : null),
    sentBy,
    size: () => runs.size,
  };
}
