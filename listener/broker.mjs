// Token broker: a run lasts longer than an installation token (1 h), so a sandbox never
// gets one up front. Its git credential helper and gh wrapper (../sandbox/) ask here, with
// the run's secret, for a fresh token limited to the run's repo. The secret dies with the
// run. Served on its own port, which only the sandboxes' network reaches.
//
// Those tokens only read the code: pushes go through the listener's git gateway
// (git-gateway.mjs), which finds the run here by the same secret.
import { createHash, randomBytes } from "node:crypto";
import { sendJson } from "./web.mjs";

// Kept by hash: the map never holds a usable secret, and lookups don't compare secrets.
function hash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

export function createBroker({
  app, // () => the GitHub App (github-app.mjs), or null before /setup
  random = () => randomBytes(32).toString("hex"),
  log = () => {},
}) {
  const runs = new Map(); // hash(secret) → { repo, extra, push }

  // `extra`: permissions this run's token gets beyond or instead of the sandbox's usual ones.
  // `push`: whether it may push and change its pull requests, which only work runs do (light
  // runs' pushes would run in the issue's next work run). Decided by the kind of run, not
  // its token: fail closed. `secret`: a run's own again, when a restarted listener picks it up.
  function register(repo, extra, { push = false, secret = random() } = {}) {
    runs.set(hash(secret), { repo: repo.toLowerCase(), extra, push: push === true });
    return secret;
  }

  // The live run a secret belongs to, or undefined.
  function runOf(secret) {
    return secret ? runs.get(hash(secret)) : undefined;
  }

  function revoke(secret) {
    if (secret) runs.delete(hash(secret));
  }

  const send = (res, status, value) => sendJson(res, value, status);

  async function handle(req, res) {
    if (req.method !== "GET" || new URL(req.url, "http://broker").pathname !== "/token") {
      return send(res, 404, { error: "not found" });
    }
    const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
    const run = scheme === "Bearer" ? runOf(secret) : undefined;
    if (!run) return send(res, 401, { error: "unknown or finished run" });
    const { repo, extra } = run;
    const github = app();
    if (!github) return send(res, 503, { error: "the GitHub App is not set up" });
    try {
      const { token, expiresAt } = await github.repoToken(repo, extra);
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

  return { register, revoke, runOf, handle, size: () => runs.size };
}
