// The operator's GitHub App: signs its JWT, finds the installation of a repo and mints
// installation tokens. The listener calls GitHub with them, and the broker (broker.mjs)
// hands sandboxes tokens limited to their run's repo.
import { createSign } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./store.mjs";

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
// What workItem() routes, plus the previews' events (handled by a later hook), pushes,
// which tell the dashboard's repository list (repos.mjs) a default branch changed, and
// issues: their closing starts the comments waiting for them (waits.mjs), and their open
// questions label them needs-input (questions.mjs).
export const APP_EVENTS = [
  "issues",
  "issue_comment",
  "discussion",
  "discussion_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "workflow_run",
  "push",
];
// The App's settings, read at start (`asApp`, the App's own calls): a warning for each event of
// APP_EVENTS it isn't subscribed to. An App created before a feature lacks its events, and
// nothing else tells the operator (docs/setup.md). Resolves to the missing ones.
export async function checkAppEvents(asApp, log) {
  const res = await asApp("GET", "/app");
  if (!res.ok) return [];
  const { events = [] } = await res.json();
  const missing = APP_EVENTS.filter((e) => !events.includes(e));
  if (missing.length) {
    log(
      `The GitHub App isn't subscribed to ${missing.join(", ")}: turn ${missing.length > 1 ? "them" : "it"} on under Subscribe to events in its settings (docs/setup.md)`,
    );
  }
  return missing;
}

// A sandbox gets less than the App: no deployments, nothing outside its repo, and its code
// read-only. It pushes through the listener's git gateway (git-gateway.mjs), which refuses
// the default branch: GitHub can't be asked to (rulesets aren't enforced on free private
// repos), and a token that writes contents could also push or merge into it directly.
export const SANDBOX_PERMISSIONS = {
  contents: "read",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
  actions: "read",
};
// Built-in light runs (brainstorms, inbox entries, discussions) comment and create issues, and
// never touch a pull request: they can't push either (the broker's `push`).
export const LIGHT_PERMISSIONS = { pull_requests: "read" };
// Added for discussion runs only: an App created before discussions keeps working elsewhere.
export const DISCUSSION_PERMISSIONS = { ...LIGHT_PERMISSIONS, discussions: "write" };
// A research run (modes.mjs) gets no token at all: the broker refuses it one (broker.mjs).
export const NO_TOKEN = false;
// The git gateway's own token for a push it lets through: never handed to a sandbox.
export const PUSH_PERMISSIONS = { contents: "write" };
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

// What every call to GitHub sends (auth.mjs and setup.mjs add to it).
export const GITHUB_HEADERS = Object.freeze({
  accept: "application/vnd.github+json",
  "user-agent": "deckhand",
  "x-github-api-version": "2022-11-28",
});

// --- Credentials: written by /setup, in the data volume ----------------------------------

const FILE = "app.json";

// Null before /setup created it.
export function loadCredentials(dir) {
  return readJson(join(dir, FILE));
}

// The private key and webhook secret are in there: owner-only, written whole or not at all.
export function saveCredentials(dir, credentials) {
  writeJsonAtomic(join(dir, FILE), credentials, { mode: 0o600 });
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
        ...GITHUB_HEADERS,
        authorization: `Bearer ${auth}`,
        "content-type": "application/json",
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

  // As the App itself (its JWT): what lists its installations.
  async function asApp(method, path) {
    const res = await call(method, path, jwt());
    if (!res.ok) log(`GitHub ${method} ${path}: ${res.status} ${await res.clone().text()}`);
    return res;
  }

  // As one installation, with the App's permissions: what lists its repos.
  async function asInstallation(installationId, method, path) {
    const { token: t } = await token(installationId);
    const res = await call(method, path, t);
    if (!res.ok) log(`GitHub ${method} ${path}: ${res.status} ${await res.clone().text()}`);
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
    asApp,
    asInstallation,
    identity,
    credentials,
  };
}
