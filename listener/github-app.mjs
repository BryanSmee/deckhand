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
  // Optional (OPTIONAL_PERMISSIONS): runs read CI with it, and rerun their pull request's failed
  // jobs (github-writes.mjs ACTIONS_WRITE), the only writes it ever gets.
  actions: "write",
  discussions: "write",
  // Only the git gateway's push token carries it, for repos granted `allow_workflows`.
  workflows: "write",
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
// The App's settings page on GitHub (permissions, events, webhook): under the organization
// that owns it, or the user's settings when it isn't one (or isn't known).
export function appSettingsUrl(githubUrl, { slug, owner, ownerType }) {
  const app = encodeURIComponent(slug);
  return ownerType === "Organization" && owner
    ? `${githubUrl}/organizations/${encodeURIComponent(owner)}/settings/apps/${app}`
    : `${githubUrl}/settings/apps/${app}`;
}

// The permissions of APP_PERMISSIONS that `has` (an App's or an installation's, as GitHub lists
// them) lacks, or holds at a lower level: ["actions: read", …].
export function missingPermissions(has = {}, wanted = APP_PERMISSIONS) {
  return Object.entries(wanted)
    .filter(([name, level]) => !covers(has?.[name], level))
    .map(([name, level]) => `${name}: ${level}`);
}

const LEVELS = ["read", "write", "admin"];
const covers = (has, level) => LEVELS.indexOf(has) >= Math.max(LEVELS.indexOf(level), 0);

// The App's settings (`asApp`, the App's own calls), read at start and with each listing of its
// repositories (repos.mjs): a warning for each event of APP_EVENTS it isn't subscribed to, and
// each permission of APP_PERMISSIONS it lacks. An App created before a feature lacks its events
// and permissions, and nothing else tells the operator (docs/setup.md); what its installations
// have yet to accept is the listing's to say. Resolves to the missing ones and what the
// dashboard's links need, { missing, permissions, app: { name, owner, ownerType } } (app null
// when GitHub refused). `credentials`: the stored App, the fallback for its slug and owner.
export async function checkAppSettings(asApp, log, { githubUrl, credentials = {} } = {}) {
  const res = await asApp("GET", "/app");
  if (!res.ok) return { missing: [], permissions: [], app: null };
  const { events = [], permissions: has = {}, name, slug, owner: account } = await res.json();
  const app = {
    name: name ?? credentials.slug ?? null,
    slug: slug ?? credentials.slug ?? null,
    owner: account?.login ?? credentials.owner ?? null,
    ownerType: account?.type ?? null,
  };
  const where = githubUrl && app.slug ? ` (${appSettingsUrl(githubUrl, app)})` : "";
  const missing = APP_EVENTS.filter((e) => !events.includes(e));
  if (missing.length) {
    log(
      `The GitHub App isn't subscribed to ${missing.join(", ")}: turn ${missing.length > 1 ? "them" : "it"} on under Subscribe to events in its settings${where} (docs/setup.md)`,
    );
  }
  const permissions = missingPermissions(has);
  if (permissions.length) {
    const them = permissions.length > 1 ? "them" : "it";
    log(
      `The GitHub App lacks the permission${permissions.length > 1 ? "s" : ""} ${permissions.join(", ")}: add ${them} under Permissions in its settings${where}, then accept ${them} on each installation (docs/setup.md)`,
    );
  }
  return { missing, permissions, app };
}

// A sandbox gets less than the App: no deployments, nothing outside its repo, and its code
// read-only. It pushes through the listener's git gateway (git-gateway.mjs), which refuses
// the default branch: GitHub can't be asked to (rulesets aren't enforced on free private
// repos), and a token that writes contents could also push or merge into it directly.
// Pull requests read-only too: `pull_requests: write` would let it approve any pull request of
// its repo as the App, or replace the review mode's verdict (GitHub counts a reviewer's latest
// review). Its own pull requests' writes get a token that writes them, from the GitHub gateway,
// once checked (github-pulls.mjs): the sandbox never holds it, and it carries only that write.
export const SANDBOX_PERMISSIONS = {
  contents: "read",
  issues: "write",
  pull_requests: "read",
  metadata: "read",
  actions: "read",
};
// Built-in light runs (brainstorms, inbox entries, discussions) comment and create issues, and
// never touch a pull request: they can't push either (the broker's `push`), and their
// ceilings hold no pull request's write but a brainstorm's comment.
// Their `issues: write`, like every token's writes, only reaches a write the GitHub gateway
// checked against their ceiling and policies: anything else gets readsOf() below.
export const LIGHT_PERMISSIONS = { pull_requests: "read" };
// Added for discussion runs only: an App created before discussions keeps working elsewhere.
export const DISCUSSION_PERMISSIONS = { ...LIGHT_PERMISSIONS, discussions: "write" };
// A research run (modes.mjs) gets no token at all: the broker refuses it one (broker.mjs).
export const NO_TOKEN = false;
// The git gateway's own token for a push it lets through: never handed to a sandbox.
export const PUSH_PERMISSIONS = { contents: "write" };
// Its token for a push of a repo granted `allow_workflows` (grants.mjs): GitHub refuses any
// push that adds or changes a file under .github/workflows/ without it.
export const WORKFLOW_PUSH_PERMISSIONS = { ...PUSH_PERMISSIONS, workflows: "write" };
// A repo's light modes (its config's `modes:`) only comment, and the listener posts their
// reply: their token can read the code, issues and pull requests, not push or write.
export const READ_ONLY_PERMISSIONS = {
  contents: "read",
  issues: "read",
  pull_requests: "read",
};

