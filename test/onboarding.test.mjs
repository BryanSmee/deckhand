import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import {
  branchConfigReport,
  createOnboarding,
  createOnboardingStore,
  ONBOARDING_LABEL,
  onboardingTargets,
} from "../listener/onboarding.mjs";

const config = loadConfig({ ALLOWED_USERS: "alice,bob", ALLOWED_REPOS: "org/app,org/lib" });

function installation(event, sender = "alice", repos = ["org/app"]) {
  const list = repos.map((full_name) => ({ full_name }));
  return {
    action: event === "installation" ? "created" : "added",
    installation: { id: 7 },
    sender: { login: sender },
    ...(event === "installation" ? { repositories: list } : { repositories_added: list }),
  };
}

function targets(cfg, event, payload) {
  const reasons = [];
  const repos = onboardingTargets(cfg, event, payload, (r) => (reasons.push(r), null));
  return { repos, reasons };
}

test("installation deliveries: the allowed repos, when the installer is an allowed user", () => {
  for (const event of ["installation", "installation_repositories"]) {
    const { repos, reasons } = targets(
      config,
      event,
      installation(event, "Alice", ["org/app", "org/lib", "org/other"]),
    );
    // Every allowed repo, no cap; the other one is skipped with its reason.
    assert.deepEqual(repos, ["org/app", "org/lib"]);
    assert.deepEqual(reasons, [`${event}: org/other not in ALLOWED_REPOS`]);
  }
  // Without ALLOWED_REPOS, every repo of the installation.
  const open = loadConfig({ ALLOWED_USERS: "alice" });
  const many = Array.from({ length: 30 }, (_, i) => `org/r${i}`);
  assert.equal(
    targets(open, "installation", installation("installation", "alice", many)).repos.length,
    30,
  );
});

test("installation deliveries: an unknown installer, other actions, ONBOARDING=off", () => {
  const unknown = targets(config, "installation", installation("installation", "mallory"));
  assert.deepEqual(unknown.repos, []);
  assert.match(
    unknown.reasons[0],
    /mallory not in ALLOWED_USERS, no onboarding issue for org\/app/,
  );

  const removed = { ...installation("installation_repositories"), action: "removed" };
  assert.deepEqual(targets(config, "installation_repositories", removed).repos, []);
  const deleted = { ...installation("installation"), action: "deleted" };
  assert.deepEqual(targets(config, "installation", deleted).repos, []);
  const forged = { ...installation("installation"), installation: undefined };
  assert.match(targets(config, "installation", forged).reasons[0], /not from an installation/);

  const off = loadConfig({ ALLOWED_USERS: "alice", ONBOARDING: "off" });
  assert.equal(off.onboarding, false);
  assert.equal(config.onboarding, true);
  const skipped = targets(off, "installation", installation("installation"));
  assert.deepEqual(skipped.repos, []);
  assert.match(skipped.reasons[0], /ONBOARDING=off/);
});

test("onboarding.json: the onboarded repos are kept across a restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "deckhand-")), "onboarding.json");
  const store = createOnboardingStore(path);
  assert.equal(store.get("org/app"), null);
  store.record("Org/App", 4, 1000);
  const again = createOnboardingStore(path);
  assert.deepEqual(again.get("org/app"), { issue: 4, at: 1000 });
  assert.equal(again.isIssue("org/app", 4), true);
  assert.equal(again.isIssue("org/app", 5), false);
});

// GitHub as `routes` says: "METHOD path" → [status, body], 404 for anything else.
function fakeRequest(routes) {
  const calls = [];
  const request = async (repo, method, path, body) => {
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    const [status, answer] = typeof route === "function" ? route(body) : (route ?? [404, {}]);
    return new Response(JSON.stringify(answer), { status });
  };
  return { request, calls };
}

const file = (text) => [
  200,
  { type: "file", sha: "x", content: Buffer.from(text).toString("base64") },
];

function onboardingWith(
  routes,
  store = createOnboardingStore(join(mkdtempSync(join(tmpdir(), "deckhand-")), "o.json")),
) {
  const { request, calls } = fakeRequest({
    "GET /repos/org/app": [200, { default_branch: "trunk", has_issues: true }],
    "POST /repos/org/app/labels": [201, {}],
    "POST /repos/org/app/issues": [201, { number: 30 }],
    ...routes,
  });
  const logs = [];
  const onboarding = createOnboarding({ request, store, config, log: (l) => logs.push(l) });
  return { onboarding, calls, logs, store };
}

