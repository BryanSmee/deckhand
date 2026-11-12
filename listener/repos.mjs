// The dashboard's repository list: every repo the App is installed on that ALLOWED_REPOS
// lets through, with whether it is set up (a .deckhand.yaml on its default branch), set up
// so that no run starts (errors, or what the operator's grants refuse), being onboarded (an
// issue in the onboarded repos' map) or neither, and the button that starts onboarding.
//
//   GET  /api/repos                       the list; with ?backlog=1 (the Overview), each
//                                         configured repo with its backlog count as last
//                                         read (work.mjs counts())
//   POST /api/repos/refresh               the list, read again from GitHub
//   GET  /api/repos/<owner>/<repo>/config its config: raw, errors, what runs get (repo-view.mjs),
//                                         its pull request lifecycle (review-graph.mjs)
//   POST /api/repos/<owner>/<repo>/refresh the same, from the dashboard's Refresh (rate limited)
//   POST /api/repos/<owner>/<repo>/onboard opens its onboarding issue (onboarding.mjs)
//
// GitHub is asked as little as possible: the installations' repos are listed again every
// LIST_MS, and each repo's config is read once per CONFIG_MS, or again after a delivery says
// it may have changed (refresh()), or the dashboard asks. The operator's grants and the
// onboarding status are read at each list, so their changes show at once.
import { capabilityNameWarnings, catalogueView, modeOutcomes } from "./capabilities.mjs";
import { repoAllowed } from "./config.mjs";
import { isEntry } from "./context-repos.mjs";
import {
  autoMergeProblems,
  GrantsError,
  grantCheck,
  grantOf,
  loadGrants,
  refusedByGrants,
} from "./grants.mjs";
import { appSettingsUrl, missingPermissions } from "./github-app.mjs";
import {
  CONFIG_FILE,
  defaultSettings,
  fileLines,
  parseRepoConfig,
  readRepoFile,
} from "./repo-config.mjs";
import { sameRepo } from "./events.mjs";
import { effectiveView } from "./repo-view.mjs";
import { lifecycleGraph, NODES, sampleDecisions } from "./review-graph.mjs";
import { impliedSettings, loopWarnings, READY } from "./review-workflow.mjs";
import { errorText, reviewWorkflow } from "./workflow-format.mjs";
import { paginate } from "./github.mjs";
import { send } from "../lib/http.mjs";
import { mapLimited } from "../lib/pool.mjs";
import { apiRoute, mustDo } from "./web.mjs";
import { startAction } from "./permissions.mjs";

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
// missingEvents, missingPermissions, installations: [{ account, url, missing }] }. `app`: the
// stored credentials ({ slug, owner, html_url }) with what GET /app said last ({ name,
// owner, ownerType, missingEvents, missingPermissions }, github-app.mjs checkAppSettings(), at
// start and with each listing), which may not have answered yet. `installUrl`: GitHub's install page, which lists every account the
// App can be installed on, with Configure on those where it is; an installation's `url` is
// that account's Configure page, where an owner accepts the App's new permissions, and its
// `missing` what it has yet to accept: what the App itself lacks is the App's settings' to fix.
export function appLinks(githubUrl, app, installations = []) {
  const page = app.html_url ?? `${githubUrl}/apps/${encodeURIComponent(app.slug)}`;
  const missingPermissions = app.missingPermissions ?? [];
  return {
    name: app.name ?? app.slug,
    installUrl: `${page}/installations/new`,
    settingsUrl: appSettingsUrl(githubUrl, app),
    missingEvents: app.missingEvents ?? [],
    missingPermissions,
    installations: installations.map(({ missing = [], ...i }) => ({
      ...i,
      missing: missing.filter((p) => !missingPermissions.includes(p)),
    })),
  };
}

