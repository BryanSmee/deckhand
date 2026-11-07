import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import {
  APP_EVENTS,
  APP_PERMISSIONS,
  ISSUES_WRITE,
  OPTIONAL_PERMISSIONS,
  PERMISSIONS_MS,
  RATE_WAIT_MAX_MS,
  READ_PERMISSIONS,
  REFRESH_MS,
  RETRY_DELAYS,
  WORKFLOW_PUSH_PERMISSIONS,
  appSettingsUrl,
  checkAppSettings,
  createGitHubApp,
  loadCredentials,
  missingPermissions,
  readsGitHub,
  readsOf,
  repeatable,
  tunnelsGitHub,
  saveCredentials,
} from "../listener/github-app.mjs";
import { assertMode, recordingFetch, tempDir } from "./helpers.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs1", format: "pem" });
const credentials = {
  id: 1,
  client_id: "Iv1.abc",
  slug: "my-deckhand",
  bot_id: 42,
  pem,
};

// A fake GitHub: records the calls, answers installation lookups and token requests.
function fakeGitHub(clock) {
  let n = 0;
  return recordingFetch(({ path }) => {
    if (path === "/repos/org/repo/installation") return { id: 7 };
    if (path === "/repos/org/gone/installation") return undefined;
    if (path === "/app/installations/7/access_tokens") {
      n++;
      const expires_at = new Date(clock.now + 60 * 60000).toISOString();
      return Response.json({ token: `tok-${n}`, expires_at }, { status: 201 });
    }
    return { id: 1 };
  });
}

function setup() {
  const clock = { now: Date.parse("2026-10-14T12:00:00Z") };
  const gh = fakeGitHub(clock);
  const app = createGitHubApp({
    credentials,
    fetch: gh.fetch,
    now: () => clock.now,
  });
  return { clock, gh, app };
}

// What a work run's token reads (readsOf()), and a checked write of one's (issue #497).
const READS = readsOf(["pull", "read:issues", "read:pulls", "read:actions"]);
const RUN_TOKEN = { ...READS, ...ISSUES_WRITE };

test("the App's JWT is signed with its key and short-lived", () => {
  const { app, clock } = setup();
  const [header, claims, signature] = app.jwt().split(".");
  const ok = createVerify("RSA-SHA256")
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature, "base64url"));
  assert.equal(ok, true);
  const body = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(body.iss, "Iv1.abc");
  assert.ok(body.exp - body.iat <= 10 * 60);
  assert.ok(body.iat <= clock.now / 1000);
});

test("a sandbox token covers its repo only, with exactly the permissions asked and its metadata", async () => {
  const { app, gh } = setup();
  const { token } = await app.repoToken("Org/Repo", READS);
  assert.equal(token, "tok-1");
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.match(mint.auth, /^Bearer .+\..+\..+$/); // the JWT, not a token
  assert.deepEqual(JSON.parse(mint.body), { repositories: ["repo"], permissions: READS });
  // Nothing beyond what it asks: no issues without them.
  await app.repoToken("org/repo", {});
  const bare = gh.calls.filter((c) => c.path.endsWith("/access_tokens")).at(-1);
  assert.deepEqual(JSON.parse(bare.body).permissions, { metadata: "read" });
});

test("readsOf: each read capability's permissions, only read; every token reads its metadata", () => {
  assert.deepEqual(readsOf(), { metadata: "read" });
  assert.deepEqual(readsOf(["push", "setup", "internet"]), { metadata: "read" });
  assert.deepEqual(readsOf(["pull"]), { metadata: "read", contents: "read" });
  assert.deepEqual(readsOf(["read:issues"]), { metadata: "read", issues: "read" });
  assert.deepEqual(readsOf(["read:pulls"]), { metadata: "read", pull_requests: "read" });
  assert.deepEqual(readsOf(["read:discussions"]), { metadata: "read", discussions: "read" });
  assert.deepEqual(readsOf(["read:actions"]), {
    metadata: "read",
    actions: "read",
    checks: "read",
    statuses: "read",
  });
  // Never a write: pushes go through the git gateway, and `pull_requests: write` would let a
  // run approve pull requests (the gateway adds writes to checked writes only).
  for (const names of Object.values(READ_PERMISSIONS)) {
    for (const name of names) assert.notEqual(name, "deployments");
  }
  assert.ok(Object.values(readsOf(Object.keys(READ_PERMISSIONS))).every((l) => l === "read"));
  // Nothing from GitHub without `pull`.
  assert.equal(readsGitHub({ caps: ["read:issues"] }), false);
  assert.equal(readsGitHub({ caps: ["pull"] }), true);
  assert.equal(readsGitHub(undefined), false);
  // A tunnel to GitHub only once its capabilities are decided without `pull`: an unknown run, or
  // one before its start decided them, goes to the gateway, which refuses it.
  assert.equal(tunnelsGitHub({ caps: ["internet"], decided: true }), true);
  assert.equal(tunnelsGitHub({ caps: ["pull"], decided: true }), false);
  assert.equal(tunnelsGitHub({ caps: [], decided: false }), false);
  assert.equal(tunnelsGitHub(undefined), false);
});

