// The operator's GitHub App: signs its JWT, finds the installation of a repo and mints
// installation tokens. The listener calls GitHub with them, and the broker (broker.mjs)
// hands sandboxes tokens limited to their run's repo.
import { createSign } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What the App asks for when /setup creates it (manifest flow).
export const APP_PERMISSIONS = {
  issues: "write",
  pull_requests: "write",
  contents: "write",
  metadata: "read",
  deployments: "write",
  actions: "read",
  discussions: "write",
};
// What workItem() routes, plus the previews' events (handled by a later hook).
export const APP_EVENTS = [
  "issue_comment",
  "discussion",
  "discussion_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "workflow_run",
];
// A sandbox gets less than the App: no deployments, nothing outside its repo.
export const SANDBOX_PERMISSIONS = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
  actions: "read",
};
// Added for discussion runs only: an App created before discussions keeps working elsewhere.
export const DISCUSSION_PERMISSIONS = { discussions: "write" };
// A repo's light modes (its config's `modes:`) only comment, and the listener posts their
// reply: their token can read the code, issues and pull requests, not push or write.
export const READ_ONLY_PERMISSIONS = {
  contents: "read",
  issues: "read",
  pull_requests: "read",
};

// Installation tokens last an hour: a cached one is renewed when less than this is left, so
// whoever gets it can use it for at least that long.
export const REFRESH_MS = 10 * 60000;

// --- Credentials: written by /setup, in the data volume ----------------------------------

const FILE = "app.json";

export function loadCredentials(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, FILE), "utf8"));
  } catch {
    return null; // Not set up yet: /setup creates it.
  }
}

// The private key and webhook secret are in there: owner-only, written whole or not at all.
export function saveCredentials(dir, credentials) {
  const path = join(dir, FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// --- The App -----------------------------------------------------------------------------

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubApp({
  credentials,
  api = "https://api.github.com",
  fetch = globalThis.fetch,
  now = Date.now,
  log = () => {},
}) {
  const installations = new Map(); // "owner/repo" → installation id
  const tokens = new Map(); // "<installation>:<repo or *>" → Promise<{ token, expiresAt }>

  function jwt() {
    const seconds = Math.floor(now() / 1000);
    // Backdated a minute for clock drift; GitHub refuses more than 10 minutes ahead.
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iat: seconds - 60,
        exp: seconds + 9 * 60,
        iss: credentials.client_id ?? String(credentials.id),
      }),
    );
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${claims}`)
      .sign(credentials.pem, "base64url");
    return `${header}.${claims}.${signature}`;
  }

  async function call(method, path, auth, body) {
    return fetch(api + path, {
      method,
      headers: {
        authorization: `Bearer ${auth}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "deckhand",
        "x-github-api-version": "2022-11-28",
      },
      body: body && JSON.stringify(body),
    });
  }

  async function json(res, what) {
    if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // Webhook payloads carry the installation: noting it saves a lookup per repo.
  function remember(repo, installationId) {
    if (repo && installationId) installations.set(repo.toLowerCase(), installationId);
  }

  async function installationOf(repo) {
    const key = repo.toLowerCase();
    if (!installations.has(key)) {
      const found = await json(await call("GET", `/repos/${key}/installation`, jwt()), repo);
      installations.set(key, found.id);
    }
    return installations.get(key);
  }

  // `repo`: a token for that repo alone, with the sandbox's permissions (and `extra`); none:
  // the whole installation with the App's, for the listener's own calls.
  function token(installationId, repo, extra = {}) {
    // The levels too: a read-only token is not a writing one.
    const levels = Object.entries(extra).map(([name, level]) => `${name}=${level}`);
    const key = `${installationId}:${repo ?? "*"}:${levels.sort().join(",")}`;
    const cached = tokens.get(key);
    if (cached) {
      const still = cached.then((t) => (t.expiresAt - now() > REFRESH_MS ? t : null));
      return still.then((t) => t ?? mint(key, installationId, repo, extra));
    }
    return mint(key, installationId, repo, extra);
  }

  function mint(key, installationId, repo, extra) {
    const body = repo
      ? {
          repositories: [repo.split("/")[1]],
          permissions: { ...SANDBOX_PERMISSIONS, ...extra },
        }
      : undefined;
    const minted = call("POST", `/app/installations/${installationId}/access_tokens`, jwt(), body)
      .then((res) => json(res, `token for installation ${installationId}`))
      .then((t) => ({ token: t.token, expiresAt: Date.parse(t.expires_at) }));
    tokens.set(key, minted);
    // A failure is not cached: the next call tries again.
    minted.catch(() => tokens.get(key) === minted && tokens.delete(key));
    return minted;
  }

  // A sandbox's token: only its repo, only what a run needs.
  async function repoToken(repo, extra) {
    return token(await installationOf(repo), repo.toLowerCase(), extra);
  }

  // `expected`: error statuses that are normal for this call, so not logged.
  async function request(repo, method, path, body, expected = []) {
    const { token: t } = await token(await installationOf(repo));
    const res = await call(method, path, t, body);
    if (!res.ok && !expected.includes(res.status)) {
      log(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  // Commits come from the App's bot, as GitHub shows them for its own commits.
  function identity() {
    const name = `${credentials.slug}[bot]`;
    const email = credentials.bot_id
      ? `${credentials.bot_id}+${name}@users.noreply.github.com`
      : `${name}@users.noreply.github.com`;
    return { name, email };
  }

  return {
    jwt,
    remember,
    installationOf,
    token,
    repoToken,
    request,
    identity,
    credentials,
  };
}
