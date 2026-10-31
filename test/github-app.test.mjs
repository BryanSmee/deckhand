import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  APP_EVENTS,
  APP_PERMISSIONS,
  DISCUSSION_PERMISSIONS,
  OPTIONAL_PERMISSIONS,
  PERMISSIONS_MS,
  REFRESH_MS,
  SANDBOX_PERMISSIONS,
  WORKFLOW_PUSH_PERMISSIONS,
  appSettingsUrl,
  checkAppSettings,
  createGitHubApp,
  loadCredentials,
  missingPermissions,
  saveCredentials,
} from "../listener/github-app.mjs";
import { recordingFetch, tempDir } from "./helpers.mjs";

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

test("a sandbox token covers its repo only, with the sandbox's permissions", async () => {
  const { app, gh } = setup();
  const { token } = await app.repoToken("Org/Repo");
  assert.equal(token, "tok-1");
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.match(mint.auth, /^Bearer .+\..+\..+$/); // the JWT, not a token
  assert.deepEqual(JSON.parse(mint.body), {
    repositories: ["repo"],
    permissions: SANDBOX_PERMISSIONS,
  });
  assert.equal(SANDBOX_PERMISSIONS.deployments, undefined);
  // Pushes go through the git gateway: a sandbox token never writes the code.
  assert.equal(SANDBOX_PERMISSIONS.contents, "read");
  // Nor reviews, which `pull_requests: write` would let it approve: the gateway adds it to the
  // checked writes of its own pull requests only (github-pulls.mjs).
  assert.equal(SANDBOX_PERMISSIONS.pull_requests, "read");
});

test("a discussion run's token adds discussions, cached apart from the others", async () => {
  const { app, gh } = setup();
  await app.repoToken("org/repo");
  const { token } = await app.repoToken("org/repo", DISCUSSION_PERMISSIONS);
  assert.equal(token, "tok-2");
  const mints = gh.calls.filter((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mints[1].body).permissions, {
    ...SANDBOX_PERMISSIONS,
    discussions: "read",
  });
  assert.equal(SANDBOX_PERMISSIONS.discussions, undefined);
});

test("a read-only token is never a cached writing one, nor the reverse", async () => {
  const { app, gh } = setup();
  // The same permission names at other levels: a cache keyed on names alone would mix them.
  const reads = { contents: "read", issues: "read", pull_requests: "read" };
  await app.repoToken("org/repo", { contents: "write", issues: "write", pull_requests: "write" });
  const { token } = await app.repoToken("org/repo", reads);
  assert.equal(token, "tok-2");
  assert.equal((await app.repoToken("org/repo", reads)).token, "tok-2");
  const mints = gh.calls.filter((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mints[1].body).permissions, {
    ...SANDBOX_PERMISSIONS,
    contents: "read",
    issues: "read",
    pull_requests: "read",
  });
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
    ...SANDBOX_PERMISSIONS,
    contents: "write",
    workflows: "write",
  });
});

test("tokens are cached, and renewed before they run out", async () => {
  const { app, gh, clock } = setup();
  await app.repoToken("org/repo");
  assert.equal((await app.repoToken("org/repo")).token, "tok-1");
  assert.equal(gh.calls.filter((c) => c.path === "/repos/org/repo/installation").length, 1);
  // 55 minutes later, less than REFRESH_MS is left: a new one.
  clock.now += 60 * 60000 - REFRESH_MS + 1;
  assert.equal((await app.repoToken("org/repo")).token, "tok-2");
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
  assert.equal(statSync(join(dir, "app.json")).mode & 0o777, 0o600);
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

// An installation without one of the sandbox's required permissions (contents).
const { contents: _, ...withoutContents } = SANDBOX_PERMISSIONS;

test("a failing token fails every caller waiting on it, from one call to GitHub", async () => {
  const { app, gh } = installedWith(withoutContents);
  const all = await Promise.allSettled([1, 2, 3, 4].map(() => app.repoToken("org/repo")));
  assert.ok(all.every((r) => r.status === "rejected" && r.reason.status === 422));
  assert.equal(gh.calls.filter((c) => c.path.endsWith("/access_tokens")).length, 1);
  // Not cached: the next one asks again.
  await assert.rejects(app.repoToken("org/repo"), { status: 422 });
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
  const granted = { ...SANDBOX_PERMISSIONS, actions: undefined };
  const { app, gh, clock, html_url } = installedWith(granted);
  assert.equal((await app.repoToken("org/repo")).token, "tok-1");
  const mints = () => gh.calls.filter((c) => c.path.endsWith("/access_tokens"));
  const { actions, ...rest } = SANDBOX_PERMISSIONS;
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
  assert.equal((await app.repoToken("org/repo")).token, "tok-2");
  assert.deepEqual(JSON.parse(mints()[1].body).permissions, SANDBOX_PERMISSIONS);
  assert.equal(await app.lacking("org/repo", { actions: "read" }), null);
  // Without a delivery, GitHub is asked again once PERMISSIONS_MS went by.
  delete granted.actions;
  clock.now += PERMISSIONS_MS;
  // The token without it, still fresh.
  assert.equal((await app.repoToken("org/repo")).token, "tok-1");
  assert.equal(gh.calls.filter((c) => c.path === "/app/installations/7").length, 1);
});

test("organization_projects: optional, so an installation that lacks it still mints run tokens", async () => {
  assert.ok(OPTIONAL_PERMISSIONS.has("organization_projects"));
  assert.equal(APP_PERMISSIONS.organization_projects, "write");
  // Not every run's: only a granted repo's reads (PROJECT_READ) and project writes ask for it.
  assert.equal(SANDBOX_PERMISSIONS.organization_projects, undefined);
  const { app, gh, html_url } = installedWith({ ...SANDBOX_PERMISSIONS });
  assert.equal(
    (await app.repoToken("org/repo", { organization_projects: "write" })).token,
    "tok-1",
  );
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mint.body).permissions, SANDBOX_PERMISSIONS);
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
    assert.equal(SANDBOX_PERMISSIONS[name], "read", name);
  }
  assert.ok(APP_EVENTS.includes("check_suite") && APP_EVENTS.includes("status"));
  // An installation that hasn't accepted them: its runs' tokens go without them, and work.
  const granted = { ...SANDBOX_PERMISSIONS, checks: undefined, statuses: undefined };
  const { app, gh } = installedWith(granted);
  assert.equal((await app.repoToken("org/repo")).token, "tok-1");
  const { checks: _, statuses: __, ...rest } = SANDBOX_PERMISSIONS;
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mint.body).permissions, rest);
  assert.deepEqual((await app.lacking("org/repo", { checks: "read", statuses: "read" })).missing, [
    "checks: read",
    "statuses: read",
  ]);
});

test("a required permission the installation lacks still fails the token", async () => {
  const { app, gh } = installedWith(withoutContents);
  await assert.rejects(app.repoToken("org/repo"), { status: 422 });
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.equal(JSON.parse(mint.body).permissions.contents, "read");
  // Only optional ones are the gateway's to name.
  assert.equal(await app.lacking("org/repo", { contents: "read" }), null);
});

test("an installation's permissions GitHub can't say: the token asks for everything", async () => {
  const { app, gh } = setup();
  app.remember("org/repo", 7); // from a delivery: its permissions unknown
  await app.repoToken("org/repo");
  assert.equal(gh.calls.filter((c) => c.path === "/app/installations/7").length, 1);
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mint.body).permissions, SANDBOX_PERMISSIONS);
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