test("the onboarding issue: labelled, mentioning the installer, recorded once", async () => {
  const { onboarding, calls, store } = onboardingWith({});
  // Two deliveries at once: one issue.
  const [first, second] = await Promise.all([
    onboarding.open("org/app", "alice"),
    onboarding.open("org/app", "alice"),
  ]);
  assert.deepEqual(first, {
    number: 30,
    title: "Set up Deckhand for this repository",
    base: "trunk",
  });
  assert.equal(second, null);
  // The config was looked for on the default branch.
  assert.ok(calls.some((c) => c.path === "/repos/org/app/contents/.deckhand.yaml?ref=trunk"));
  const label = calls.find((c) => c.path === "/repos/org/app/labels");
  assert.equal(label.body.name, ONBOARDING_LABEL);
  const issue = calls.find((c) => c.path === "/repos/org/app/issues");
  assert.deepEqual(issue.body.labels, [ONBOARDING_LABEL]);
  assert.match(issue.body.body, /^@alice installed Deckhand/);
  assert.match(issue.body.body, /first line is `Deckhand`/);
  assert.deepEqual(store.get("org/app").issue, 30);
  assert.equal(calls.filter((c) => c.path === "/repos/org/app/issues").length, 1);
  // Already onboarded (a reinstall): no second issue.
  assert.equal(await onboarding.open("org/app", "alice"), null);
  assert.equal(calls.filter((c) => c.path === "/repos/org/app/issues").length, 1);
});

test("no onboarding issue with a config on the default branch, or issues disabled", async () => {
  const configured = onboardingWith({
    "GET /repos/org/app/contents/.deckhand.yaml?ref=trunk": file("model: opus\n"),
  });
  assert.equal(await configured.onboarding.open("org/app", "alice"), null);
  assert.match(configured.logs[0], /\.deckhand\.yaml is already on trunk/);
  assert.equal(configured.store.get("org/app"), null);

  const closed = onboardingWith({ "GET /repos/org/app": [200, { has_issues: false }] });
  assert.equal(await closed.onboarding.open("org/app", "alice"), null);
  assert.match(closed.logs[0], /issues are disabled/);
  for (const { calls } of [configured, closed]) {
    assert.equal(
      calls.some((c) => c.method === "POST"),
      false,
    );
  }
});

const PULLS = [
  200,
  [{ number: 31, head: { ref: "issue-30-deckhand-config" }, body: "Closes #30" }],
];

test("the config on the onboarding pull request's branch: errors, warnings, missing files", async () => {
  const branch = "issue-30-deckhand-config";
  const bad = fakeRequest({
    "GET /repos/org/app/pulls?state=open&per_page=100": PULLS,
    [`GET /repos/org/app/contents/.deckhand.yaml?ref=${branch}`]: file(
      "effort: huge\ndockerfile: .deckhand/Dockerfile\ncolour: blue\n",
    ),
  });
  const report = await branchConfigReport(bad.request, config, "org/app", 30);
  assert.match(report, /^`\.deckhand\.yaml` on `issue-30-deckhand-config` has errors/);
  assert.match(report, /- ❌ effort: /);
  assert.match(report, /- ❌ dockerfile: `\.deckhand\/Dockerfile` is not on the branch/);
  assert.match(report, /- ⚠️ colour: unknown, ignored/);

  const good = fakeRequest({
    "GET /repos/org/app/pulls?state=open&per_page=100": PULLS,
    [`GET /repos/org/app/contents/.deckhand.yaml?ref=${branch}`]: file(
      "setup: npm ci\ndockerfile: .deckhand/Dockerfile\n",
    ),
    [`GET /repos/org/app/contents/.deckhand/Dockerfile?ref=${branch}`]: file("FROM x\n"),
  });
  assert.match(await branchConfigReport(good.request, config, "org/app", 30), /^✅ .* no errors/);

  const none = fakeRequest({ "GET /repos/org/app/pulls?state=open&per_page=100": PULLS });
  assert.match(await branchConfigReport(none.request, config, "org/app", 30), /not found/);
  // No pull request (the run stopped before opening one): nothing to say.
  const empty = fakeRequest({ "GET /repos/org/app/pulls?state=open&per_page=100": [200, []] });
  assert.equal(await branchConfigReport(empty.request, config, "org/app", 30), null);
});
