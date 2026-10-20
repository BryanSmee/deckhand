// Token broker: a run lasts longer than an installation token (1 h), so a sandbox never
// gets one up front. Its git credential helper and gh wrapper (../sandbox/) ask here, with
// the run's secret, for a fresh token limited to the run's repo. The secret dies with the
// run. Served on its own port, which only the runs' networks reach.
//
// Those tokens only read the code: pushes go through the listener's git gateway
// (git-gateway.mjs), which finds the run here by the same secret, with the branches it may
// push (allow()).
//
// A secret only works from its own run's sandbox (or engine): one that leaks, to a research run
// on the open web say, gives another sandbox neither a token nor a push (sentBy()).
import { createHash, randomBytes } from "node:crypto";
import { NO_TOKEN } from "./github-app.mjs";
import { send } from "./web.mjs";

// What a run's secret sent from elsewhere than its sandbox gets.
export const NOT_ITS_SANDBOX = "this run's secret only works from its own sandbox";

// Secrets are kept by hash: the map never holds a usable one, and lookups don't compare secrets.
// Each run's entry does hold the installation tokens it already got (`tokens`), for redaction:
// github-app.mjs caches them anyway.
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

export function createBroker({
  app, // () => the GitHub App (github-app.mjs), or null before /setup
  // (run, address) → whether that address is the run's sandbox's or its engine's
  // (broker-http.mjs runAt()). None: every request is refused.
  sentFrom = async () => false,
  random = () => randomBytes(32).toString("hex"),
  log = () => {},
}) {
  // hash(secret) → { repo, extra, push, branches, provider, note, apiStatus, apiError, tokens }:
  // `provider`, where the listener sends its agent's API calls (anthropic.mjs; null: nowhere,
  // no credential), `note`, a line in its log (provide()), `apiStatus`, the last status that
  // provider answered, and `apiError`, why the last call the listener refused or the provider
  // failed did (upstream.mjs): what an error reply adds.
  // `tokens`: the installation tokens it got, which its output must not publish (runs.mjs).
  const runs = new Map();

  // `extra`: permissions this run's token gets beyond or instead of the sandbox's usual ones,
  // or NO_TOKEN (github-app.mjs): none at all, for a research run on the open internet.
  // `push`: whether it may push and change its pull requests, which only work runs do (light
  // runs' pushes would run in the issue's next work run). Decided by the kind of run, not
  // its token: fail closed. `secret`: a run's own again, when a restarted listener picks it up.
  function register(repo, extra, { push = false, secret = random() } = {}) {
    // No branch until allow() names them: a run that can push still pushes nothing else.
    runs.set(hash(secret), {
      repo: repo.toLowerCase(),
      extra,
      push: push === true,
      branches: [],
      provider: null,
      apiStatus: null,
      apiError: null,
      tokens: new Set(),
    });
    return secret;
  }

  // The provider of the run's agent (agents/), once its settings are read. `note(message)`:
  // a line in the run's log, for the API calls the listener refused it (upstream.mjs).
  function provide(secret, provider, note = null) {
    const run = runOf(secret);
    if (run) Object.assign(run, { provider, note });
  }

  // The branches a run may push and whose pull requests it may mark ready: names, or
  // prefixes ending in "*" (branchAllowed()).
  function allow(secret, branches) {
    const run = runOf(secret);
    if (run) run.branches = run.push ? [...branches] : [];
  }

  // The live run a secret belongs to, or undefined.
  function runOf(secret) {
    return secret ? runs.get(hash(secret)) : undefined;
  }

  // Whether `req` comes from `run`'s own sandbox: its source address, not just the secret.
  async function sentBy(run, req) {
    const ip = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
    return !!ip && (await sentFrom(run, ip)) === true;
  }

  function revoke(secret) {
    if (secret) runs.delete(hash(secret));
  }

  async function handle(req, res) {
    if (req.method !== "GET" || new URL(req.url, "http://broker").pathname !== "/token") {
      return send(res, 404, { error: "not found" });
    }
    const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
    const run = scheme === "Bearer" ? runOf(secret) : undefined;
    if (!run) return send(res, 401, { error: "unknown or finished run" });
    if (!(await sentBy(run, req))) return send(res, 403, { error: NOT_ITS_SANDBOX });
    const { repo, extra } = run;
    if (extra === NO_TOKEN) return send(res, 403, { error: "this run gets no GitHub token" });
    const github = app();
    if (!github) return send(res, 503, { error: "the GitHub App is not set up" });
    try {
      const { token, expiresAt } = await github.repoToken(repo, extra);
      run.tokens.add(token);
      send(res, 200, {
        token,
        expires_at: new Date(expiresAt).toISOString(),
        repo,
      });
    } catch (error) {
      log(`Broker: token for ${repo}: ${error.message ?? error}`);
      send(res, 502, { error: "GitHub refused the token" });
    }
  }

  return { register, allow, provide, revoke, runOf, sentBy, handle, size: () => runs.size };
}
