// The dashboard's repository list: every repo the App is installed on that ALLOWED_REPOS
// lets through, with whether it is set up (a .deckhand.yaml on its default branch), set up
// so that no run starts (errors, or what the operator's grants refuse), being onboarded (an
// issue in onboarding.json) or neither, and the button that starts onboarding.
//
//   GET  /api/repos                       the list
//   POST /api/repos/refresh               the list, read again from GitHub
//   GET  /api/repos/<owner>/<repo>/config its config: raw, errors, what runs get (repo-view.mjs)
//   POST /api/repos/<owner>/<repo>/refresh the same, from the dashboard's Refresh (rate limited)
//   POST /api/repos/<owner>/<repo>/onboard opens its onboarding issue (onboarding.mjs)
//
// GitHub is asked as little as possible: the installations' repos are listed again every
// LIST_MS, and each repo's config is read once per CONFIG_MS, or again after a delivery says
// it may have changed (refresh()), or the dashboard asks. The operator's grants and the
// onboarding status are read at each list, so their changes show at once.
import { repoAllowed } from "./config.mjs";
import {
  autoMergeProblems,
  GrantsError,
  grantCheck,
  grantFor,
  loadGrants,
  refusedByGrants,
} from "./grants.mjs";
import { appSettingsUrl } from "./github-app.mjs";
import { CONFIG_FILE, defaultSettings, parseRepoConfig, readRepoFile } from "./repo-config.mjs";
import { sameRepo } from "./events.mjs";
import { effectiveView } from "./repo-view.mjs";
import { paginate } from "./github.mjs";
import { apiRoute, send } from "./web.mjs";

export const LIST_MS = 5 * 60000;
export const CONFIG_MS = 30 * 60000;
// The dashboard's Refresh buttons: at most one read of a repo (or of the list) this often.
export const REPO_REFRESH_MS = 5000;
// Config reads at once: a large installation is listed without a burst of hundreds.
const PARALLEL = 8;

// One row: "configured", "invalid" (no run starts: its config has errors, or asks for what the
// operator's grants refuse), "onboarding" (with its issue) or "not-onboarded"; "unknown" when
// its config couldn't be read. `found`: { has, invalid, autoMerge, at } as last read, or null.
// `issues: false`: it can't be onboarded, its issues are off. `autoMerge`: its `review.merge`
// merges Deckhand's pull requests with no human review (grants.mjs autoMergeProblems()).
export function repoStatus(info, found, onboarded) {
  const row = {
    repo: info.full_name,
    url: info.html_url,
    private: !!info.private,
    issues: info.has_issues !== false,
    status: "not-onboarded",
    issue: null,
    readAt: found?.at ?? null,
    autoMerge: !!found?.autoMerge,
  };
  if (found?.has) return { ...row, status: found.invalid ? "invalid" : "configured" };
  if (onboarded) {
    const number = onboarded.issue;
    return {
      ...row,
      status: "onboarding",
      issue: { number, url: `${info.html_url}/issues/${number}` },
    };
  }
  if (!found) return { ...row, status: "unknown" };
  return row;
}

// The dashboard's Manage App links, all on GitHub: { name, installUrl, settingsUrl,
// installations: [{ account, url }] }. `app`: the stored credentials ({ slug, owner, html_url })
// with what GET /app said at start ({ name, owner, ownerType }, github-app.mjs
// checkAppEvents()), which may not have answered yet. `installUrl`: GitHub's install page,
// which lists every account the App can be installed on, with Configure on those where it is;
// an installation's `url` is that account's Configure page.
export function appLinks(githubUrl, app, installations = []) {
  const page = app.html_url ?? `${githubUrl}/apps/${encodeURIComponent(app.slug)}`;
  return {
    name: app.name ?? app.slug,
    installUrl: `${page}/installations/new`,
    settingsUrl: appSettingsUrl(githubUrl, app),
    installations,
  };
}

