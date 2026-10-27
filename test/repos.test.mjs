import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GrantsError, grantsFrom } from "../listener/grants.mjs";
import { createGitHubApp } from "../listener/github-app.mjs";
import { createOnboardingStore } from "../listener/onboarding.mjs";
import {
  CONFIG_MS,
  LIST_MS,
  REPO_REFRESH_MS,
  appLinks,
  createRepoApi,
  createRepoList,
  refreshFor,
  repoStatus,
} from "../listener/repos.mjs";
import { recordingFetch, tempDir, testConfig } from "./helpers.mjs";

const throwing = (error) => {
  throw error;
};

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});

const info = (full_name, extra = {}) => ({
  full_name,
  html_url: `https://github.com/${full_name}`,
  default_branch: "main",
  private: true,
  has_issues: true,
  archived: false,
  ...extra,
});

// A fake GitHub behind the real App client: two installations, the first with 150 repos
// (two pages), and `configured` the repos whose default branch has a .deckhand.yaml.
test("repoStatus: configured (or invalid) wins, then onboarding, then unknown, else not onboarded", () => {
  const repo = info("org/a", { private: false, has_issues: false });
  const row = {
    repo: "org/a",
    url: "https://github.com/org/a",
    private: false,
    issues: false,
    status: "not-onboarded",
    issue: null,
    readAt: 7,
    autoMerge: false,
  };
  const none = { has: false, invalid: false, at: 7 };
  const has = { has: true, invalid: false, at: 7 };
  const onboarded = { issue: 4, at: 1 };
  assert.deepEqual(repoStatus(repo, none, null), row);
  assert.deepEqual(repoStatus(repo, has, onboarded), { ...row, status: "configured" });
  assert.deepEqual(repoStatus(repo, { ...has, invalid: true }, onboarded), {
    ...row,
    status: "invalid",
  });
  const onboarding = {
    ...row,
    status: "onboarding",
    issue: { number: 4, url: "https://github.com/org/a/issues/4" },
  };
  assert.deepEqual(repoStatus(repo, none, onboarded), onboarding);
  // Its config couldn't be read: its onboarding issue still shows.
  assert.deepEqual(repoStatus(repo, null, onboarded), { ...onboarding, readAt: null });
  assert.deepEqual(repoStatus(repo, null, null), { ...row, status: "unknown", readAt: null });
});

function fakeGitHub({ first = [], second = [], configured = [], files = {} } = {}) {
  const github = recordingFetch(({ path, auth }) => {
    const { pathname, searchParams } = new URL(path, "https://api.github.com");
    const page = Number(searchParams.get("page") ?? 1);
    const per = Number(searchParams.get("per_page") ?? 30);
    const slice = (all) => all.slice((page - 1) * per, page * per);
    if (pathname === "/app/installations") {
      return slice([
        {
          id: 1,
          account: { login: "org" },
          html_url: "https://github.com/organizations/org/settings/installations/1",
        },
        {
          id: 2,
          account: { login: "other" },
          html_url: "https://github.com/settings/installations/2",
        },
      ]);
    }
    const minted = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (minted) {
      const expires_at = new Date(Date.now() + 3600000).toISOString();
      return Response.json({ token: `tok-${minted[1]}`, expires_at }, { status: 201 });
    }
    if (pathname === "/installation/repositories") {
      const mine = auth === "Bearer tok-1" ? first : second;
      return { total_count: mine.length, repositories: slice(mine) };
    }
    const content = /^\/repos\/([^/]+\/[^/]+)\/contents\/\.deckhand\.yaml$/.exec(pathname);
    if (content) {
      const text = files[content[1]] ?? (configured.includes(content[1]) && "trigger: deckhand\n");
      // Nothing: a 404.
      return text ? { type: "file", sha: "s", content: btoa(text) } : undefined;
    }
    return new Response("unexpected", { status: 500 });
  });
  // The calls as "METHOD /path?query", which the tests count and look for.
  return {
    fetch: github.fetch,
    get calls() {
      return github.calls.map(({ method, path }) => `${method} ${path}`);
    },
  };
}

// `grants`: the grants folder's files ({ "owner/repo.yaml": text }), an Error (its layout has
// errors), or a function returning loaded grants or an Error.
const grantsOf = (grants, config) => () => {
  const value = typeof grants === "function" ? grants() : grants;
  if (value instanceof Error) return throwing(value);
  return typeof grants === "function" ? value : grantsFrom(value, config);
};

