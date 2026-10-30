// Run broker: each run's sandbox holds a run token (run-token.mjs) instead of any GitHub token,
// a JWT the broker signs and renews, and every service checks offline, with the public key: the
// GitHub gateway (github-gateway.mjs), where the egress proxy relays the sandbox's GitHub calls,
// swaps it for a token limited to the run's repo, which the sandbox never sees; the git gateway
// (git-gateway.mjs) lets it push the branches it names; the run's files (run-files.mjs). The
// agents' API endpoints (upstream.mjs) take another token, for their own audience, in place of
// the operator's credential. Served on its own port, which only the runs' networks reach.
//
// A token only works from its own sandbox: its `sandbox` claim is the ID of the run's network
// (Docker) or of its pod (Kubernetes), and each call's is the runner's answer for its source
// address (or the one the egress proxy names when it relays it): a token that leaks, to a
// research run on the open web say, gives another sandbox neither GitHub, a push nor the
// operator's credential. A run's network goes with it, so its tokens die with it too.
//
// What changes during a run (the issues it created, its pushes, the installation tokens it got,
// its provider's last answer) stays here, by the run's id, the token's `jti`.
//
// Runs started before tokens hold a random secret instead, found here by its hash and bound to
// its sandbox by address (sentBy()), until they end: that path goes in a later release
// (docs/architecture.md, Restarts).
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  AGENT_AUDIENCE,
  isToken,
  keyId,
  RUN_AUDIENCE,
  signToken,
  TOKEN_VERSION,
  TokenError,
  verifyToken,
} from "./run-token.mjs";

// What a run's token or secret sent from elsewhere than its sandbox gets.
export const NOT_ITS_SANDBOX = "this run's token only works from its own sandbox";

// A run token's lifetime, and how often the sandbox renews it (../sandbox/deckhand-token): two
// renewals may fail before it expires.
export const TOKEN_TTL_MS = 15 * 60_000;
export const RENEW_EVERY_S = 5 * 60;

// The agent token's: it is in the agent's environment from its start, which a running process
// never reads again, so it can't be renewed. Bound to the run's network or pod as the run token
// is, it dies with the run; this is only a ceiling.
export const AGENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

// How long past its expiry a run token still renews, from its own sandbox and while its run
// lasts: a broker unreachable for longer than a token's life (a slow update, a host reboot)
// leaves the sandbox nothing else to present, so its calls fail until the broker is back, not
// for the rest of the run. As long as the agent token, which outlives a pause of the broker anyway.
export const RENEW_GRACE_MS = 7 * 24 * 60 * 60_000;

// How many of a run's renewed tokens it keeps for redaction (secretsOf()): older ones expired.
const KEPT_TOKENS = 4;

// Secrets are kept by hash: the map never holds a usable one, and lookups don't compare secrets.
// Each run's entry does hold the installation tokens the GitHub gateway used for it (`tokens`),
// for redaction: github-app.mjs caches them anyway.
function hash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

