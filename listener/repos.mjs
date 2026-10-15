// The dashboard's repository list: every repo the App is installed on that ALLOWED_REPOS
// lets through, with whether it is set up (a .deckhand.yaml on its default branch), being
// onboarded (an issue in onboarding.json) or neither, and the button that starts onboarding.
//
//   GET  /api/repos                       the list
//   POST /api/repos/<owner>/<repo>/onboard opens its onboarding issue (onboarding.mjs)
//
// GitHub is asked as little as possible: the installations' repos are listed again every
// LIST_MS, and each repo's config is read once per CONFIG_MS, or again after a delivery says
// it may have changed (refresh()). The onboarding status comes from onboarding.json, so it
// shows at once.
import { CONFIG_FILE, readRepoFile } from "./repo-config.mjs";

export const LIST_MS = 5 * 60000;
export const CONFIG_MS = 30 * 60000;
const PER_PAGE = 100;
// Config reads at once: a large installation is listed without a burst of hundreds.
const PARALLEL = 8;

// Every page of a list GitHub paginates; `items` picks the page's entries.
async function paginate(get, path, items) {
  const all = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await get(`${path}${sep}per_page=${PER_PAGE}&page=${page}`);
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
    const found = items(await res.json()) ?? [];
    all.push(...found);
    if (found.length < PER_PAGE) return all;
  }
}

// One row: "configured", "onboarding" (with its issue) or "not-onboarded"; "unknown" when
// its config couldn't be read. `issues: false`: it can't be onboarded, its issues are off.
export function repoStatus(info, hasConfig, onboarded) {
  const row = {
    repo: info.full_name,
    url: info.html_url,
    private: !!info.private,
    issues: info.has_issues !== false,
    status: "not-onboarded",
    issue: null,
  };
  if (hasConfig === true) return { ...row, status: "configured" };
  if (onboarded) {
    const number = onboarded.issue;
    return {
      ...row,
      status: "onboarding",
      issue: { number, url: `${info.html_url}/issues/${number}` },
    };
  }
  if (hasConfig === null) return { ...row, status: "unknown" };
  return row;
}

// `app`: asApp(), asInstallation(), request() and remember() (github-app.mjs). `store`: the
// onboarding store (onboarding.mjs).
export function createRepoList({ app, config, store, now = Date.now, log = () => {} }) {
  let listing = null; // Promise<repo infos>, while fresh
  let listedAt = 0;
  const configs = new Map(); // "owner/repo" → { at, base, has }

  const allowed = (repo) => !config.repos.length || config.repos.includes(repo.toLowerCase());

  async function fetchRepos() {
    const installations = await paginate(
      (path) => app.asApp("GET", path),
      "/app/installations",
      (page) => page,
    );
    const infos = [];
    for (const installation of installations) {
      const repos = await paginate(
        (path) => app.asInstallation(installation.id, "GET", path),
        "/installation/repositories",
        (page) => page.repositories,
      );
      for (const r of repos) {
        app.remember(r.full_name, installation.id);
        // Archived repos take no issue or run: not worth a row.
        if (!r.archived && allowed(r.full_name)) infos.push(r);
      }
    }
    return infos.sort((a, b) => a.full_name.localeCompare(b.full_name));
  }

  function repos() {
    if (!listing || now() - listedAt >= LIST_MS) {
      listedAt = now();
      const pending = fetchRepos();
      listing = pending;
      // A failure is not kept: the next load tries again.
      pending.catch(() => listing === pending && (listing = null));
    }
    return listing;
  }

  // Whether the default branch has the config: true, false, or null when GitHub failed.
  async function hasConfig(info) {
    const key = info.full_name.toLowerCase();
    const base = info.default_branch || "main";
    const known = configs.get(key);
    if (known && known.base === base && now() - known.at < CONFIG_MS) return known.has;
    try {
      const has = !!(await readRepoFile(app.request, info.full_name, CONFIG_FILE, base));
      configs.set(key, { at: now(), base, has });
      return has;
    } catch (error) {
      log(`Repositories: ${info.full_name}: ${error.message ?? error}`);
      return null;
    }
  }

  async function list() {
    const infos = await repos();
    const rows = new Array(infos.length);
    let next = 0;
    const worker = async () => {
      while (next < infos.length) {
        const i = next++;
        rows[i] = repoStatus(infos[i], await hasConfig(infos[i]), store.get(infos[i].full_name));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, infos.length) }, worker));
    return rows;
  }

  async function get(repo) {
    return (await list()).find((r) => r.repo.toLowerCase() === repo.toLowerCase()) ?? null;
  }

  // A delivery said this repo's config may have changed (a push to its default branch), or,
  // without a repo, which repos are installed did.
  function refresh(repo) {
    if (repo) configs.delete(repo.toLowerCase());
    else listing = null;
  }

  return { list, get, refresh };
}