test("a discussion run's reads add discussions, cached apart from the others", async () => {
  const { app, gh } = setup();
  // Required: only discussion runs read them, and their token fails without.
  assert.equal(OPTIONAL_PERMISSIONS.has("discussions"), false);
  await app.repoToken("org/repo", READS);
  const discussion = readsOf([
    "pull",
    "read:issues",
    "read:pulls",
    "read:actions",
    "read:discussions",
  ]);
  const { token } = await app.repoToken("org/repo", discussion);
  assert.equal(token, "tok-2");
  const mints = gh.calls.filter((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mints[1].body).permissions, { ...READS, discussions: "read" });
});

test("a read-only token is never a cached writing one, nor the reverse", async () => {
  const { app, gh } = setup();
  // The same permission names at other levels: a cache keyed on names alone would mix them.
  const reads = { contents: "read", issues: "read", pull_requests: "read" };
  await app.repoToken("org/repo", { contents: "write", issues: "write", pull_requests: "write" });
  const { token } = await app.repoToken("org/repo", READS);
  assert.equal(token, "tok-2");
  assert.equal((await app.repoToken("org/repo", READS)).token, "tok-2");
  const mints = gh.calls.filter((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mints[1].body).permissions, READS);
});

test("a token the installation can't give fails with GitHub's status, and isn't cached", async () => {
  const clock = { now: Date.parse("2026-10-14T12:00:00Z") };
  let refuse = true;
  const gh = recordingFetch(({ path, body }) => {
    if (path === "/repos/org/repo/installation") return { id: 7 };
    if (refuse && JSON.parse(body).permissions.workflows) {
      return Response.json({ message: "not granted" }, { status: 422 });
    }
    const expires_at = new Date(clock.now + 60 * 60000).toISOString();
    return Response.json({ token: "tok", expires_at }, { status: 201 });
  });
  const app = createGitHubApp({ credentials, fetch: gh.fetch, now: () => clock.now });
  await assert.rejects(app.repoToken("org/repo", WORKFLOW_PUSH_PERMISSIONS), { status: 422 });
  // Once the operator accepted the permission: the next push gets it.
  refuse = false;
  assert.equal((await app.repoToken("org/repo", WORKFLOW_PUSH_PERMISSIONS)).token, "tok");
  const mint = gh.calls.filter((c) => c.path.endsWith("/access_tokens")).at(-1);
  assert.deepEqual(JSON.parse(mint.body).permissions, {
    metadata: "read",
    contents: "write",
    workflows: "write",
  });
});

test("tokens are cached, and renewed before they run out", async () => {
  const { app, gh, clock } = setup();
  await app.repoToken("org/repo", RUN_TOKEN);
  assert.equal((await app.repoToken("org/repo", RUN_TOKEN)).token, "tok-1");
  assert.equal(gh.calls.filter((c) => c.path === "/repos/org/repo/installation").length, 1);
  // 55 minutes later, less than REFRESH_MS is left: a new one.
  clock.now += 60 * 60000 - REFRESH_MS + 1;
  assert.equal((await app.repoToken("org/repo", RUN_TOKEN)).token, "tok-2");
});

test("the listener's own calls use an installation token", async () => {
  const { app, gh } = setup();
  app.remember("Org/Repo", 7); // from the webhook payload: no lookup
  await app.request("org/repo", "POST", "/repos/org/repo/issues/1/comments", {
    body: "hi",
  });
  assert.equal(
    gh.calls.some((c) => c.path.endsWith("/installation")),
    false,
  );
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.equal(mint.body, undefined); // whole installation
  assert.equal(gh.calls.at(-1).auth, "Bearer tok-1");
});

