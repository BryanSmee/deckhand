// Run broker: each run gets a secret, which its sandbox holds instead of any GitHub token. The
// listener finds the run by it: the GitHub gateway (github-gateway.mjs), where the egress
// proxy relays the sandbox's GitHub calls, swaps it for a token limited to the run's repo, which
// the sandbox never sees; the agents' API endpoints (upstream.mjs) for the operator's
// credential. The secret dies with the run. Served on its own port, which only the runs'
// networks reach.
//
// Pushes go through the listener's git gateway (git-gateway.mjs), which finds the run here by
// the same secret, with the branches it may push (allow()).
//
// A secret only works from its own run's sandbox (or engine): one that leaks, to a research run
// on the open web say, gives another sandbox neither GitHub, a push nor the operator's
// credential (sentBy()).
import { createHash, randomBytes } from "node:crypto";

// What a run's secret sent from elsewhere than its sandbox gets.
export const NOT_ITS_SANDBOX = "this run's secret only works from its own sandbox";

// Secrets are kept by hash: the map never holds a usable one, and lookups don't compare secrets.
// Each run's entry does hold the installation tokens the GitHub gateway used for it (`tokens`),
// for redaction: github-app.mjs caches them anyway.
function hash(secret) {
  return createHash("sha256").update(secret).digest("hex");
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
  // (broker-http.mjs runAt()). None: every request is refused.
  sentFrom = async () => false,
  random = () => randomBytes(32).toString("hex"),
}) {
  // hash(secret) → { repo, extra, push, mode, branches, provider, credential, note, pushed,
  // apiStatus, apiReset, apiError, tokens }: `provider`, where the listener sends its agent's API calls
  // (anthropic.mjs; null: nowhere, no credential), `credential`, the one of the provider's it
  // names (`key` for `claude@anthropic:key`; null: the default one), `note`, a line in its log (provide()), `pushed`, what the git
  // gateway calls when GitHub took a push of the run's (watchPushes()), `apiStatus`, the last
  // status that provider answered, `apiReset`, when a plan's limit it hit resets (anthropic.mjs),
  // and `apiError`, why the last call the listener refused or the provider
  // failed did (upstream.mjs): what an error reply adds.
  // `tokens`: the installation tokens the GitHub gateway used for it, which its output must not
  // publish (runs.mjs).
  const runs = new Map();

  // `extra`: permissions this run's GitHub calls get beyond or instead of the sandbox's usual
  // ones, or NO_TOKEN (github-app.mjs): none at all, for a research run on the open internet.
  // `push`: whether it may push and change its pull requests, which only work runs do (light
  // runs' pushes would run in the issue's next work run). Decided by the kind of run, not
  // its token: fail closed. `mode`: the run's (modes.mjs), for what the GitHub gateway refuses
  // a review and its writes' ceiling. `issue`: the number of its issue or pull request, and
  // `base`, its repo's default branch, for what its writes may reach (github-writes.mjs), and
  // `created`, the list of the issues it created ({ number, at }), which the GitHub gateway adds
  // to: the run's live state's own list, saved with it (restart.mjs). `reason`: why the listener
  // started it itself ("review-fix", "ci-fix", "conflict"), null for a comment's: the policies
  // read it (github-writes.mjs).
  // `secret`: a run's own again, when a restarted listener picks it up.
  function register(
    repo,
    extra,
    {
      push = false,
      mode = null,
      issue = null,
      base = null,
      created = [],
      reason = null,
      secret = random(),
    } = {},
  ) {
    // No branch until allow() names them: a run that can push still pushes nothing else.
    runs.set(hash(secret), {
      repo: repo.toLowerCase(),
      extra,
      push: push === true,
      mode,
      issue: Number.isInteger(issue) ? issue : null,
      base,
      created: Array.isArray(created) ? created : [],
      reason: typeof reason === "string" ? reason : null,
      branches: [],
      fork: false,
      provider: null,
      credential: null,
      apiStatus: null,
      apiReset: null,
      apiError: null,
      tokens: new Set(),
    });
    return secret;
  }

  // The provider of the run's agent (agents/), once its settings are read. `note(message)`:
  // a line in the run's log, for the API calls the listener refused it (upstream.mjs).
  // `credential`: the provider's credential the run's entry names, if any (`claude@anthropic:key`).
  function provide(secret, provider, note = null, credential = null) {
    const run = runOf(secret);
    if (run) Object.assign(run, { provider, credential, note });
  }

  // `changed()`: called when the run created an issue (github-writes.mjs answered()), so its
  // saved state keeps it.
  function watchCreated(secret, changed) {
    const run = runOf(secret);
    if (run) run.createdChanged = changed;
  }

  // `pushed({ branch, at })`: called by the git gateway for each push of the run's GitHub took.
  function watchPushes(secret, pushed) {
    const run = runOf(secret);
    if (run) run.pushed = pushed;
  }

  // The branches a run may push and whose pull requests it may mark ready: names, or
  // prefixes ending in "*" (branchAllowed()). `fork`: whether a fork's pull request started it,
  // so its code may run there anyway (github-forks.mjs): a work run is checked until it says so.
  function allow(secret, branches, fork = false) {
    const run = runOf(secret);
    if (run) Object.assign(run, { branches: run.push ? [...branches] : [], fork: fork === true });
  }

  // The live run a secret belongs to, or undefined.
  function runOf(secret) {
    return secret ? runs.get(hash(secret)) : undefined;
  }

  // Whether `req` comes from `run`'s own sandbox: its source address, not just the secret.
  // `ip`: the sandbox's address the egress proxy vouches for, when it relayed the call
  // (broker-http.mjs clientAddress()).
  async function sentBy(run, req, ip = addressOf(req)) {
    return !!ip && (await sentFrom(run, ip)) === true;
  }

  function revoke(secret) {
    if (secret) runs.delete(hash(secret));
  }

  return {
    register,
    allow,
    provide,
    watchPushes,
    watchCreated,
    revoke,
    runOf,
    sentBy,
    size: () => runs.size,
  };
}