function setup({ env = {}, grants = {}, fs, ...repos } = {}) {
  const gh = fakeGitHub(repos);
  const clock = { now: 1_000_000 };
  const app = createGitHubApp({
    credentials: { id: 1, client_id: "Iv1.abc", pem },
    fetch: gh.fetch,
  });
  const config = testConfig(env);
  const store = createOnboardingStore(join(tempDir(null, "deckhand-repos-"), "o.json"));
  const list = createRepoList({
    app,
    config,
    store,
    grants: grantsOf(grants, config),
    fs,
    now: () => clock.now,
  });
  return { gh, clock, app, config, store, list };
}

const configReads = (calls) => calls.filter((c) => c.includes("/contents/")).length;

test("every repo of every installation, paginated, with its status", async () => {
  const many = Array.from({ length: 150 }, (_, i) => info(`org/r${String(i).padStart(3, "0")}`));
  const { gh, list, store } = setup({
    first: many,
    second: [info("other/app"), info("other/notes", { has_issues: false })],
    configured: ["org/r000"],
  });
  store.record("org/r001", 12);
  const rows = await list.list();
  assert.equal(rows.length, 152);
  // Both pages of the first installation were read.
  assert.ok(gh.calls.includes("GET /installation/repositories?per_page=100&page=2"));
  const by = Object.fromEntries(rows.map((r) => [r.repo, r]));
  assert.equal(by["org/r000"].status, "configured");
  assert.deepEqual(by["org/r001"].issue, {
    number: 12,
    url: "https://github.com/org/r001/issues/12",
  });
  assert.equal(by["org/r001"].status, "onboarding");
  assert.equal(by["org/r002"].status, "not-onboarded");
  // Issues off: listed, but it can't be onboarded.
  assert.equal(by["other/notes"].status, "not-onboarded");
  assert.equal(by["other/notes"].issues, false);
});

test("ALLOWED_REPOS filters the list, archived repos are hidden", async () => {
  const { list, gh } = setup({
    env: { ALLOWED_REPOS: "org/app,org/old" },
    first: [info("org/app"), info("org/old", { archived: true }), info("org/secret")],
  });
  assert.deepEqual(
    (await list.list()).map((r) => r.repo),
    ["org/app"],
  );
  // Nothing is read of the repos that aren't listed.
  assert.equal(configReads(gh.calls), 1);
});

test("a config on the default branch wins over an onboarding record", async () => {
  const { list, store } = setup({ first: [info("org/app")], configured: ["org/app"] });
  store.record("org/app", 3);
  assert.equal((await list.get("org/app")).status, "configured");
});

test("cached: a page load doesn't read every config again; deliveries refresh it", async () => {
  const { list, gh, clock, store } = setup({ first: [info("org/app"), info("org/lib")] });
  await list.list();
  const listed = gh.calls.length;
  await list.list();
  await list.list();
  assert.equal(gh.calls.length, listed);
  // Onboarding shows at once: it comes from onboarding.json.
  store.record("org/lib", 9);
  assert.equal((await list.get("org/lib")).status, "onboarding");
  assert.equal(gh.calls.length, listed);

  // A push to org/app's default branch: its config only is read again.
  assert.equal(
    refreshFor(
      "push",
      { ref: "refs/heads/main", repository: { full_name: "org/app", default_branch: "main" } },
      list.refresh,
    ),
    true,
  );
  await list.list();
  assert.equal(configReads(gh.calls), 3);
  assert.equal(gh.calls.filter((c) => c.startsWith("GET /app/installations")).length, 1);

  // The installations' repos again after LIST_MS, the configs after CONFIG_MS.
  clock.now += LIST_MS;
  await list.list();
  assert.equal(gh.calls.filter((c) => c.startsWith("GET /app/installations")).length, 2);
  assert.equal(configReads(gh.calls), 3);
  clock.now += CONFIG_MS;
  await list.list();
  assert.equal(configReads(gh.calls), 5);
});

test("which deliveries refresh the list", () => {
  const calls = [];
  const refresh = (repo) => calls.push(repo ?? "*");
  const repository = { full_name: "org/app", default_branch: "main" };
  refreshFor("installation_repositories", { action: "added" }, refresh);
  refreshFor("push", { ref: "refs/heads/main", repository }, refresh);
  refreshFor("push", { ref: "refs/heads/feature", repository }, refresh);
  refreshFor(
    "pull_request",
    { action: "closed", pull_request: { merged: true, base: { ref: "main" } }, repository },
    refresh,
  );
  refreshFor(
    "pull_request",
    { action: "closed", pull_request: { merged: false, base: { ref: "main" } }, repository },
    refresh,
  );
  refreshFor("issue_comment", { action: "created", repository }, refresh);
  assert.deepEqual(calls, ["*", "org/app", "org/app"]);
});