// A key for a broker without one (the tests): new each time, so its tokens die with it.
function ephemeralKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, kid: keyId(publicKey) };
}

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
  // { privateKey, publicKey, kid } (run-token.mjs signingKey()). `keys`: kid → public key, the
  // ones tokens are checked with: the signing key's, and an older one's while keys rotate.
  key = ephemeralKey(),
  keys = new Map([[key.kid, key.publicKey]]),
  now = Date.now,
  random = () => randomBytes(32).toString("hex"),
}) {
  // id → { id, repo, extra, push, mode, branches, sandbox, issued, provider, credential, note,
  // pushed, apiStatus, apiReset, apiError, tokens }: `id`, the run's (its tokens' `jti`),
  // `sandbox`, the network or pod its tokens are bound to (issue()), `agentToken` and `issued`,
  // its agent's token and its last run tokens, the newest last (secretsOf()), `provider`, where the listener sends its agent's API
  // calls (anthropic.mjs; null: nowhere, no credential), `credential`, the one of the
  // provider's it names (`key` for `claude@anthropic:key`; null: the default one), `note`, a
  // line in its log (provide()), `pushed`, what the git gateway calls when GitHub took a push
  // of the run's (watchPushes()), `apiStatus`, the last status that provider answered,
  // `apiReset`, when a plan's limit it hit resets (anthropic.mjs), and `apiError`, why the last
  // call the listener refused or the provider failed did (upstream.mjs): what an error reply
  // adds. `tokens`: the installation tokens the GitHub gateway used for it, which its output
  // must not publish (runs.mjs).
  const runs = new Map();
  // hash(secret) → the same entry, for a run from before tokens (register()'s `secret`).
  const secrets = new Map();

  // `extra`: permissions this run's GitHub calls get beyond or instead of the sandbox's usual
  // ones, or NO_TOKEN (github-app.mjs): none at all, for a research run on the open internet.
  // `push`: whether it may push and change its pull requests, which only work runs do (light
  // runs' pushes would run in the issue's next work run). Decided by the kind of run, not
  // its token: fail closed. `mode`: the run's (modes.mjs), for what the GitHub gateway refuses
  // a review and its writes' ceiling. `issue`: the number of its issue or pull request, and
  // `base`, its repo's default branch, for what its writes may reach (github-writes.mjs), and
  // `created`, the list of the issues it created ({ number, at }), the comments it posted
  // ({ comment, at }) and the reactions it added ({ reaction, at }: github-writes.mjs
  // answered()), which the GitHub gateway adds to: the run's live state's own list, saved with
  // it (restart.mjs), and `reruns`, the same for the GitHub Actions runs it reran
  // ({ run_id, sha, at }). `reason`: why the listener started it itself ("review-fix",
  // "ci-fix", "conflict"), null for a comment's: the policies read it (github-writes.mjs).
  // `id`: the run's (runs.mjs), its tokens' `jti`; a restarted listener passes the same one, so
  // they still name it, with its agent token (`agentToken`), for redaction, and the network or
  // pod they are bound to (`sandbox`), which its renewed ones carry. `secret`: a run's from before tokens, when a restarted listener picks
  // it up; without an `id`, a new one (the tests' runs). → the handle the other calls take: the
  // run's id, or its secret.
  function register(
    repo,
    extra,
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
    } = {},
  ) {
    const run = {
      id: id ?? random(),
      repo: repo.toLowerCase(),
      extra,
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
      sandbox: typeof sandbox === "string" && sandbox ? sandbox : null,
      issued: [],
      agentToken,
      provider: null,
      credential: null,
      apiStatus: null,
      apiReset: null,
      apiError: null,
      tokens: new Set(),
    };
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

  // The provider of the run's agent (agents/), once its settings are read. `note(message)`:
  // a line in the run's log, for the API calls the listener refused it (upstream.mjs).
  // `credential`: the provider's credential the run's entry names, if any (`claude@anthropic:key`).
  function provide(handle, provider, note = null, credential = null) {
    const run = runOf(handle);
    if (run) Object.assign(run, { provider, credential, note });
  }

  // `changed()`: called when the run created an issue, posted a comment, added or removed a
  // reaction, or reran a workflow run (github-writes.mjs answered()), so its saved state keeps it.
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
  // prefixes ending in "*" (branchAllowed()). `fork`: whether a fork's pull request started it,
  // so its code may run there anyway (github-forks.mjs): a work run is checked until it says so.
  // Before issue(): the tokens carry them.
  function allow(handle, branches, fork = false) {
    const run = runOf(handle);
    if (run) Object.assign(run, { branches: run.push ? [...branches] : [], fork: fork === true });
  }

  // A token's claims: what doesn't change during the run, nothing secret.
  function claimsOf(run) {
    return {
      ver: TOKEN_VERSION,
      jti: run.id,
      repo: run.repo,
      mode: run.mode,
      issue: run.issue,
      fork: run.fork,
      branches: run.branches,
      sandbox: run.sandbox,
      caps: [],
    };
  }

  function signed(run, audience, ttlMs) {
    const token = signToken(claimsOf(run), {
      privateKey: key.privateKey,
      kid: key.kid,
      audience,
      ttlMs,
      now: now(),
    });
    if (audience === AGENT_AUDIENCE) run.agentToken = token;
    else run.issued = [...run.issued, token].slice(-KEPT_TOKENS);
    return token;
  }

  // The run's first tokens, once its sandbox's network (or pod) is known: `sandbox`, its ID.
  // → { token, agentToken }: the run token, which the sandbox renews (renew()), and the
  // agent's, for the agents' API endpoints. Throws for a run that ended.
  function issue(handle, sandbox) {
    const run = runOf(handle);
    if (!run) throw new Error("no such run: it ended");
    if (!sandbox) throw new Error("no sandbox to bind the run's tokens to");
    run.sandbox = String(sandbox);
    run.issued = [];
    const agentToken = signed(run, AGENT_AUDIENCE, AGENT_TOKEN_TTL_MS);
    return { token: signed(run, RUN_AUDIENCE, TOKEN_TTL_MS), agentToken };
  }

  // The run a call's credential (a token, or a secret from before tokens) names, once checked:
  // { run, claims } or { status, message }. `from`: the call (its request: the address is
  // clientOf()'s, the one the egress proxy names for a call it relayed or forwarded) or the
  // address it came from; `audience`: the service's.
  async function check(credential, from, audience = RUN_AUDIENCE, graceMs = 0) {
    const ip = typeof from === "string" ? from : from ? await clientOf(from) : "";
    const unknown = { status: 401, message: "unknown or finished run" };
    if (!credential) return unknown;
    if (!isToken(credential)) {
      const run = secrets.get(hash(credential));
      if (!run) return unknown;
      if (!(await sentBy(run, null, ip))) return { status: 403, message: NOT_ITS_SANDBOX };
      return { run, claims: null };
    }
    let claims;
    try {
      claims = verifyToken(credential, { keys, audience, now: now(), graceMs });
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

  // A new run token for the one the sandbox holds, checked as any call's, but taken up to
  // RENEW_GRACE_MS past its expiry: { token } or { status, message }. An ended run's is refused
  // (check()). `from`: as check()'s. The new one is bound where the one presented was, which
  // check() just compared with the call's network: a restarted listener's record of the run
  // doesn't know it before.
  async function renew(token, from) {
    if (!isToken(token)) return { status: 401, message: "only a run token is renewed" };
    const checked = await check(token, from, RUN_AUDIENCE, RENEW_GRACE_MS);
    if (!checked.run) return checked;
    const { run, claims } = checked;
    run.sandbox ??= claims.sandbox;
    // Redacted too: after a restart, the one the sandbox held was in no list yet.
    if (!run.issued.includes(token)) run.issued = [...run.issued, token].slice(-KEPT_TOKENS);
    return { token: signed(run, RUN_AUDIENCE, TOKEN_TTL_MS) };
  }

  // The tokens signed for the run that its output must not publish (runs.mjs).
  function secretsOf(handle) {
    const run = runOf(handle);
    return run ? [run.agentToken, ...run.issued].filter(Boolean) : [];
  }

  // Whether `req` comes from `run`'s own sandbox: its source address, not just the secret.
  // `ip`: the sandbox's address, when the caller already has it; else clientOf()'s, the one the
  // egress proxy vouches for when the call came through it. For the secrets of runs from before
  // tokens.
  async function sentBy(run, req, ip) {
    ip ??= await clientOf(req);
    return !!ip && (await sentFrom(run, ip)) === true;
  }

  function revoke(handle) {
    const run = runOf(handle);
    if (!run) return;
    runs.delete(run.id);
    if (run.secret) secrets.delete(run.secret);
  }

  return {
    register,
    allow,
    provide,
    watchPushes,
    watchChanges,
    issue,
    check,
    renew,
    secretsOf,
    revoke,
    runOf,
    sentBy,
    size: () => runs.size,
  };
}