test("a repo without the App gets no token, and the failure is not cached", async () => {
  const { app } = setup();
  await assert.rejects(app.repoToken("org/gone"), /404/);
  await assert.rejects(app.repoToken("org/gone"), /404/);
});

test("commits come from the App's bot", () => {
  const { app } = setup();
  assert.deepEqual(app.identity(), {
    name: "my-deckhand[bot]",
    email: "42+my-deckhand[bot]@users.noreply.github.com",
  });
});

test("credentials are stored owner-only and read back", (t) => {
  const dir = tempDir(t);
  assert.equal(loadCredentials(dir), null);
  saveCredentials(dir, credentials);
  assertMode(join(dir, "app.json"), 0o600);
  assert.deepEqual(loadCredentials(dir), credentials);
});

// A fake GET /app, as `asApp` answers it.
const appAnswers =
  ({
    events = APP_EVENTS,
    permissions = APP_PERMISSIONS,
    status = 200,
    owner = { login: "acme", type: "Organization" },
  } = {}) =>
  async (method, path) => {
    assert.equal(`${method} ${path}`, "GET /app");
    return Response.json(
      { events, permissions, name: "Acme Deckhand", slug: "acme-deckhand", owner },
      { status },
    );
  };

test("checkAppSettings: a warning naming the events the App isn't subscribed to, and where", async () => {
  const logs = [];
  const where = { githubUrl: "https://github.com", credentials: { slug: "old", owner: "me" } };
  const without = APP_EVENTS.filter((e) => e !== "issues");
  const asApp = appAnswers({ events: without });
  assert.deepEqual(await checkAppSettings(asApp, (l) => logs.push(l), where), {
    missing: ["issues"],
    permissions: [],
    app: { name: "Acme Deckhand", slug: "acme-deckhand", owner: "acme", ownerType: "Organization" },
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /isn't subscribed to issues: turn it on .*docs\/setup\.md/);
  assert.ok(
    logs[0].includes("(https://github.com/organizations/acme/settings/apps/acme-deckhand)"),
    logs[0],
  );
  const user = await checkAppSettings(appAnswers({ owner: null }), (l) => logs.push(l), where);
  // No owner in the answer: the stored one, its type unknown.
  assert.deepEqual(user, {
    missing: [],
    permissions: [],
    app: { name: "Acme Deckhand", slug: "acme-deckhand", owner: "me", ownerType: null },
  });
  // GitHub refusing is logged by asApp already.
  assert.deepEqual(await checkAppSettings(appAnswers({ status: 401 }), (l) => logs.push(l)), {
    missing: [],
    permissions: [],
    app: null,
  });
  assert.equal(logs.length, 1);
});

test("checkAppSettings: the permissions the App lacks, at a lower level or not at all", async () => {
  const logs = [];
  const where = { githubUrl: "https://github.com" };
  // No discussions, and workflows read only where Deckhand asks to write them.
  const asApp = appAnswers({
    permissions: { ...APP_PERMISSIONS, discussions: undefined, workflows: "read" },
  });
  const checked = await checkAppSettings(asApp, (l) => logs.push(l), where);
  assert.deepEqual(checked.permissions, ["discussions: write", "workflows: write"]);
  assert.equal(logs.length, 1);
  assert.match(
    logs[0],
    /lacks the permissions discussions: write, workflows: write: add them under Permissions in its settings \(https:\/\/github\.com\/organizations\/acme\/settings\/apps\/acme-deckhand\), then accept them on each installation/,
  );
});

test("checkAppSettings: one permission the App lacks, said in the singular, every event subscribed", async () => {
  const logs = [];
  const asApp = appAnswers({ permissions: { ...APP_PERMISSIONS, discussions: undefined } });
  const checked = await checkAppSettings(asApp, (l) => logs.push(l), {
    githubUrl: "https://github.com",
  });
  assert.deepEqual(checked.missing, []);
  assert.deepEqual(checked.permissions, ["discussions: write"]);
  assert.deepEqual(logs, [
    "The GitHub App lacks the permission discussions: write: add it under Permissions in its settings (https://github.com/organizations/acme/settings/apps/acme-deckhand), then accept it on each installation (docs/guides/github-app.md)",
  ]);
});

// An installation without one of the sandbox's required permissions (contents).
const { contents: _, ...withoutContents } = READS;

test("a failing token fails every caller waiting on it, from one call to GitHub", async () => {
  const { app, gh } = installedWith(withoutContents);
  const all = await Promise.allSettled([1, 2, 3, 4].map(() => app.repoToken("org/repo", READS)));
  assert.ok(all.every((r) => r.status === "rejected" && r.reason.status === 422));
  assert.equal(gh.calls.filter((c) => c.path.endsWith("/access_tokens")).length, 1);
  // Not cached: the next one asks again.
  await assert.rejects(app.repoToken("org/repo", RUN_TOKEN), { status: 422 });
  assert.equal(gh.calls.filter((c) => c.path.endsWith("/access_tokens")).length, 2);
});

test("missingPermissions: what's absent or at a lower level, a higher one is enough", () => {
  const wanted = { issues: "write", metadata: "read", actions: "read" };
  assert.deepEqual(missingPermissions({ issues: "read", metadata: "read" }, wanted), [
    "issues: write",
    "actions: read",
  ]);
  assert.deepEqual(
    missingPermissions({ issues: "admin", metadata: "write", actions: "read" }, wanted),
    [],
  );
  assert.equal(missingPermissions(undefined).length, Object.keys(APP_PERMISSIONS).length);
});

// GitHub as an installation that has `granted`: its lookup, its own page, and tokens it
// refuses (422) when they ask for more.
function installedWith(granted, clock = { now: Date.parse("2026-10-14T12:00:00Z") }) {
  const html_url = "https://github.com/organizations/org/settings/installations/7";
  const installation = () => ({ id: 7, account: { login: "org" }, html_url, permissions: granted });
  let n = 0;
  const gh = recordingFetch(({ path, body }) => {
    if (path === "/repos/org/repo/installation") return installation();
    if (path === "/app/installations/7") return installation();
    if (path === "/app/installations/7/access_tokens") {
      const asked = missingPermissions(granted, JSON.parse(body).permissions);
      if (asked.length) return Response.json({ message: "not granted" }, { status: 422 });
      const expires_at = new Date(clock.now + 60 * 60000).toISOString();
      return Response.json({ token: `tok-${++n}`, expires_at }, { status: 201 });
    }
  });
  const app = createGitHubApp({ credentials, fetch: gh.fetch, now: () => clock.now });
  return { app, gh, clock, html_url };
}

test("an optional permission the installation lacks: the token goes without it", async () => {
  assert.ok(OPTIONAL_PERMISSIONS.has("actions"));
  const granted = { ...RUN_TOKEN, actions: undefined };
  const { app, gh, clock, html_url } = installedWith(granted);
  assert.equal((await app.repoToken("org/repo", RUN_TOKEN)).token, "tok-1");
  const mints = () => gh.calls.filter((c) => c.path.endsWith("/access_tokens"));
  const { actions, ...rest } = RUN_TOKEN;
  assert.equal(actions, "read");
  assert.deepEqual(JSON.parse(mints()[0].body).permissions, rest);
  // What the gateway names when a call needs it.
  assert.deepEqual(await app.lacking("org/repo", { actions: "read", issues: "write" }), {
    missing: ["actions: read"],
    account: "org",
    url: html_url,
  });
  assert.equal(await app.lacking("org/repo", { issues: "write" }), null);
  // The lookup said what it was granted: GitHub isn't asked again until PERMISSIONS_MS.
  assert.equal(gh.calls.filter((c) => c.path === "/app/installations/7").length, 0);
  // An owner accepts it: the delivery says so, and the next token asks for it again.
  granted.actions = "read";
  app.rememberPermissions({ id: 7, permissions: { ...granted } });
  assert.equal((await app.repoToken("org/repo", RUN_TOKEN)).token, "tok-2");
  assert.deepEqual(JSON.parse(mints()[1].body).permissions, RUN_TOKEN);
  assert.equal(await app.lacking("org/repo", { actions: "read" }), null);
  // Without a delivery, GitHub is asked again once PERMISSIONS_MS went by.
  delete granted.actions;
  clock.now += PERMISSIONS_MS;
  // The token without it, still fresh.
  assert.equal((await app.repoToken("org/repo", RUN_TOKEN)).token, "tok-1");
  assert.equal(gh.calls.filter((c) => c.path === "/app/installations/7").length, 1);
});

test("organization_projects: optional, so an installation that lacks it still mints run tokens", async () => {
  assert.ok(OPTIONAL_PERMISSIONS.has("organization_projects"));
  assert.equal(APP_PERMISSIONS.organization_projects, "write");
  // Not every run's: only a granted repo's reads (PROJECT_READ) and project writes ask for it.
  assert.equal(RUN_TOKEN.organization_projects, undefined);
  const { app, gh, html_url } = installedWith({ ...RUN_TOKEN });
  assert.equal(
    (await app.repoToken("org/repo", { ...RUN_TOKEN, organization_projects: "write" })).token,
    "tok-1",
  );
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mint.body).permissions, RUN_TOKEN);
  assert.deepEqual(await app.lacking("org/repo", { organization_projects: "write" }), {
    missing: ["organization_projects: write"],
    account: "org",
    url: html_url,
  });
});

