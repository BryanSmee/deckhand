import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { createGitHubApp } from "../listener/github-app.mjs";
import { createOnboardingStore } from "../listener/onboarding.mjs";
import {
  CONFIG_MS,
  LIST_MS,
  createRepoApi,
  createRepoList,
  refreshFor,
  repoStatus,
  sameOrigin,
} from "../listener/repos.mjs";

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
test("repoStatus: configured wins, then onboarding, then unknown, else not onboarded", () => {
  const repo = info("org/a", { private: false, has_issues: false });
  const row = {
    repo: "org/a",
    url: "https://github.com/org/a",
    private: false,
    issues: false,
    status: "not-onboarded",
    issue: null,
  };
  const onboarded = { issue: 4, at: 1 };
  assert.deepEqual(repoStatus(repo, false, null), row);
  assert.deepEqual(repoStatus(repo, true, onboarded), { ...row, status: "configured" });
  const onboarding = {
    ...row,
    status: "onboarding",
    issue: { number: 4, url: "https://github.com/org/a/issues/4" },
  };
  assert.deepEqual(repoStatus(repo, false, onboarded), onboarding);
  // Its config couldn't be read: its onboarding issue still shows.
  assert.deepEqual(repoStatus(repo, null, onboarded), onboarding);
  assert.deepEqual(repoStatus(repo, null, null), { ...row, status: "unknown" });
});

function fakeGitHub({ first = [], second = [], configured = [] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(`${init.method} ${pathname}${searchParams.size ? `?${searchParams}` : ""}`);
    const page = Number(searchParams.get("page") ?? 1);
    const per = Number(searchParams.get("per_page") ?? 30);
    const slice = (all) => all.slice((page - 1) * per, page * per);
    if (pathname === "/app/installations") return Response.json(slice([{ id: 1 }, { id: 2 }]));
    const minted = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (minted) {
      const expires_at = new Date(Date.now() + 3600000).toISOString();
      return Response.json({ token: `tok-${minted[1]}`, expires_at }, { status: 201 });
    }
    if (pathname === "/installation/repositories") {
      const mine = init.headers.authorization === "Bearer tok-1" ? first : second;
      return Response.json({ total_count: mine.length, repositories: slice(mine) });
    }
    const content = /^\/repos\/([^/]+\/[^/]+)\/contents\/\.deckhand\.yaml$/.exec(pathname);
    if (content) {
      if (configured.includes(content[1])) {
        return Response.json({ type: "file", sha: "s", content: btoa("trigger: deckhand\n") });
      }
      return new Response("Not Found", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, calls };
}

function setup({ env = {}, ...repos } = {}) {
  const gh = fakeGitHub(repos);
  const clock = { now: 1_000_000 };
  const app = createGitHubApp({
    credentials: { id: 1, client_id: "Iv1.abc", pem },
    fetch: gh.fetch,
  });
  const config = loadConfig({ ALLOWED_USERS: "alice", ...env });
  const store = createOnboardingStore(join(mkdtempSync(join(tmpdir(), "repos-")), "o.json"));
  const list = createRepoList({ app, config, store, now: () => clock.now });
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

test("same origin: the public URL, or the host the browser asked for", () => {
  const req = (origin, host = "deckhand.example.com") => ({ headers: { origin, host } });
  assert.equal(
    sameOrigin(req("https://deckhand.example.com"), "https://deckhand.example.com"),
    true,
  );
  assert.equal(sameOrigin(req("http://localhost:5173", "localhost:5173"), null), true);
  assert.equal(sameOrigin(req("https://evil.example"), "https://deckhand.example.com"), false);
  assert.equal(sameOrigin(req(undefined), "https://deckhand.example.com"), false);
  assert.equal(sameOrigin(req("null"), "https://deckhand.example.com"), false);
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

function apiSetup(opts) {
  const s = setup(opts);
  const started = [];
  const api = createRepoApi({
    config: s.config,
    list: s.list,
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
