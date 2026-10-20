import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  APP_EVENTS,
  DISCUSSION_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  REFRESH_MS,
  SANDBOX_PERMISSIONS,
  appSettingsUrl,
  checkAppEvents,
  createGitHubApp,
  loadCredentials,
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
});

test("a discussion run's token adds discussions, cached apart from the others", async () => {
  const { app, gh } = setup();
  await app.repoToken("org/repo");
  const { token } = await app.repoToken("org/repo", DISCUSSION_PERMISSIONS);
  assert.equal(token, "tok-2");
  const mints = gh.calls.filter((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mints[1].body).permissions, {
    ...SANDBOX_PERMISSIONS,
    // A light run: it never writes pull requests.
    pull_requests: "read",
    discussions: "write",
  });
  assert.equal(SANDBOX_PERMISSIONS.discussions, undefined);
});

test("a light mode's read-only token is never a cached writing one, nor the reverse", async () => {
  const { app, gh } = setup();
  // The same permission names at other levels: a cache keyed on names alone would mix them.
  await app.repoToken("org/repo", { contents: "write", issues: "write", pull_requests: "write" });
  const { token } = await app.repoToken("org/repo", READ_ONLY_PERMISSIONS);
  assert.equal(token, "tok-2");
  assert.equal((await app.repoToken("org/repo", READ_ONLY_PERMISSIONS)).token, "tok-2");
  const mints = gh.calls.filter((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mints[1].body).permissions, {
    ...SANDBOX_PERMISSIONS,
    contents: "read",
    issues: "read",
    pull_requests: "read",
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

test("checkAppEvents: a warning naming the events the App isn't subscribed to, and where", async () => {
  const logs = [];
  const asApp =
    (events, status = 200, owner = { login: "acme", type: "Organization" }) =>
    async (method, path) => {
      assert.equal(`${method} ${path}`, "GET /app");
      return Response.json(
        { events, name: "Acme Deckhand", slug: "acme-deckhand", owner },
        { status },
      );
    };
  const where = { githubUrl: "https://github.com", credentials: { slug: "old", owner: "me" } };
  const without = APP_EVENTS.filter((e) => e !== "issues");
  assert.deepEqual(await checkAppEvents(asApp(without), (l) => logs.push(l), where), {
    missing: ["issues"],
    app: { name: "Acme Deckhand", slug: "acme-deckhand", owner: "acme", ownerType: "Organization" },
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /isn't subscribed to issues: turn it on .*docs\/setup\.md/);
  assert.ok(
    logs[0].includes("(https://github.com/organizations/acme/settings/apps/acme-deckhand)"),
    logs[0],
  );
  const user = await checkAppEvents(asApp(APP_EVENTS, 200, null), (l) => logs.push(l), where);
  // No owner in the answer: the stored one, its type unknown.
  assert.deepEqual(user, {
    missing: [],
    app: { name: "Acme Deckhand", slug: "acme-deckhand", owner: "me", ownerType: null },
  });
  // GitHub refusing is logged by asApp already.
  assert.deepEqual(await checkAppEvents(asApp([], 401), (l) => logs.push(l)), {
    missing: [],
    app: null,
  });
  assert.equal(logs.length, 1);
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
