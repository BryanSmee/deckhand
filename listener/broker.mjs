// Token broker: a run lasts longer than an installation token (1 h), so a sandbox never
// gets one up front. Its git credential helper and gh wrapper (../sandbox/) ask here, with
// the run's secret, for a fresh token limited to the run's repo. The secret dies with the
// run. Served on its own port, which only the sandboxes' network reaches.
import { createHash, randomBytes } from "node:crypto";

// Kept by hash: the map never holds a usable secret, and lookups don't compare secrets.
function hash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

export function createBroker({
  app, // () => the GitHub App (github-app.mjs), or null before /setup
  random = () => randomBytes(32).toString("hex"),
  log = () => {},
}) {
  const runs = new Map(); // hash(secret) → repo

  function register(repo) {
    const secret = random();
    runs.set(hash(secret), repo.toLowerCase());
    return secret;
  }

  function revoke(secret) {
    if (secret) runs.delete(hash(secret));
  }

  function send(res, status, value) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(value));
  }

  async function handle(req, res) {
    if (req.method !== "GET" || new URL(req.url, "http://broker").pathname !== "/token") {
      return send(res, 404, { error: "not found" });
    }
    const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
    const repo = scheme === "Bearer" && secret ? runs.get(hash(secret)) : undefined;
    if (!repo) return send(res, 401, { error: "unknown or finished run" });
    const github = app();
    if (!github) return send(res, 503, { error: "the GitHub App is not set up" });
    try {
      const { token, expiresAt } = await github.repoToken(repo);
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

  return { register, revoke, handle, size: () => runs.size };
}