test("checks and statuses: optional, in the App's and the runs' permissions, events subscribed", async () => {
  for (const name of ["checks", "statuses"]) {
    assert.ok(OPTIONAL_PERMISSIONS.has(name), name);
    assert.equal(APP_PERMISSIONS[name], "read", name);
    assert.equal(RUN_TOKEN[name], "read", name);
  }
  assert.ok(APP_EVENTS.includes("check_suite") && APP_EVENTS.includes("status"));
  // An installation that hasn't accepted them: its runs' tokens go without them, and work.
  const granted = { ...RUN_TOKEN, checks: undefined, statuses: undefined };
  const { app, gh } = installedWith(granted);
  assert.equal((await app.repoToken("org/repo", RUN_TOKEN)).token, "tok-1");
  const { checks: _, statuses: __, ...rest } = RUN_TOKEN;
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mint.body).permissions, rest);
  assert.deepEqual((await app.lacking("org/repo", { checks: "read", statuses: "read" })).missing, [
    "checks: read",
    "statuses: read",
  ]);
});

test("a required permission the installation lacks still fails the token", async () => {
  const { app, gh } = installedWith(withoutContents);
  await assert.rejects(app.repoToken("org/repo", READS), { status: 422 });
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.equal(JSON.parse(mint.body).permissions.contents, "read");
  // Only optional ones are the gateway's to name.
  assert.equal(await app.lacking("org/repo", { contents: "read" }), null);
});