// The API with a fake request and response.
async function call(
  api,
  method,
  url,
  { user = "alice", origin = "https://deckhand.example.com" } = {},
) {
  const req = { method, url, headers: { origin, host: "deckhand.example.com" } };
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) });
      },
    };
    assert.equal(api.handle(req, res, user), true);
  });
}

function apiSetup({ grants = {}, fs, app = () => null, policies, backlogs, ...opts } = {}) {
  const s = setup({ grants, fs, ...opts });
  const started = [];
  const api = createRepoApi({
    config: s.config,
    list: s.list,
    policies,
    backlogs,
    app,
    grants: grantsOf(grants, s.config),
    fs,
    now: () => s.clock.now,
    publicUrl: () => "https://deckhand.example.com",
    start: async (repo, login) => {
      started.push(`${repo} by ${login}`);
      s.store.record(repo, 42);
      return { number: 42 };
    },
  });
  return { ...s, api, started };
}

test("GET /api/repos: signed in only", async () => {
  const { api } = apiSetup({ first: [info("org/app")] });
  assert.equal((await call(api, "GET", "/api/repos", { user: null })).status, 401);
  const ok = await call(api, "GET", "/api/repos");
  assert.equal(ok.status, 200);
  assert.deepEqual(
    ok.body.repos.map((r) => [r.repo, r.status]),
    [["org/app", "not-onboarded"]],
  );
  assert.equal((await call(api, "POST", "/api/repos")).status, 405);
  assert.equal(api.handle({ method: "GET", url: "/api/state", headers: {} }, {}, "alice"), false);
});

test("GET /api/repos?backlog=1: each configured repo's backlog count for the user, the others none", async () => {
  const asked = [];
  const { api } = apiSetup({
    first: [info("org/App"), info("org/new"), info("org/unread")],
    configured: ["org/App", "org/unread"],
    backlogs: (repos, user) => {
      asked.push([repos, user]);
      return { "org/app": { count: 3, more: false, readAt: 5 } };
    },
  });
  // Without asking: no counts, none read.
  const plain = await call(api, "GET", "/api/repos", { user: "bob" });
  assert.ok(plain.body.repos.every((r) => !("backlog" in r)));
  assert.deepEqual(asked, []);
  const res = await call(api, "GET", "/api/repos?backlog=1", { user: "bob" });
  assert.deepEqual(
    res.body.repos.map((r) => [r.repo, r.backlog]),
    [
      ["org/App", { count: 3, more: false, readAt: 5 }],
      ["org/new", undefined],
      ["org/unread", null],
    ],
  );
  assert.deepEqual(asked, [[["org/App", "org/unread"], "bob"]]);
  // Refreshed too.
  const refreshed = await call(api, "POST", "/api/repos/refresh?backlog=1");
  assert.equal(refreshed.body.repos[0].backlog.count, 3);
});

test("GET /api/repos: the App's links, under GITHUB_URL, as its owner's type says", async () => {
  const stored = { slug: "my-app", owner: "acme", html_url: "https://github.com/apps/my-app" };
  const links = async (app) =>
    (await call(apiSetup({ app: () => app }).api, "GET", "/api/repos")).body.app;
  const installations = [
    { account: "org", url: "https://github.com/organizations/org/settings/installations/1" },
    { account: "other", url: "https://github.com/settings/installations/2" },
  ];
  const expected = {
    name: "My App",
    installUrl: "https://github.com/apps/my-app/installations/new",
    settingsUrl: "https://github.com/organizations/acme/settings/apps/my-app",
    installations,
  };
  assert.deepEqual(await links({ ...stored, name: "My App", ownerType: "Organization" }), expected);
  assert.deepEqual(await links({ ...stored, name: "My App", ownerType: "User" }), {
    ...expected,
    settingsUrl: "https://github.com/settings/apps/my-app",
  });
  // GET /app hasn't answered: the slug as its name, the user's settings.
  assert.deepEqual(await links(stored), {
    ...expected,
    name: "my-app",
    settingsUrl: "https://github.com/settings/apps/my-app",
  });
  // Before /setup: none.
  assert.equal(await links(null), null);
});