// `app`: asApp(), asInstallation(), request(), remember() and rememberPermissions()
// (github-app.mjs), and settings(), which reads the App's settings again (server.mjs checkApp()). `store`: the
// onboarding store (onboarding.mjs). `grants()`, `granted(repo)` and `fs` (realpath, stat): what
// a run reads too, the operator's grants folder, what its policies grant (grants.mjs grantsBy())
// and the listener's filesystem.
export function createRepoList({
  app,
  config,
  store,
  grants = () => loadGrants(config),
  granted = null,
  fs = {},
  now = Date.now,
  log = () => {},
}) {
  let listing = null; // Promise<repo infos>, while fresh
  let listedAt = 0;
  // The repos' names as last listed, for what can't wait for a listing (http-state.mjs state()).
  let listedNames = [];
  // What GitHub said of each, by its name in lower case, for access() (infoOf()), and when it
  // answered: what it says is used LIST_MS at most, never cleared by a later listing alone.
  let listedInfos = new Map();
  let infosAt = -Infinity;
  // The installations as last listed, [{ account, url, missing }]: the Manage App links.
  let installed = [];
  // installation id → what it lacked when last warned about ("" for nothing).
  const warned = new Map();
  // "owner/repo" → { at, base, has, errors, settings }: the parsed settings are kept (not the
  // text) so the grant checks run again at each list, without asking GitHub.
  const configs = new Map();

  async function fetchRepos() {
    // The App's settings read again first (server.mjs checkApp()): the links filter what its
    // installations lack by what it lacks itself, as it is now.
    // Null when GitHub didn't say: an installation's warnings are then left for the next
    // listing, as what it lacks may be the App's own, which no owner can accept.
    const appLacks = (await app.settings?.()) ?? null;
    const installations = await paginate((path) => app.asApp("GET", path), "/app/installations");
    const infos = [];
    installed = installations.map((i) => ({
      account: i.account?.login ?? null,
      url: i.html_url,
      // None when GitHub didn't say: the warnings are for what it says is missing.
      missing: i.permissions ? missingPermissions(i.permissions) : [],
    }));
    if (appLacks) {
      installations.forEach((i, n) => warnInstallation(i, installed[n].missing, appLacks));
    }
    for (const installation of installations) {
      app.rememberPermissions?.(installation);
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
    infos.sort((a, b) => a.full_name.localeCompare(b.full_name));
    listedNames = infos.map((r) => r.full_name);
    listedInfos = new Map(infos.map((r) => [r.full_name.toLowerCase(), r]));
    infosAt = now();
    return infos;
  }

  // What an installation lacks of what its App has: an owner of its account has yet to accept
  // it (docs/guides/github-app.md). Logged when it changes, not at each listing.
  function warnInstallation(installation, missing, appLacks) {
    const lacks = missing.filter((p) => !appLacks.includes(p)).join(", ");
    if (lacks && warned.get(installation.id) !== lacks) {
      log(
        `The GitHub App's installation on ${installation.account?.login ?? installation.id} lacks ${lacks}: an owner of the account accepts the new permissions on ${installation.html_url} (docs/guides/github-app.md)`,
      );
    }
    warned.set(installation.id, lacks);
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
  async function judged(info, known, load) {
    if (!known) return null;
    const { at, has, errors, settings } = known;
    const check =
      has && !errors
        ? await grantCheck(config, info.full_name, settings, { load, granted, fs })
        : null;
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
    const parsed = file ? parseRepoConfig(file.text, config, { repo: info.full_name }) : null;
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
    return mapLimited(infos, PARALLEL, async (info) => {
      const found = await judged(info, await configState(info), load);
      return repoStatus(info, found, store.get(info.full_name));
    });
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
    const found = await judged(info, known, grantsOnce());
    return { info, file, parsed, row: repoStatus(info, found, store.get(info.full_name)) };
  }

  // A delivery said this repo's config may have changed (a push to its default branch), or,
  // without a repo, which repos are installed did.
  // What infoOf() said goes too: what GitHub says of the repo (or of them all) is read again.
  function refresh(repo) {
    if (repo) {
      configs.delete(repo.toLowerCase());
      listedInfos.delete(repo.toLowerCase());
    } else {
      listing = null;
      listedInfos = new Map();
    }
  }

  // The dashboard's Refresh on the list: a delivery may have been missed, everything is read
  // again.
  function refreshAll() {
    listing = null;
    listedInfos = new Map();
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

  // The repos whose config, as last read (CONFIG_MS, or a push to their default branch), opts
  // in to auto-pickup: [{ repo, base }] (auto-pickup.mjs reads it again before a start). Those
  // the operator's grants refuse start nothing anyway.
  async function autoPickup() {
    const infos = await repos();
    const load = grantsOnce();
    const found = [];
    for (const info of infos) {
      const known = await configState(info);
      if (!known?.settings?.autoPickup || judged(info, known, load).invalid) continue;
      found.push({ repo: info.full_name, base: known.base });
    }
    return found;
  }

  // The names of the repos whose settings were read.
  const known = () => [...configs.values()].filter((k) => k.settings).map((k) => k.repo);

  // The repos' names, without reading their configs.
  const names = async () => (await repos()).map((r) => r.full_name);
  // The repos' names as last listed, or whose config was read (any, with a file or not), now:
  // [] before the first listing.
  const listed = () => [...new Set([...listedNames, ...[...configs.values()].map((k) => k.repo)])];

  // What GitHub said of `repo` when the installations were last listed, as policies.mjs access()
  // takes it: { full_name, private, default_branch }, or null: not listed (or GitHub gave no
  // default branch), its push or an installation's delivery since (refresh()), or listed LIST_MS
  // ago or more, which lists them again meanwhile (nothing else may: api/state and /status don't).
  // The dashboard's filters over every repo ask access() with it (permissions.mjs which(),
  // dashboard()): with the name alone each would read the repo from GitHub (#783); with null,
  // they do, as before.
  function infoOf(repo) {
    if (now() - infosAt >= LIST_MS) {
      repos().catch(() => {});
      return null;
    }
    const info = typeof repo === "string" ? listedInfos.get(repo.toLowerCase()) : null;
    if (!info || typeof info.default_branch !== "string" || !info.default_branch) return null;
    return {
      full_name: info.full_name,
      private: info.private,
      default_branch: info.default_branch,
    };
  }

  return {
    list,
    get,
    readConfig,
    refresh,
    refreshAll,
    names,
    listed,
    infoOf,
    usersOf,
    known,
    autoPickup,
    listedAt: () => listedAt,
    installations: () => installed,
  };
}

// Which deliveries make the list stale: refresh(repo) for a repo whose default branch moved,
// refresh() for the installations' repos and a repository's own change (deleted, renamed,
// transferred, made private: the list's names and `private`). Returns true when the default
// branch moved, a push or a merge into it, or another branch made the default in the
// repository's settings (`edited` with `changes.default_branch`, #876): its open pull requests
// are checked again. False for the others, a repository's other changes included:
// forgottenFor() covers what they change for the policies.
export function refreshFor(event, p, refresh) {
  if (event === "installation" || event === "installation_repositories") {
    refresh();
    return true;
  }
  if (event === "repository") {
    refresh();
    return p.action === "edited" && !!p.changes?.default_branch && !!p.repository?.full_name;
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

// The repositories whose policies' state (policies.mjs forget()) a delivery makes stale, beyond
// a default branch that moved (refreshFor()): those removed from an installation or out of a
// deleted or suspended one, and the repository a `repository` delivery is about (deleted,
// transferred, renamed, made private, archived…), under its old name too. Forgotten rather than
// left to expire: a repository made private would keep its `private: false` up to ACCESS_MS, or
// up to STALE_LISTING_MS during a GitHub error, and one out of the App's reach its last listing.
export function forgottenFor(event, p) {
  const names = (repos) => (Array.isArray(repos) ? repos.map((r) => r?.full_name) : []);
  let repos = [];
  if (event === "installation_repositories" && p.action === "removed") {
    repos = names(p.repositories_removed);
  } else if (event === "installation" && ["deleted", "suspend"].includes(p.action)) {
    repos = names(p.repositories);
  } else if (event === "repository") {
    const current = p.repository?.full_name;
    const [owner, name] = typeof current === "string" ? current.split("/") : [];
    const from = p.changes ?? {};
    const oldOwner = from.owner?.from?.user?.login ?? from.owner?.from?.organization?.login;
    repos = [
      current,
      from.repository?.name?.from && owner && `${owner}/${from.repository.name.from}`,
      oldOwner && name && `${oldOwner}/${name}`,
    ];
  }
  return [...new Set(repos.filter((r) => typeof r === "string" && r.includes("/")))];
}

// A grants error as the config panel shows it: { file, message, everyRepo }, the file to edit
// (relative to GRANTS_DIR) when there is one. Only a GrantsError's details are shown: they
// name files in the folder and their values; anything else may name the host's paths, and
// the orchestrator's logs have it.
function grantsErrorView(error, everyRepo) {
  if (!(error instanceof GrantsError)) {
    return {
      file: null,
      message: "the grants folder can't be read (see the orchestrator's logs)",
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
// `policies`: the policies' engine (policies.mjs), for the files that apply; none without.
// `backlogs(repos, user)`: the configured repos' backlog counts as last read, by lowercase name
// (work.mjs counts()), which never waits for GitHub.
export function createRepoApi({
  config,
  list,
  policies = null,
  backlogs = () => ({}),
  app = () => null,
  publicUrl = () => null,
  start,
  grants = () => loadGrants(config),
  granted = null,
  // Who may do what where (permissions.mjs): the list keeps the repos `user` has an action on.
  permissions = null,
  // The repos' workflows (workflows.mjs), for the one on `ready` the Workflow tab shows.
  workflows = null,
  fs,
  now = Date.now,
  log = () => {},
}) {
  const refreshed = new Map(); // "owner/repo" or "*" → when last refreshed

  // The list's answer: its rows, when GitHub listed them, and the App's links. With
  // `backlog`, a configured repo's row has its `backlog` for `user`: { count, more, readAt },
  // or null before its first read (or without `tasks:read` there). Only when asked: keeping the
  // counts fresh reads each repo from GitHub, which the pages that poll the list without showing
  // them shouldn't cost.
  async function listed(user, backlog = false) {
    const all = await list.list();
    const seen =
      permissions &&
      (await permissions.which(
        user,
        all.map((r) => r.repo),
        null,
        { listed: true },
      ));
    const rows = seen ? all.filter((r) => seen.has(r.repo.toLowerCase())) : all;
    const configured = rows.filter((r) => r.status === "configured").map((r) => r.repo);
    // The counts are the backlog's, which needs `tasks:read` (work.mjs): a repo seen through
    // another action has none, and isn't read for it either.
    const readable =
      backlog && permissions ? await permissions.which(user, configured, "tasks:read") : null;
    const counted = readable
      ? configured.filter((repo) => readable.has(repo.toLowerCase()))
      : configured;
    const counts = backlog ? backlogs(counted, user) : {};
    const repos = rows.map((r) =>
      backlog && r.status === "configured"
        ? { ...r, backlog: counts[r.repo.toLowerCase()] ?? null }
        : r,
    );
    const current = app();
    // Every installation with `server:read` (one may have no repo listed yet); else only those of
    // the accounts owning a repo `user` sees: the others' names, links and missing permissions
    // aren't theirs.
    const owners = new Set(rows.map((r) => r.repo.split("/")[0].toLowerCase()));
    const everyOne = !permissions || (await permissions.can(user, null, "server:read"));
    const installations = everyOne
      ? list.installations()
      : list.installations().filter((i) => owners.has(String(i.account).toLowerCase()));
    return {
      repos,
      listedAt: list.listedAt(),
      app: current && appLinks(config.githubUrl, current, installations),
    };
  }

  const wantsBacklog = (req) =>
    new URL(req.url, "http://localhost").searchParams.get("backlog") === "1";

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
    await mustDo(permissions, user, repo, startAction("onboarding"));
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
        error: "The issue couldn't be opened: see the orchestrator's logs.",
      });
    }
    send(res, 200, { repo: after, opened: !!issue });
  }

  async function refresh(req, res, user, repo) {
    if (!repo) {
      if (tooSoon("*")) return send(res, 429, { error: "Refreshed a moment ago." });
      list.refreshAll();
      return send(res, 200, await listed(user, wantsBacklog(req)));
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
      grant = await grantOf(config, info.full_name, { load: () => all, granted });
    } catch (error) {
      log(`Repositories: ${error.message ?? error}`);
      grantsError = grantsErrorView(error, everyRepo);
    }
    const settings = parsed?.settings ?? defaultSettings(config);
    // As the review loop runs them: a workflow file on `ready` stands for the keys its steps
    // turn on (merge, ci, fix), whatever `review:` says (#1140). Not read with errors in the
    // file, as the loop doesn't; a failed read is logged by sourceView().
    const ready = parsed?.errors?.length
      ? null
      : await workflows?.forEvent(info.full_name, base, settings, READY).catch(() => null);
    const looped = impliedSettings(settings, ready?.workflow);
    const warnings = loopWarnings(parsed?.warnings ?? [], settings, ready?.workflow);
    // What stops its merges: the grant, the repository's visibility (the parse's own warning
    // already says what its file lacks).
    const merging = grant ? autoMergeProblems(grant, looped, info.private === true) : [];
    // What the file says, with the line each error, warning, setting, mount and context repo
    // comes from.
    const { lineOf, itemLine, mountLine, locate } = fileLines(file?.text ?? "");
    const effective = effectiveView(config, info.full_name, settings, grant, fs);
    const branch = base.split("/").map(encodeURIComponent).join("/");
    // Read once for the Policies tab and the Workflow's sample (its errors are each one's).
    const described = policies?.describe(info.full_name, base) ?? null;
    described?.catch(() => {});
    send(res, 200, {
      repo: row,
      base,
      file: file && {
        text: file.text,
        sha: file.sha,
        url: `${info.html_url}/blob/${branch}/${CONFIG_FILE}`,
        editUrl: `${info.html_url}/edit/${branch}/${CONFIG_FILE}`,
      },
      errors: (parsed?.errors ?? []).map((e) => locate(e, parsed.fixes)),
      warnings: [...warnings, ...merging.filter((w) => !warnings.includes(w))].map((w) =>
        locate(w),
      ),
      grantsError,
      effective: {
        ...effective,
        settings: effective.settings.map((s) => ({ ...s, line: lineOf(s.key) })),
        mounts: effective.mounts.map((m) => ({ ...m, line: mountLine(m.path) })),
        contextRepos: effective.contextRepos.map((c) => ({
          ...c,
          line: itemLine("context_repos", isEntry(c)),
        })),
      },
      policies: await policyView(info, base, settings, described),
      capabilities: await capabilityView(info, base, settings, grant),
      workflow: await workflowView(info, base, settings, grant, described),
      readAt: row.readAt,
    });
  }

  // The policies that apply on `repo`'s default branch `base`, read now, as the panel shows
  // them: { files, errors, warnings } (policies.mjs describe()), each file with its text. Only
  // this endpoint sends it, never api/state.
  // `described`: describe()'s answer, on its way.
  async function policyView(info, base, settings, described) {
    if (!policies) return { files: [], errors: [], warnings: [] };
    const repo = info.full_name;
    try {
      const { files, errors, warnings: said } = await described;
      // The capability names its rules give that nobody knows, as the config check says them.
      const names =
        errors.length || !policies.capabilityRules
          ? []
          : await capabilityNameWarnings({
              repo: {
                name: repo,
                private: typeof info.private === "boolean" ? info.private : null,
              },
              settings,
              decide: (inputs) => policies.capabilityRules(repo, base, inputs),
            });
      // And the access actions its rules and the operator's name that nobody knows (#765), and
      // the modes its own rules name that it doesn't have (#837).
      const actions =
        errors.some((e) => !e.ignored) || !policies.accessNameWarnings
          ? []
          : await policies.accessNameWarnings(repo, base, Object.keys(settings?.modes ?? {}));
      const warnings = [...said, ...names, ...actions];
      // Written for GitHub replies; the panel shows text.
      const plain = (text) => text.replaceAll("`", "");
      return {
        files,
        errors: errors.map((e) => ({ ...e, message: plain(e.message), text: plain(e.text) })),
        warnings: warnings.map(plain),
      };
    } catch (error) {
      log(`Repositories: ${repo}'s policies: ${error.message ?? error}`);
      const text = "the policies can't be read (see the orchestrator's logs)";
      return { files: [], errors: [{ file: null, row: null, message: text, text }], warnings: [] };
    }
  }

  // What each mode's runs get on `info`'s repo (capabilities.mjs modeOutcomes()), its policies on
  // `base`, its `settings` and the operator's `grant` (null: can't be read), as a run would start
  // with them: { catalogue, modes, error }, the policies' error when they can't be evaluated
  // (then no run starts). Only this endpoint sends it, never api/state.
  async function capabilityView(info, base, settings, grant) {
    const catalogue = catalogueView();
    const plain = (text) => text.replaceAll("`", "");
    if (!policies) return { catalogue, modes: [], error: null };
    const repo = {
      name: info.full_name,
      private: typeof info.private === "boolean" ? info.private : null,
    };
    try {
      const said = await modeOutcomes({
        repo,
        settings,
        grant,
        decide: (inputs) => policies.capabilityRules(info.full_name, base, inputs),
      });
      if (said.error) return { catalogue, modes: [], error: plain(said.error) };
      const modes = said.modes.map((m) => ({
        ...m,
        capabilities: m.capabilities.map((c) => ({ ...c, reason: c.reason && plain(c.reason) })),
        errors: m.errors.map(plain),
        warnings: m.warnings.map(plain),
      }));
      return { catalogue, modes, error: null };
    } catch (error) {
      log(`Repositories: ${info.full_name}'s capabilities: ${error.message ?? error}`);
      return {
        catalogue,
        modes: [],
        error: "the capabilities can't be decided (see the orchestrator's logs)",
      };
    }
  }

  // The pull request lifecycle on `info`'s repo (review-graph.mjs lifecycleGraph()), its steps
  // asked of the policies on `base` with a sample pull request: { nodes, edges, sample }, `sample`
  // whether the policies were asked. Only this endpoint sends it, never api/state.
  async function workflowView(info, base, settings, grant, described) {
    const isPrivate = typeof info.private === "boolean" ? info.private : null;
    let decisions = null;
    if (policies) {
      const repo = info.full_name;
      const bot = config.bot ?? null;
      const sample = { repo, base, described, isPrivate, settings, bot, now };
      decisions = await sampleDecisions(policies, sample).catch((error) => {
        log(`Repositories: ${repo}'s workflow: ${error.message ?? error}`);
        const reasons = [{ message: "the policies can't be read (see the orchestrator's logs)" }];
        // Only the steps a policy gates; a task's real decision replaces it (no `grant`).
        const gated = NODES.filter((n) => n.decision);
        return Object.fromEntries(gated.map((n) => [n.id, { state: "refused", reasons }]));
      });
    }
    const graph = lifecycleGraph(settings, { grant, isPrivate, decisions });
    return { ...graph, sample: !!decisions, source: await sourceView(info, base, settings) };
  }

  // The workflow on `ready` the review loop runs here (#1041): the repo's own file, linked, or
  // the one its `review:` block compiles to, with its text; null when none runs (`review.on`
  // isn't `ready`). `errors`: its workflows', none of which runs then.
  async function sourceView(info, base, settings) {
    const compiled = reviewWorkflow(settings.review);
    const built = compiled && { file: null, url: null, text: compiled, errors: [] };
    if (!workflows) return built;
    const plain = (text) => text.replaceAll("`", "");
    try {
      const read = await workflows.read(info.full_name, base, settings);
      const errors = read.errors.map((e) => plain(errorText(e)));
      if (errors.length) return { file: null, url: null, text: null, errors };
      const own = read.workflows.find((w) => w.on.includes("ready"));
      if (!own) return built;
      const branch = base.split("/").map(encodeURIComponent).join("/");
      return {
        file: own.file,
        url: `${info.html_url}/blob/${branch}/${own.file}`,
        text: null,
        errors,
      };
    } catch (error) {
      log(`Repositories: ${info.full_name}'s workflows: ${error.message ?? error}`);
      const errors = ["its workflows can't be read (see the orchestrator's logs)"];
      return { file: null, url: null, text: null, errors };
    }
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
      list: async (req, res, user) => send(res, 200, await listed(user, wantsBacklog(req))),
      config: repoConfig,
    },
    posts: { onboard, refresh },
    allowed: (repo) => repoAllowed(config, repo),
    permissions,
    // Onboarding reads the config too, and starts its run. Refreshing the whole list lists every
    // installation from GitHub again: server-wide, as Sync.
    action: ({ what, repo }) =>
      repo ? "repo:config:read" : what === "refresh" ? "server:sync" : null,
    publicUrl,
    log,
  });

  // `listed`: the list as GET /api/repos answers it (the MCP tools', mcp.mjs).
  return { handle, listed };
}