test("an installation's permissions GitHub can't say: the token asks for everything", async () => {
  const { app, gh } = setup();
  app.remember("org/repo", 7); // from a delivery: its permissions unknown
  await app.repoToken("org/repo", RUN_TOKEN);
  assert.equal(gh.calls.filter((c) => c.path === "/app/installations/7").length, 1);
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mint.body).permissions, RUN_TOKEN);
  assert.equal(await app.lacking("org/repo", { actions: "read" }), null);
});

test("appSettingsUrl: under the organization that owns the App, else the user's settings", () => {
  const app = { slug: "my-app", owner: "acme" };
  const ghes = "https://ghe.example.com";
  assert.equal(
    appSettingsUrl(ghes, { ...app, ownerType: "Organization" }),
    "https://ghe.example.com/organizations/acme/settings/apps/my-app",
  );
  assert.equal(appSettingsUrl(ghes, { ...app, ownerType: "User" }), `${ghes}/settings/apps/my-app`);
  assert.equal(appSettingsUrl(ghes, { ...app, ownerType: null }), `${ghes}/settings/apps/my-app`);
});

test("APP_EVENTS: no event twice", () => {
  assert.equal(new Set(APP_EVENTS).size, APP_EVENTS.length);
});

test("discussions: an installation without them mints no discussion run's token", async () => {
  const { app } = installedWith({ ...RUN_TOKEN });
  await assert.rejects(app.repoToken("org/repo", { ...READS, discussions: "read" }), {
    status: 422,
  });
});

// GitHub answering `answers` in turn for calls to /repos/org/repo/x (a status, a Response, or
// an Error thrown as fetch() would), then 200; the waits and lines logged recorded.
function flaky(answers) {
  const clock = { now: Date.parse("2026-10-14T12:00:00Z") };
  const tokens = fakeGitHub(clock);
  const left = [...answers];
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (!pathname.startsWith("/repos/org/repo/x")) return tokens.fetch(url, init);
    calls.push(init.method ?? "GET");
    const next = left.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    if (next) return new Response(`{"message":"${next}"}`, { status: next });
    return Response.json({ ok: true });
  };
  const waits = [];
  const logs = [];
  const app = createGitHubApp({
    credentials,
    fetch,
    now: () => clock.now,
    log: (line) => logs.push(line),
    sleep: async (ms) => waits.push(ms),
  });
  app.remember("org/repo", 7);
  return { app, calls, waits, logs };
}