test("appLinks: GitHub Enterprise, without the App's page stored", () => {
  const links = appLinks("https://ghe.example.com", {
    slug: "my-app",
    owner: "acme",
    ownerType: "Organization",
  });
  assert.equal(links.installUrl, "https://ghe.example.com/apps/my-app/installations/new");
  assert.equal(
    links.settingsUrl,
    "https://ghe.example.com/organizations/acme/settings/apps/my-app",
  );
  assert.deepEqual(links.installations, []);
});

test("POST onboard: opens the issue, and the row switches to onboarding", async () => {
  const { api, started } = apiSetup({ first: [info("org/app")] });
  const res = await call(api, "POST", "/api/repos/org/app/onboard");
  assert.equal(res.status, 200);
  assert.equal(res.body.opened, true);
  assert.equal(res.body.repo.status, "onboarding");
  assert.equal(res.body.repo.issue.number, 42);
  assert.deepEqual(started, ["org/app by alice"]);
  // Again: a no-op, the issue is there.
  const again = await call(api, "POST", "/api/repos/org/app/onboard");
  assert.equal(again.status, 200);
  assert.equal(again.body.opened, false);
  assert.equal(started.length, 1);
});

test("POST onboard: refused without a session, from another origin, for a repo not allowed or not installed", async () => {
  const { api, started } = apiSetup({
    env: { ALLOWED_REPOS: "org/app,org/elsewhere" },
    first: [info("org/app"), info("org/secret")],
  });
  const post = (path, opts) => call(api, "POST", path, opts);
  assert.equal((await post("/api/repos/org/app/onboard", { user: null })).status, 401);
  assert.equal(
    (await post("/api/repos/org/app/onboard", { origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await post("/api/repos/org/app/onboard", { origin: null })).status, 403);
  assert.equal((await post("/api/repos/org/secret/onboard")).status, 404);
  assert.equal((await post("/api/repos/org/elsewhere/onboard")).status, 404);
  assert.equal((await call(api, "GET", "/api/repos/org/app/onboard")).status, 405);
  assert.deepEqual(started, []);
});

test("POST onboard: a no-op when configured or already onboarded, refused when issues are off", async () => {
  const { api, started, store } = apiSetup({
    first: [info("org/done"), info("org/going"), info("org/quiet", { has_issues: false })],
    configured: ["org/done"],
  });
  store.record("org/going", 5);
  const done = await call(api, "POST", "/api/repos/org/done/onboard");
  assert.deepEqual(
    [done.status, done.body.opened, done.body.repo.status],
    [200, false, "configured"],
  );
  const going = await call(api, "POST", "/api/repos/org/going/onboard");
  assert.deepEqual(
    [going.status, going.body.opened, going.body.repo.issue.number],
    [200, false, 5],
  );
  assert.equal((await call(api, "POST", "/api/repos/org/quiet/onboard")).status, 409);
  assert.deepEqual(started, []);
});

test("an invalid config shows as such in the list", async () => {
  const { list } = setup({
    first: [info("org/app"), info("org/bad")],
    files: { "org/app": "trigger: go\n", "org/bad": "max_parallel: lots\n" },
  });
  const rows = await list.list();
  assert.deepEqual(
    rows.map((r) => [r.repo, r.status]),
    [
      ["org/app", "configured"],
      ["org/bad", "invalid"],
    ],
  );
  assert.equal(rows[0].readAt, 1_000_000);
});

// What runs refuse, each against the grant that allows it: [.deckhand.yaml, its grant file].
function refusedCases(root) {
  return {
    dockerfile: ["dockerfile: .deckhand/Dockerfile\n", "allow_dockerfile: true"],
    preview: ["preview:\n  command: ./preview.sh\n", "allow_preview: true"],
    mounts: [`mounts: [${root}/data]\n`, `mounts: [${root}]`],
  };
}

function refusedSetup(t) {
  const root = realpathSync(tempDir(t, "deckhand-repos-mounts-"));
  mkdirSync(join(root, "data"));
  const cases = refusedCases(root);
  const files = Object.fromEntries(Object.entries(cases).map(([k, [file]]) => [`org/${k}`, file]));
  const grants = { files: {} };
  const s = apiSetup({
    first: Object.keys(cases).map((k) => info(`org/${k}`)),
    files,
    grants: () => grantsFrom(grants.files, s.config),
  });
  return { ...s, cases, grants };
}

const statuses = async (api) =>
  Object.fromEntries(
    (await call(api, "GET", "/api/repos")).body.repos.map((r) => [r.repo, r.status]),
  );

test("a config the operator's grants refuse is invalid: no run starts there", async (t) => {
  const { api, cases } = refusedSetup(t);
  // Each file parses: only the grants refuse it.
  assert.deepEqual(await statuses(api), {
    "org/dockerfile": "invalid",
    "org/mounts": "invalid",
    "org/preview": "invalid",
  });
  for (const repo of Object.keys(cases)) {
    const { body } = await call(api, "GET", `/api/repos/org/${repo}/config`);
    assert.deepEqual(body.errors, [], repo);
    assert.equal(body.repo.status, "invalid", repo);
  }
});

test("a fully granted config is configured; editing a grant shows without GitHub", async (t) => {
  const { api, gh, cases, grants } = refusedSetup(t);
  await statuses(api);
  const reads = configReads(gh.calls);
  grants.files = Object.fromEntries(
    Object.entries(cases).map(([repo, [, grant]]) => [`org/${repo}.yaml`, `${grant}\n`]),
  );
  assert.deepEqual(await statuses(api), {
    "org/dockerfile": "configured",
    "org/mounts": "configured",
    "org/preview": "configured",
  });
  for (const repo of Object.keys(cases)) {
    const { body } = await call(api, "GET", `/api/repos/org/${repo}/config`);
    assert.equal(body.repo.status, "configured", repo);
  }
  // The list read no config again: the grants are checked against the kept settings.
  assert.equal(configReads(gh.calls), reads + Object.keys(cases).length);
  grants.files = {};
  assert.equal((await statuses(api))["org/preview"], "invalid");
});

test("a repo's broken grant makes that repo invalid only", async () => {
  const { api } = apiSetup({
    first: [info("org/app"), info("org/other")],
    configured: ["org/app", "org/other"],
    grants: { "default.yaml": "allow_dockerfile: true\n", "org/app.yaml": "hosts: [bad host]\n" },
  });
  assert.deepEqual(await statuses(api), { "org/app": "invalid", "org/other": "configured" });
  const { body } = await call(api, "GET", "/api/repos/org/app/config");
  const { file, message, everyRepo } = body.grantsError;
  assert.deepEqual([file, everyRepo], ["org/app.yaml", false]);
  assert.match(message, /^hosts: "bad host": ./);
  assert.equal(body.effective.grant, null);
  const other = (await call(api, "GET", "/api/repos/org/other/config")).body;
  assert.equal(other.grantsError, null);
  assert.deepEqual(other.effective.grant.files, ["default.yaml"]);
});

test("a repo's config: the policies that apply, with their text; none without an engine", async () => {
  const asked = [];
  const file = {
    name: "a.rego",
    source: "repo",
    replaces: false,
    active: true,
    rules: ["deny_merge"],
    url: null,
    text: "package deckhand\n",
    truncated: false,
  };
  const policies = {
    describe: async (repo, base) => {
      asked.push([repo, base]);
      return {
        files: [file],
        errors: [
          {
            file: "a.rego",
            row: 1,
            message: "unexpected `eof`",
            text: "policy error: a.rego:1: unexpected `eof`",
          },
        ],
        warnings: ["a.rego: `deny_x` isn't a rule"],
        policies: new Map([["a.rego", "package deckhand"]]),
      };
    },
  };
  const { api } = apiSetup({ first: [info("org/app")], configured: ["org/app"], policies });
  const { body } = await call(api, "GET", "/api/repos/org/app/config");
  assert.deepEqual(asked, [["org/app", "main"]]);
  // Written for GitHub replies, without their backquotes.
  assert.deepEqual(body.policies, {
    files: [file],
    errors: [
      {
        file: "a.rego",
        row: 1,
        message: "unexpected eof",
        text: "policy error: a.rego:1: unexpected eof",
      },
    ],
    warnings: ["a.rego: deny_x isn't a rule"],
  });
  // GitHub failing to list them: said, without its details.
  policies.describe = async () => {
    throw new Error("GET /repos/org/app/contents: 502");
  };
  const failed = (await call(api, "GET", "/api/repos/org/app/config")).body.policies;
  const text = "the policies can't be read (see the listener's logs)";
  assert.deepEqual(failed.errors, [{ file: null, row: null, message: text, text }]);
  const none = apiSetup({ first: [info("org/app")], configured: ["org/app"] });
  const bare = (await call(none.api, "GET", "/api/repos/org/app/config")).body.policies;
  assert.deepEqual(bare, { files: [], errors: [], warnings: [] });
});

test("a grants folder with errors makes every configured repo invalid, not the others", async () => {
  const { api } = apiSetup({
    first: [info("org/app"), info("org/new")],
    configured: ["org/app"],
    grants: new GrantsError(
      "grants: default.yaml: mounts: only a repository's own file grants mounts",
      "default.yaml",
    ),
  });
  assert.deepEqual(await statuses(api), { "org/app": "invalid", "org/new": "not-onboarded" });
  const { body } = await call(api, "GET", "/api/repos/org/app/config");
  assert.equal(body.repo.status, "invalid");
});

test("the list's refused checks are the run preflight's: both go through grantCheck()", () => {
  const access = readFileSync(new URL("../listener/access.mjs", import.meta.url), "utf8");
  const preflight = access.slice(access.indexOf("function grantedAccess("));
  const body = preflight.slice(0, preflight.indexOf("\n}\n"));
  assert.match(body, /grantCheck\(config, repo, settings[,)]/);
  // None of the checks is made on the side, where the list wouldn't see it.
  for (const piece of ["loadGrants(", "grantFor(", "ungranted(", "resolveMounts("]) {
    assert.ok(!body.includes(piece), piece);
  }
  const repos = readFileSync(new URL("../listener/repos.mjs", import.meta.url), "utf8");
  assert.match(
    repos,
    /check =\s+has && !errors \?\s+grantCheck\(config, info\.full_name, settings/,
  );
  assert.match(repos, /refusedByGrants\(check\)/);
});

test("GET config: raw text, errors, warnings and what runs get; its row updated", async () => {
  const { api, gh, clock } = apiSetup({
    env: { ALLOWED_USERS: "alice,bob" },
    grants: { "default.yaml": "hosts: [registry.npmjs.org]\n" },
    first: [info("org/app")],
    files: { "org/app": "users: [bob, carol]\nhosts: [pypi.org]\nmax_parallel: 5\n" },
  });
  await call(api, "GET", "/api/repos");
  clock.now += 1000;
  const res = await call(api, "GET", "/api/repos/org/app/config");
  assert.equal(res.status, 200);
  const { body } = res;
  assert.equal(body.file.text, "users: [bob, carol]\nhosts: [pypi.org]\nmax_parallel: 5\n");
  assert.equal(body.file.sha, "s");
  assert.equal(body.file.url, "https://github.com/org/app/blob/main/.deckhand.yaml");
  assert.equal(body.file.editUrl, "https://github.com/org/app/edit/main/.deckhand.yaml");
  assert.equal(body.base, "main");
  assert.deepEqual(body.errors, []);
  // Each with the line of its key, when it has one.
  assert.deepEqual(body.warnings, [
    { key: null, message: "users not in ALLOWED_USERS, ignored: carol", line: null, fix: null },
    {
      key: "hosts",
      message: "ignored, the operator lists the hosts in grants/<owner>/<repo>.yaml",
      line: 2,
      fix: null,
    },
  ]);
  assert.equal(body.grantsError, null);
  // A repo's own hosts are only a warning: its runs start.
  assert.equal(body.repo.status, "configured");
  // Read now, not from the list's cache.
  assert.equal(body.readAt, 1_001_000);
  assert.equal(configReads(gh.calls), 2);
  const users = body.effective.settings.find((r) => r.key === "users");
  assert.deepEqual(users, {
    key: "users",
    value: "bob",
    source: "repo",
    note: "narrowed from ALLOWED_USERS (alice, bob)",
    line: 1,
  });
  // The operator's MAX_PARALLEL (2) stays the ceiling.
  const parallel = body.effective.settings.find((r) => r.key === "max_parallel");
  assert.deepEqual([parallel.value, parallel.source, parallel.line], ["2", "operator", 3]);
  assert.equal(body.effective.settings.find((r) => r.key === "model").line, null);
  // Not reachable: only the grants folder lists hosts, each with its file.
  assert.equal(
    body.effective.hosts.find((h) => h.host === "pypi.org"),
    undefined,
  );
  assert.deepEqual(
    body.effective.hosts.find((h) => h.host === "registry.npmjs.org"),
    { host: "registry.npmjs.org", source: "operator", note: "grants/default.yaml" },
  );
  assert.deepEqual(body.effective.grant, {
    files: ["default.yaml"],
    allowPreview: false,
    allowDockerfile: false,
    allowBranchDockerImages: false,
    allowDocker: false,
    allowResearch: false,
    allowWorkflows: false,
    allowAutoMerge: false,
    acknowledgeAutoMergePreview: false,
    hosts: ["registry.npmjs.org"],
    cachedHosts: [],
    mounts: [],
    limits: { cpus: "2", memory: "4g", pids: 2048 },
  });
});

test("auto-merge: the row's badge and the config's warnings follow the grant, visibility and hook", async () => {
  const merge = "review:\n  on: ready\n  fix: true\n  merge: true\n";
  const repos = {
    "org/priv": [{}, "allow_auto_merge: true\n", merge],
    "org/pub": [{ private: false }, "allow_auto_merge: true\n", merge],
    "org/pubok": [{ private: false }, "allow_auto_merge: public\n", merge],
    "org/none": [{}, "", merge],
    "org/hook": [{}, "allow_auto_merge: true\nallow_preview: true\n", `${merge}preview: ./x.sh\n`],
    "org/ack": [
      {},
      "allow_auto_merge: true\nallow_preview: true\nacknowledge_automerge_and_preview_is_highly_dangerous: true\n",
      `${merge}preview: ./x.sh\n`,
    ],
    "org/manual": [{}, "allow_auto_merge: true\n", "review:\n  merge: true\n"],
  };
  const grants = {};
  for (const [repo, [, grant]] of Object.entries(repos)) {
    if (grant) grants[`${repo}.yaml`] = grant;
  }
  const { api } = apiSetup({
    grants,
    first: Object.entries(repos).map(([repo, [extra]]) => info(repo, extra)),
    files: Object.fromEntries(Object.entries(repos).map(([repo, [, , yaml]]) => [repo, yaml])),
  });
  const { body } = await call(api, "GET", "/api/repos");
  const on = Object.fromEntries(body.repos.map((r) => [r.repo, r.autoMerge]));
  assert.deepEqual(on, {
    "org/ack": true,
    "org/hook": false,
    "org/manual": false,
    "org/none": false,
    "org/priv": true,
    "org/pub": false,
    "org/pubok": true,
  });
  const warnings = async (repo) =>
    (await call(api, "GET", `/api/repos/${repo}/config`)).body.warnings.map(
      (w) => `${w.key ? `${w.key}: ` : ""}${w.message}`,
    );
  for (const repo of ["org/priv", "org/pubok", "org/ack"])
    assert.deepEqual(await warnings(repo), [], repo);
  assert.match((await warnings("org/none"))[0], /don't set `allow_auto_merge: true`/);
  assert.match((await warnings("org/pub"))[0], /is public.*`allow_auto_merge: true`, not `public`/);
  assert.match(
    (await warnings("org/hook"))[0],
    /`acknowledge_automerge_and_preview_is_highly_dangerous: true`, nothing is merged/,
  );
  // The parse's own warning, once.
  assert.deepEqual(await warnings("org/manual"), [
    "review.merge: needs `review.on: ready`, nothing is merged",
  ]);
});

test("GET config: an invalid file shows its errors, and its row turns invalid", async () => {
  const files = { "org/app": "trigger: go\n" };
  const { api } = apiSetup({ first: [info("org/app")], files });
  assert.equal((await call(api, "GET", "/api/repos")).body.repos[0].status, "configured");
  // The file changed and no webhook said so: reading it for the panel updates the row.
  files["org/app"] = "# app\n\neffort: loud\nmodes:\n  stop: { instructions: a.md }\n";
  const res = await call(api, "GET", "/api/repos/org/app/config");
  assert.equal(res.body.repo.status, "invalid");
  assert.equal(res.body.errors[0].key, "effort");
  assert.match(res.body.errors[0].message, /^expected one of/);
  assert.equal(res.body.errors[0].line, 3);
  // Each error with its fix: the parse's own, else one that fits any error.
  assert.match(res.body.errors[0].fix, /remove the key to get the default/);
  assert.deepEqual([res.body.errors[1].key, res.body.errors[1].line], ["modes.stop", 5]);
  assert.match(res.body.errors[1].fix, /^Give the mode another name/);
  assert.equal((await call(api, "GET", "/api/repos")).body.repos[0].status, "invalid");
});

test("GET config: without a file, the operator's defaults", async () => {
  const { api } = apiSetup({ first: [info("org/app")] });
  const { status, body } = await call(api, "GET", "/api/repos/org/app/config");
  assert.equal(status, 200);
  assert.equal(body.file, null);
  assert.equal(body.repo.status, "not-onboarded");
  assert.ok(body.effective.settings.every((r) => r.source === "operator"));
  assert.equal(body.effective.settings.find((r) => r.key === "trigger").value, "deckhand");
});

test("GET config: a broken grants folder names the file and stops every repo", async () => {
  const error = new GrantsError(
    "grants: default.yaml: mounts: only a repository's own file grants mounts",
    "default.yaml",
  );
  const { api } = apiSetup({ first: [info("org/app")], configured: ["org/app"], grants: error });
  const { body } = await call(api, "GET", "/api/repos/org/app/config");
  assert.deepEqual(body.grantsError, {
    file: "default.yaml",
    message: "mounts: only a repository's own file grants mounts",
    everyRepo: true,
  });
  assert.equal(body.effective.grant, null);
});

test("GET config: an unexpected grants error is said, not detailed", async () => {
  const { api } = apiSetup({
    first: [info("org/app")],
    configured: ["org/app"],
    grants: new Error("EIO: /secret/path"),
  });
  const { body } = await call(api, "GET", "/api/repos/org/app/config");
  assert.match(body.grantsError.message, /can't be read \(see the listener's logs\)/);
  assert.doesNotMatch(JSON.stringify(body.grantsError), /secret/);
  assert.equal(body.effective.grant, null);
});

test("GET config: signed in only, for repos allowed and installed", async () => {
  const { api } = apiSetup({
    env: { ALLOWED_REPOS: "org/app,org/elsewhere" },
    first: [info("org/app"), info("org/secret")],
  });
  assert.equal((await call(api, "GET", "/api/repos/org/app/config", { user: null })).status, 401);
  assert.equal((await call(api, "GET", "/api/repos/org/secret/config")).status, 404);
  assert.equal((await call(api, "GET", "/api/repos/org/elsewhere/config")).status, 404);
  assert.equal((await call(api, "POST", "/api/repos/org/app/config")).status, 405);
});

test("POST refresh: same origin only, reads the repo's config again, rate limited", async () => {
  const { api, gh, clock } = apiSetup({ first: [info("org/app")], configured: ["org/app"] });
  await call(api, "GET", "/api/repos");
  assert.equal(configReads(gh.calls), 1);
  const path = "/api/repos/org/app/refresh";
  assert.equal((await call(api, "POST", path, { user: null })).status, 401);
  assert.equal((await call(api, "POST", path, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(api, "GET", path)).status, 405);
  assert.equal(configReads(gh.calls), 1);
  const res = await call(api, "POST", path);
  assert.equal(res.status, 200);
  assert.equal(res.body.repo.status, "configured");
  assert.equal(configReads(gh.calls), 2);
  // Again at once: refused, GitHub isn't asked.
  assert.equal((await call(api, "POST", path)).status, 429);
  assert.equal(configReads(gh.calls), 2);
  clock.now += REPO_REFRESH_MS;
  assert.equal((await call(api, "POST", path)).status, 200);
  assert.equal(configReads(gh.calls), 3);
  assert.equal((await call(api, "POST", "/api/repos/org/other/refresh")).status, 404);
});

test("POST /api/repos/refresh: lists the installations' repos again", async () => {
  const { api, gh, clock } = apiSetup({ first: [info("org/app")] });
  const listings = () => gh.calls.filter((c) => c.startsWith("GET /app/installations")).length;
  const before = await call(api, "GET", "/api/repos");
  assert.equal(before.body.listedAt, 1_000_000);
  clock.now += 1000;
  assert.equal((await call(api, "POST", "/api/repos/refresh", { origin: null })).status, 403);
  const res = await call(api, "POST", "/api/repos/refresh");
  assert.equal(res.status, 200);
  assert.equal(res.body.listedAt, 1_001_000);
  assert.equal(listings(), 2);
  assert.equal(configReads(gh.calls), 2);
  assert.equal((await call(api, "POST", "/api/repos/refresh")).status, 429);
  assert.equal(listings(), 2);
});

test("known() and usersOf(): the repos read, with their inbox issues (the dashboard's form)", async () => {
  const { list } = setup({
    first: [info("Org/App"), info("org/lib")],
    files: { "Org/App": "inbox:\n  ideas: 4\n" },
  });
  assert.deepEqual(list.known(), []);
  await list.list();
  // A repo without a config has no settings read: only the configured one.
  assert.deepEqual(list.known(), ["Org/App"]);
  assert.deepEqual(list.usersOf("org/app").inbox, { ideas: 4 });
});