// What a run's token gets for anything but a write the GitHub gateway checked and let through
// (github-gateway.mjs): its permissions (`extra`, over SANDBOX_PERMISSIONS), each only read. A
// light run's `issues: write` then only ever reaches the writes its ceiling and policies allow.
export function readsOf(extra = {}) {
  const levels = { ...SANDBOX_PERMISSIONS, ...extra };
  return Object.fromEntries(
    Object.entries(levels).map(([name, level]) => [name, level === "write" ? "read" : level]),
  );
}

// Permissions a run's token goes without when its installation lacks them (it hasn't accepted
// them yet, or the App was created before them), rather than GitHub refusing the whole token:
// what needs one is refused by the GitHub gateway instead, saying which (github-gateway.mjs
// NEEDS). Any other permission stays required: a token without it fails, as it would have.
// `actions`: reading CI runs and logs, and rerunning failed jobs, which a run can do without.
export const OPTIONAL_PERMISSIONS = new Set(["actions"]);
// How long an installation's permissions are trusted before GitHub is asked again: an owner
// accepting new ones is also told by an `installation` delivery (rememberPermissions()).
export const PERMISSIONS_MS = 5 * 60000;

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
  // installation id → { permissions, url, account, at }, as GitHub last said; and the ones
  // being asked.
  const granted = new Map();
  const asking = new Map();
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

  // GitHub's status on the error, for callers that tell a refusal from an outage.
  async function json(res, what) {
    if (!res.ok) {
      throw Object.assign(new Error(`${what}: ${res.status} ${await res.text()}`), {
        status: res.status,
      });
    }
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
      rememberPermissions(found);
    }
    return installations.get(key);
  }

  // An installation as GitHub describes it (a lookup's answer, an `installation` delivery's):
  // what it was granted, until PERMISSIONS_MS later.
  function rememberPermissions(installation) {
    if (!installation?.id || !installation.permissions) return;
    granted.set(installation.id, {
      permissions: installation.permissions,
      url: installation.html_url ?? null,
      account: installation.account?.login ?? null,
      at: now(),
    });
  }

  // What the installation was granted, or null when GitHub couldn't say: then a token asks
  // for everything, as before optional permissions. Asked once at a time.
  async function grantedTo(installationId) {
    const known = granted.get(installationId);
    if (known && now() - known.at < PERMISSIONS_MS) return known;
    if (!asking.has(installationId)) {
      const pending = askGranted(installationId).finally(() => asking.delete(installationId));
      asking.set(installationId, pending);
    }
    return (await asking.get(installationId)) ?? known ?? null;
  }

  async function askGranted(installationId) {
    try {
      const res = await call("GET", `/app/installations/${installationId}`, jwt());
      if (!res.ok) {
        log(`GitHub GET /app/installations/${installationId}: ${res.status} ${await res.text()}`);
        return null;
      }
      rememberPermissions({ ...(await res.json()), id: installationId });
    } catch (error) {
      log(`GitHub GET /app/installations/${installationId}: ${error.message ?? error}`);
    }
    return granted.get(installationId) ?? null;
  }

  // The optional permissions of `wanted` (name → level) the repo's installation lacks:
  // { missing: ["actions: read"], account, url } (its page, where an owner accepts them), or
  // null when it lacks none, or GitHub couldn't say.
  async function lacking(repo, wanted) {
    const optional = Object.entries(wanted).filter(([name]) => OPTIONAL_PERMISSIONS.has(name));
    if (!optional.length) return null;
    const found = await grantedTo(await installationOf(repo));
    const missing = found && missingPermissions(found.permissions, Object.fromEntries(optional));
    return missing?.length ? { missing, account: found.account, url: found.url } : null;
  }

  // `repo`: a token for that repo alone, with the sandbox's permissions (and `extra`), but for
  // the optional ones its installation lacks; none: the whole installation with the App's, for
  // the listener's own calls.
  async function token(installationId, repo, extra = {}) {
    let permissions;
    if (repo) {
      permissions = { ...SANDBOX_PERMISSIONS, ...extra };
      const optional = Object.keys(permissions).some((name) => OPTIONAL_PERMISSIONS.has(name));
      const found = optional && (await grantedTo(installationId));
      for (const [name, level] of Object.entries(permissions)) {
        if (found && OPTIONAL_PERMISSIONS.has(name) && !covers(found.permissions[name], level)) {
          delete permissions[name];
        }
      }
    }
    // The levels too: a read-only token is not a writing one.
    const levels = Object.entries(permissions ?? {}).map(([name, level]) => `${name}=${level}`);
    const key = `${installationId}:${repo ?? "*"}:${levels.sort().join(",")}`;
    const cached = tokens.get(key);
    // A failing mint fails every caller waiting on it: one call to GitHub, not one each.
    if (cached) {
      const still = await cached.then((t) => (t.expiresAt - now() > REFRESH_MS ? t : null));
      if (still) return still;
    }
    return mint(key, installationId, repo, permissions);
  }

  function mint(key, installationId, repo, permissions) {
    const body = repo ? { repositories: [repo.split("/")[1]], permissions } : undefined;
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
      log(`GitHub ${method} ${path}: ${res.status} ${await res.clone().text()}`);
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
    rememberPermissions,
    installationOf,
    lacking,
    token,
    repoToken,
    request,
    asApp,
    asInstallation,
    identity,
    credentials,
  };
}