test("a read GitHub fails once or twice (500, 503) is tried again after a short wait, each retry logged", async () => {
  const { app, calls, waits, logs } = flaky([500, 503]);
  const res = await app.request("org/repo", "GET", "/repos/org/repo/x");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, RETRY_DELAYS.slice(0, 2));
  assert.deepEqual(logs, [
    "GitHub GET /repos/org/repo/x: 500, tried again in 1 s (attempt 2)",
    "GitHub GET /repos/org/repo/x: 503, tried again in 3 s (attempt 3)",
  ]);
});

test("a read GitHub keeps failing is answered as GitHub left it, after every try", async () => {
  const { app, calls, waits, logs } = flaky([502, 502, 502, 502, 502]);
  const res = await app.request("org/repo", "GET", "/repos/org/repo/x");
  assert.equal(res.status, 502);
  assert.equal(calls.length, RETRY_DELAYS.length + 1);
  assert.deepEqual(waits, RETRY_DELAYS);
  assert.equal(logs.at(-1), 'GitHub GET /repos/org/repo/x: 502 {"message":"502"}');
});

test("no answer at all is tried again too; still none, the error is thrown", async () => {
  const once = flaky([new TypeError("fetch failed")]);
  assert.equal((await once.app.request("org/repo", "GET", "/repos/org/repo/x")).status, 200);
  assert.match(once.logs[0], /fetch failed, tried again in 1 s \(attempt 2\)/);
  const never = flaky(Array.from({ length: 4 }, () => new TypeError("fetch failed")));
  await assert.rejects(never.app.request("org/repo", "GET", "/repos/org/repo/x"), /fetch failed/);
  assert.equal(never.calls.length, 4);
});

test("a POST, a DELETE or a merge GitHub failed is never sent again; a PUT or PATCH is", async () => {
  for (const method of ["POST", "DELETE"]) {
    const { app, calls, waits } = flaky([500]);
    assert.equal((await app.request("org/repo", method, "/repos/org/repo/x", {})).status, 500);
    assert.deepEqual([calls.length, waits], [1, []]);
  }
  const merge = flaky([502]);
  const res = await merge.app.request("org/repo", "PUT", "/repos/org/repo/x/pulls/1/merge", {});
  assert.deepEqual([res.status, merge.calls.length], [502, 1]);
  for (const method of ["PUT", "PATCH"]) {
    const { app, calls } = flaky([504]);
    assert.equal((await app.request("org/repo", method, "/repos/org/repo/x", {})).status, 200);
    assert.equal(calls.length, 2);
  }
  assert.equal(repeatable("HEAD", "/x"), true);
  assert.equal(repeatable("POST", "/graphql"), false);
});

test("GitHub's retry-after is waited for; a secondary rate limit doesn't count as a failed try", async () => {
  const limited = () =>
    new Response('{"message":"You have exceeded a secondary rate limit"}', {
      status: 403,
      headers: { "retry-after": "2" },
    });
  const later = new Response("busy", { status: 503, headers: { "retry-after": "5" } });
  // Three hiccups and a rate limit among them: only the hiccups are tries (RETRY_DELAYS' three).
  const read = flaky([limited(), 500, later, 500]);
  assert.equal((await read.app.request("org/repo", "GET", "/repos/org/repo/x")).status, 200);
  assert.deepEqual(read.waits, [2000, 1000, 5000, 9000]);
  assert.match(read.logs[0], /rate limited, tried again in 2 s \(attempt 2\)/);
  // A rate limit refused the call: even a POST goes again once it's over, a minute when GitHub
  // says nothing.
  const post = flaky([429]);
  assert.equal((await post.app.request("org/repo", "POST", "/repos/org/repo/x", {})).status, 200);
  assert.deepEqual(post.waits, [RATE_WAIT_MAX_MS]);
});

test("the primary rate limit, or a wait longer than RATE_WAIT_MAX_MS, is answered as it is", async () => {
  const primary = new Response("API rate limit exceeded", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "retry-after": "1" },
  });
  const long = new Response("slow down", { status: 429, headers: { "retry-after": "3600" } });
  for (const answer of [primary, long]) {
    const { app, calls, waits } = flaky([answer]);
    const res = await app.request("org/repo", "GET", "/repos/org/repo/x");
    assert.deepEqual([res.status, calls.length, waits], [answer.status, 1, []]);
  }
  // A 403 that isn't a rate limit is a refusal.
  const refused = flaky([403]);
  assert.equal((await refused.app.request("org/repo", "GET", "/repos/org/repo/x")).status, 403);
  assert.equal(refused.calls.length, 1);
});