// `app`: asApp(), asInstallation(), request() and remember() (github-app.mjs). `store`: the
// onboarding store (onboarding.mjs). `grants()` and `fs` (realpath, stat): what a run reads
// too, the operator's grants folder and the listener's filesystem.
export function createRepoList({
  app,
  config,
  store,
  grants = () => loadGrants(config),
  fs = {},
  now = Date.now,
  log = () => {},
}) {
  let listing = null; // Promise<repo infos>, while fresh
  let listedAt = 0;
  // The installations as last listed, [{ account, url }]: the Manage App links.
  let installed = [];
  // "owner/repo" → { at, base, has, errors, settings }: the parsed settings are kept (not the
  // text) so the grant checks run again at each list, without asking GitHub.
  const configs = new Map();

  async function fetchRepos() {
    const installations = await paginate((path) => app.asApp("GET", path), "/app/installations");
    const infos = [];
    installed = installations.map((i) => ({ account: i.account?.login ?? null, url: i.html_url }));
    for (const installation of installations) {
      const repos = await paginate(
        (path) => app.asInstallation(installation.id, "GET", path),
        "/installation/repositories",
        (page) => page.repositories ?? [],
      );
      for (const r of repos) {
        app.remember(r.full_name, installation.id);
        // Archived repos take no issue or run: not worth a row.
        if (!r.archived && repoAllowed(config, r.full_name)) infos.push(r);
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

  // The grants folder once per list: a function that returns it, or throws its error.
  function grantsOnce() {
    try {
      const parsed = grants();
      return () => parsed;
    } catch (error) {
      return () => {
        throw error;
      };
    }
  }

  // What the row shows: { has, invalid, autoMerge, at }. Invalid when no run would start: the
  // file's errors, or what the operator's grants refuse in it (as grantCheck() is the run's
  // preflight). Checked at each call: an edited grant shows without reading GitHub.
  function judged(info, known, load) {
    if (!known) return null;
    const { at, has, errors, settings } = known;
    const check =
      has && !errors ? grantCheck(config, info.full_name, settings, { load, fs }) : null;
    const invalid = has && (errors || refusedByGrants(check));
    const autoMerge =
      !invalid &&
      !!settings?.review?.merge &&
      !autoMergeProblems(check.grant, settings, info.private === true).length;
    return { at, has, invalid: !!invalid, autoMerge };
  }

  // The config of the default branch, read now: { file, parsed } (file null without one).
  // Its text isn't kept, only whether it is there, has errors, and its settings.
  async function read(info) {
    const base = info.default_branch || "main";
    const file = await readRepoFile(app.request, info.full_name, CONFIG_FILE, base);
    const parsed = file ? parseRepoConfig(file.text, config) : null;
    const known = {
      repo: info.full_name,
      at: now(),
      base,
      has: !!file,
      errors: !!parsed?.errors.length,
      settings: parsed?.settings ?? null,
    };
    configs.set(info.full_name.toLowerCase(), known);
    return { file, parsed, known };
  }

  // The default branch's config as last read: { at, base, has, errors, settings }, or null
  // when GitHub failed.
  async function configState(info) {
    const known = configs.get(info.full_name.toLowerCase());
    const base = info.default_branch || "main";
    if (known && known.base === base && now() - known.at < CONFIG_MS) return known;
    try {
      return (await read(info)).known;
    } catch (error) {
      log(`Repositories: ${info.full_name}: ${error.message ?? error}`);
      return null;
    }
  }

  async function list() {
    const infos = await repos();
    const load = grantsOnce();
    const rows = new Array(infos.length);
    let next = 0;
    const worker = async () => {
      while (next < infos.length) {
        const i = next++;
        const found = judged(infos[i], await configState(infos[i]), load);
        rows[i] = repoStatus(infos[i], found, store.get(infos[i].full_name));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, infos.length) }, worker));
    return rows;
  }

  async function get(repo) {
    return (await list()).find((r) => sameRepo(r.repo, repo)) ?? null;
  }

  // The dashboard's config panel: the repo's config read now (its row too), or null when the
  // App isn't installed on it. GitHub errors throw.
  async function readConfig(repo) {
    const info = (await repos()).find((r) => sameRepo(r.full_name, repo));
    if (!info) return null;
    const { file, parsed, known } = await read(info);
    const found = judged(info, known, grantsOnce());
    return { info, file, parsed, row: repoStatus(info, found, store.get(info.full_name)) };
  }

  // A delivery said this repo's config may have changed (a push to its default branch), or,
  // without a repo, which repos are installed did.
  function refresh(repo) {
    if (repo) configs.delete(repo.toLowerCase());
    else listing = null;
  }

  // The dashboard's Refresh on the list: a delivery may have been missed, everything is read
  // again.
  function refreshAll() {
    listing = null;
    configs.clear();
  }

  // The repo's `users`, `wait_for_answers` and `inbox` as last read for the list,
  // { users, waitForAnswers, inbox, at }, or null when it wasn't (http.mjs sees()).
  function usersOf(repo) {
    const known = configs.get(repo.toLowerCase());
    if (!known?.settings) return null;
    const { users, waitForAnswers, inbox } = known.settings;
    return { users, waitForAnswers, inbox, at: known.at };
  }

  // The names of the repos whose settings were read.
  const known = () => [...configs.values()].filter((k) => k.settings).map((k) => k.repo);

  // The repos' names, without reading their configs.
  const names = async () => (await repos()).map((r) => r.full_name);

  return {
    list,
    get,
    readConfig,
    refresh,
    refreshAll,
    names,
    usersOf,
    known,
    listedAt: () => listedAt,
    installations: () => installed,
  };
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

// A grants error as the config panel shows it: { file, message, everyRepo }, the file to edit
// (relative to GRANTS_DIR) when there is one. Only a GrantsError's details are shown: they
// name files in the folder and their values; anything else may name the host's paths, and
// the listener's logs have it.
function grantsErrorView(error, everyRepo) {
  if (!(error instanceof GrantsError)) {
    return {
      file: null,
      message: "the grants folder can't be read (see the listener's logs)",
      everyRepo,
    };
  }
  let message = error.message.replace(/^grants: /, "");
  if (error.file && message.startsWith(`${error.file}: `)) {
    message = message.slice(error.file.length + 2);
  }
  return { file: error.file, message, everyRepo };
}

// The /api/repos routes. `user`: the signed-in login or null; `start(repo, login)` opens the
// repo's onboarding issue and its run, resolving to the issue or null (tasks.mjs). `grants()`
// and `fs` (realpath, stat) are what a run reads too: the operator's grants folder and the
// listener's filesystem. `app()`: the App for its links (appLinks()), or null before /setup.
export function createRepoApi({
  config,
  list,
  app = () => null,
  publicUrl = () => null,
  start,
  grants = () => loadGrants(config),
  fs,
  now = Date.now,
  log = () => {},
}) {
  const refreshed = new Map(); // "owner/repo" or "*" → when last refreshed

  // The list's answer: its rows, when GitHub listed them, and the App's links.
  async function listed() {
    const repos = await list.list();
    const current = app();
    return {
      repos,
      listedAt: list.listedAt(),
      app: current && appLinks(config.githubUrl, current, list.installations()),
    };
  }

  // The App isn't installed on it: a 404 (sent), else its row. ALLOWED_REPOS: apiRoute().
  async function known(res, repo) {
    const row = await list.get(repo);
    if (!row) send(res, 404, { error: `The App is not installed on ${repo}.` });
    return row;
  }

  // At most one refresh of `key` per REPO_REFRESH_MS: each reads GitHub.
  function tooSoon(key) {
    const last = refreshed.get(key);
    if (last !== undefined && now() - last < REPO_REFRESH_MS) return true;
    refreshed.set(key, now());
    return false;
  }

  async function onboard(req, res, user, repo) {
    const row = await known(res, repo);
    if (!row) return;
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

  async function refresh(req, res, user, repo) {
    if (!repo) {
      if (tooSoon("*")) return send(res, 429, { error: "Refreshed a moment ago." });
      list.refreshAll();
      return send(res, 200, await listed());
    }
    if (!(await known(res, repo))) return;
    if (tooSoon(repo.toLowerCase())) return send(res, 429, { error: "Refreshed a moment ago." });
    return repoConfig(req, res, user, repo, true);
  }

  // Read from GitHub at each request (the text isn't kept), which refreshes its row too.
  async function repoConfig(req, res, user, repo, checked = false) {
    if (!checked && !(await known(res, repo))) return;
    const read = await list.readConfig(repo);
    if (!read) return send(res, 404, { error: `The App is not installed on ${repo}.` });
    const { info, file, parsed, row } = read;
    const base = info.default_branch || "main";
    let grant = null;
    let grantsError = null;
    let everyRepo = true;
    try {
      const all = grants();
      everyRepo = false;
      grant = grantFor(all, config, info.full_name);
    } catch (error) {
      log(`Repositories: ${error.message ?? error}`);
      grantsError = grantsErrorView(error, everyRepo);
    }
    const settings = parsed?.settings ?? defaultSettings(config);
    const warnings = parsed?.warnings ?? [];
    // What stops its merges: the grant, the repository's visibility (the parse's own warning
    // already says what its file lacks).
    const merging = grant ? autoMergeProblems(grant, settings, info.private === true) : [];
    send(res, 200, {
      repo: row,
      base,
      file: file && {
        text: file.text,
        sha: file.sha,
        url: `${info.html_url}/blob/${base.split("/").map(encodeURIComponent).join("/")}/${CONFIG_FILE}`,
      },
      errors: parsed?.errors ?? [],
      warnings: [...warnings, ...merging.filter((w) => !warnings.includes(w))],
      grantsError,
      effective: effectiveView(config, info.full_name, settings, grant, fs),
      readAt: row.readAt,
    });
  }

  // Handles /api/repos*; false for any other path.
  const handle = apiRoute({
    name: "Repositories",
    route: (pathname) => {
      if (pathname === "/api/repos") return { what: "list" };
      if (pathname === "/api/repos/refresh") return { what: "refresh" };
      const one = /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/(onboard|refresh|config)$/.exec(pathname);
      return one && { repo: `${one[1]}/${one[2]}`, what: one[3] };
    },
    gets: {
      list: async (req, res) => send(res, 200, await listed()),
      config: repoConfig,
    },
    posts: { onboard, refresh },
    allowed: (repo) => repoAllowed(config, repo),
    publicUrl,
    log,
  });

  return { handle };
}