// Which deliveries make the list stale: refresh(repo) for a repo whose default branch moved,
// refresh() for the installations' repos. Returns false for the others.
export function refreshFor(event, p, refresh) {
  if (event === "installation" || event === "installation_repositories") {
    refresh();
    return true;
  }
  const repo = p.repository?.full_name;
  const base = p.repository?.default_branch;
  if (!repo || !base) return false;
  const moved =
    (event === "push" && p.ref === `refs/heads/${base}`) ||
    (event === "pull_request" &&
      p.action === "closed" &&
      p.pull_request?.merged &&
      p.pull_request.base?.ref === base);
  if (moved) refresh(repo);
  return !!moved;
}

// A POST from the dashboard's own page: the Origin header names this listener (its public
// URL, or the host the browser asked for). The session cookie's SameSite=Lax already keeps
// other sites' POSTs without it; this refuses the rest.
export function sameOrigin(req, publicUrl) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (publicUrl && url.origin === new URL(publicUrl).origin) return true;
  return !!req.headers.host && url.host === req.headers.host;
}

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

// The /api/repos routes. `user`: the signed-in login or null; `start(repo, login)` opens the
// repo's onboarding issue and its run, resolving to the issue or null (server.mjs).
export function createRepoApi({ config, list, publicUrl = () => null, start, log = () => {} }) {
  async function onboard(req, res, user, repo) {
    if (!user) return send(res, 401, { error: "Sign in first." });
    if (!sameOrigin(req, publicUrl())) {
      log(
        `Repositories: refused onboarding ${repo} for ${user}: Origin ${req.headers.origin ?? "missing"}`,
      );
      return send(res, 403, { error: "Not from this dashboard." });
    }
    if (config.repos.length && !config.repos.includes(repo.toLowerCase())) {
      return send(res, 404, { error: `${repo} is not in ALLOWED_REPOS.` });
    }
    const row = await list.get(repo);
    if (!row) return send(res, 404, { error: `The App is not installed on ${repo}.` });
    // Already set up or being onboarded: nothing to do, the row says why.
    if (row.status !== "not-onboarded") return send(res, 200, { repo: row, opened: false });
    if (!row.issues) return send(res, 409, { repo: row, error: "Its issues are disabled." });
    log(`Repositories: ${user} starts onboarding ${row.repo}`);
    const issue = await start(row.repo, user);
    // Not opened (its config just landed, say): read it again, the row shows why.
    if (!issue) list.refresh(row.repo);
    const after = (await list.get(row.repo)) ?? row;
    if (!issue && after.status === "not-onboarded") {
      return send(res, 502, {
        repo: after,
        error: "The issue couldn't be opened: see the listener's logs.",
      });
    }
    send(res, 200, { repo: after, opened: !!issue });
  }

  // Handles /api/repos*; false for any other path.
  function handle(req, res, user) {
    const { pathname } = new URL(req.url, "http://localhost");
    const action = /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/onboard$/.exec(pathname);
    if (pathname !== "/api/repos" && !action) return false;
    const run = async () => {
      if (!action) {
        if (req.method !== "GET") return send(res, 405, { error: "GET only." });
        if (!user) return send(res, 401, { error: "Sign in first." });
        return send(res, 200, { repos: await list.list() });
      }
      if (req.method !== "POST") return send(res, 405, { error: "POST only." });
      return onboard(req, res, user, `${action[1]}/${action[2]}`);
    };
    run().catch((error) => {
      log(`Repositories: ${error.stack ?? error}`);
      if (!res.headersSent)
        send(res, 502, { error: "GitHub didn't answer: see the listener's logs." });
    });
    return true;
  }

  return { handle };
}
