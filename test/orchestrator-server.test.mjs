// The orchestrator end to end, without Docker or GitHub: edge in front of it (edge/), which takes
// the webhooks, the runner service beside it (runner/), a fake `docker` on the runner's PATH
// plays the sandbox (asks the broker for a token, prints a result), a local server plays GitHub.
// The tests still say "listener" for the pair, edge and the orchestrator, that took its place.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { createCallers } from "../broker/callers.mjs";
import { createAppHolder } from "../github/app.mjs";
import { createGithubService } from "../github/service.mjs";
import { signServiceToken } from "../lib/service-token.mjs";
import { createGitHub } from "../listener/github.mjs";
import { grantFor, grantOf, grantsBy, loadGrants } from "../listener/grants.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { policyClient } from "../listener/policy-client.mjs";
import { createBroker as createBrokerService } from "../broker/server.mjs";
import {
  AGENT_TOKEN_HEADERS,
  agentTokenOf,
  createBrokerCaller,
  RUN_AUTH_HEADER,
  RUN_TOKEN_HEADER,
  SANDBOX_HEADER,
} from "../lib/broker-client.mjs";
import { SANDBOX_URLS } from "../lib/services.mjs";
import { createRegistry } from "../lib/metrics.mjs";
import { createProxy, egressPolicy, relayTarget } from "../proxy/proxy.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { keyFolder } from "../lib/tokens.mjs";
import { AGENT_SECRETS } from "../listener/agents/index.mjs";
import { createBrokerService as createBrokerClient } from "../listener/broker-service.mjs";
import {
  ConfigError,
  loadConfig,
  readConfigFile,
  withCredentialFiles,
} from "../listener/config.mjs";
import { loginSeal } from "../models/logins.mjs";
import { createModels, credentialNames, runnerOf } from "../models/server.mjs";
import { APP_EVENTS, APP_PERMISSIONS } from "../listener/github-app.mjs";
import { gitBlob } from "../listener/images.mjs";
import { openStore, values } from "../lib/store.mjs";
import { fileName } from "../lib/store-file.mjs";
import { encode, replyParser } from "../lib/resp.mjs";
import { pathToFileURL } from "node:url";
import {
  evalResult,
  fakeOpa,
  forwarder,
  freshRedisPrefix,
  grantsPolicy,
  servePolicies,
  isRoot,
  needsBash,
  needsModes,
  needsSignals,
  startService,
  tempDir,
  testKey,
  until as waitUntil,
} from "./helpers.mjs";

// The policy service's opa allowing a brainstorm's GitHub writes on its own issue only, as
// Deckhand's mode-brainstorm.rego does for an edit (github-writes.test.mjs evaluates the real
// file): what these tests check is the wiring, the gateway asking the policies.
const brainstormOpa = () =>
  fakeOpa({
    answer: (_files, input) =>
      evalResult(
        [],
        !(input.mode === "brainstorm" && input.target && input.target.kind !== "own_issue"),
      ),
  });

const SECRET = "webhook-secret";
// The App's key, one for every listener: making one takes a while.
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});
// A read-write mount needs every directory from / to its parent out of the sandbox's user's
// reach (uid 1000, maybe the tests' own), which a temp dir isn't: /usr is root's everywhere.
// The fake docker mounts nothing.
const RW_MOUNT = "/usr";

// A fake `docker` on the listener's PATH, playing Docker on files in `dir`
// (fixtures/fake-docker.sh says how).
function fakeDocker(dir) {
  symlinkSync(join(import.meta.dirname, "fixtures", "fake-docker.sh"), join(dir, "docker"));
}

// Stops the fake sandboxes a test leaves running.
function stopSandboxes(dir) {
  try {
    for (const name of readdirSync(join(dir, "containers"))) {
      try {
        process.kill(-Number(readFileSync(join(dir, "containers", name, "pid"), "utf8")));
      } catch {
        // Already over.
      }
    }
  } catch {
    // None started.
  }
}

// `files`: the repo's files on its default branch, served by the contents API and as a
// tarball; none: no .deckhand.yaml (404).
async function fakeGitHub(files = {}) {
  const tarball = files["Dockerfile"] || files["docker/Dockerfile"] ? tarOf(files) : null;
  const requests = [];
  const waiters = [];
  // Requests left unanswered until the test lets them go (hold()).
  const holds = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const entry = {
        method: req.method,
        path: req.url,
        auth: req.headers.authorization,
        headers: req.headers,
        body,
      };
      requests.push(entry);
      for (const w of [...waiters]) if (w.match(entry)) w.resolve(entry);
      for (const h of holds) if (h.match(entry)) await h.released;
      res.setHeader("content-type", "application/json");
      // The repo's policies (.deckhand/policy/ on its default branch), keyed "policy:<name>":
      // listed, then read by blob. None: a 404, as GitHub answers for a missing folder.
      const policies = Object.keys(files).filter((k) => k.startsWith("policy:"));
      if (req.url === "/repos/org/repo/contents/.deckhand/policy?ref=trunk" && policies.length) {
        const list = policies.map((k) => ({
          type: "file",
          name: k.slice(7),
          sha: `policy-${k.slice(7)}`,
        }));
        return res.end(JSON.stringify(list));
      }
      const policyBlob = /^\/repos\/org\/repo\/git\/blobs\/policy-(.+)$/.exec(req.url);
      if (policyBlob && files[`policy:${policyBlob[1]}`] !== undefined) {
        const content = Buffer.from(files[`policy:${policyBlob[1]}`]).toString("base64");
        return res.end(JSON.stringify({ content, encoding: "base64" }));
      }
      // Other branches' files are keyed "<branch>:<path>".
      // Without a ref, the default branch's (the runner's blob lookups).
      const file = /^\/repos\/org\/repo\/contents\/([^?]+)(?:\?ref=(.+))?$/.exec(req.url);
      if (file) {
        const path = decodeURIComponent(file[1]);
        const ref = file[2] === undefined ? "trunk" : decodeURIComponent(file[2]);
        const text = ref === "trunk" ? files[path] : files[`${ref}:${path}`];
        if (text === undefined) return res.writeHead(404).end("{}");
        const content = Buffer.from(text).toString("base64");
        // Its git blob id, as GitHub's: the runner builds only when the tarball's Dockerfile is
        // that blob (images.mjs buildImage()).
        const sha = gitBlob(Buffer.from(text));
        return res.end(JSON.stringify({ type: "file", sha, content }));
      }
      // The default branch's, by name or without a ref (the runner's builds).
      if (
        ["/repos/org/repo/tarball/trunk", "/repos/org/repo/tarball"].includes(req.url) &&
        tarball
      ) {
        res.setHeader("content-type", "application/gzip");
        return res.end(tarball);
      }
      // Dashboard sign-in: the browser comes back as alice.
      if (req.url === "/login/oauth/access_token") {
        return res.end(JSON.stringify({ access_token: "user-token" }));
      }
      if (req.url === "/user") return res.end(JSON.stringify({ login: "alice" }));
      // What a comment waits for ("/after #77"): the test sets its state, as JSON.
      const waitedFor = /^\/repos\/org\/repo\/issues\/(\d+)$/.exec(req.url);
      // A number: the status GitHub answers instead (a 5xx, a rate limit).
      if (req.method === "GET" && waitedFor && files[`issue:${waitedFor[1]}`]) {
        const issue = files[`issue:${waitedFor[1]}`];
        if (typeof issue === "number") return res.writeHead(issue).end("{}");
        return res.end(issue);
      }
      // GraphQL's node look-ups (github-graphql.mjs), as JSON, when the test sets them.
      if (req.method === "POST" && req.url === "/graphql" && body.includes("nodes(ids:")) {
        if (files.nodes) return res.end(files.nodes);
      }
      // The listener's own GraphQL (projects.mjs): `graphql:<text>`'s answer, for the first such
      // text its query holds, when the test sets one.
      if (req.method === "POST" && req.url === "/graphql") {
        const key = Object.keys(files).find(
          (k) => k.startsWith("graphql:") && body.includes(k.slice("graphql:".length)),
        );
        if (key) return res.end(files[key]);
      }
      // An issue's parent, as JSON, when the test sets it; none otherwise.
      const parent = /^\/repos\/org\/repo\/issues\/(\d+)\/parent$/.exec(req.url);
      if (req.method === "GET" && parent) {
        const found = files[`parent:${parent[1]}`];
        return found ? res.end(found) : res.writeHead(404).end("{}");
      }
      // An issue's sub-issues and blockers, as JSON lists, when the test sets them; none
      // otherwise.
      const tree =
        /^\/repos\/org\/repo\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by)\?/.exec(req.url);
      if (req.method === "GET" && tree) {
        return res.end(
          files[`${tree[2] === "sub_issues" ? "subs" : "blocked"}:${tree[1]}`] ?? "[]",
        );
      }
      // A pull request, as JSON, when the test sets it.
      const pull = /^\/repos\/org\/repo\/pulls\/(\d+)$/.exec(req.url);
      if (req.method === "GET" && pull && files[`pull:${pull[1]}`]) {
        return res.end(files[`pull:${pull[1]}`]);
      }
      // An issue's branches, as JSON, when the test sets them (linked-branch.mjs).
      const branches = /^\/repos\/org\/repo\/git\/matching-refs\/heads\/issue-(\d+)-$/.exec(
        req.url,
      );
      if (req.method === "GET" && branches && files[`branches:${branches[1]}`]) {
        return res.end(files[`branches:${branches[1]}`]);
      }
      // The branch the listener creates and links: named as asked.
      if (req.method === "POST" && req.url === "/graphql" && body.includes("createLinkedBranch")) {
        const { name } = JSON.parse(body).variables.input;
        const linkedBranch = { ref: { name } };
        return res.end(JSON.stringify({ data: { createLinkedBranch: { linkedBranch } } }));
      }
      // A branch's latest commit, when the test sets it (the conflict watcher's base).
      const ref = /^\/repos\/org\/repo\/git\/ref\/heads\/(.+)$/.exec(req.url);
      if (req.method === "GET" && ref && files[`ref:${ref[1]}`]) {
        return res.end(JSON.stringify({ object: { sha: files[`ref:${ref[1]}`] } }));
      }
      // An issue's comments, as JSON, when the test sets them (a research run's thread).
      const thread = /^\/repos\/org\/repo\/issues\/(\d+)\/comments\?/.exec(req.url);
      if (req.method === "GET" && thread && files[`comments:${thread[1]}`]) {
        return res.end(req.url.endsWith("page=1") ? files[`comments:${thread[1]}`] : "[]");
      }
      // A pull request's changed files and its head's Actions runs (an auto-merge's gates):
      // none unless the test sets them.
      const changed = /^\/repos\/org\/repo\/pulls\/(\d+)\/files\?/.exec(req.url);
      if (req.method === "GET" && changed) {
        return res.end(req.url.endsWith("page=1") ? (files[`files:${changed[1]}`] ?? "[]") : "[]");
      }
      if (req.method === "GET" && req.url.startsWith("/repos/org/repo/actions/runs?")) {
        return res.end(files.runs ?? JSON.stringify({ workflow_runs: [] }));
      }
      // A commit's check runs and statuses (the dashboard's CI status): none unless the test
      // sets them.
      if (
        req.method === "GET" &&
        /^\/repos\/org\/repo\/commits\/[^/]+\/check-runs\?/.test(req.url)
      ) {
        return res.end(files.checks ?? JSON.stringify({ check_runs: [] }));
      }
      if (req.method === "GET" && /^\/repos\/org\/repo\/commits\/[^/]+\/status\?/.test(req.url)) {
        return res.end(files.statuses ?? JSON.stringify({ statuses: [] }));
      }
      // A pull request's reviews, as a JSON list, when the test sets them.
      const reviewed = /^\/repos\/org\/repo\/pulls\/(\d+)\/reviews\?/.exec(req.url);
      if (req.method === "GET" && reviewed && files[`reviews:${reviewed[1]}`]) {
        return res.end(req.url.endsWith("page=1") ? files[`reviews:${reviewed[1]}`] : "[]");
      }
      // A pull request's reviews and an issue's comments otherwise: none.
      if (
        req.method === "GET" &&
        (thread || /^\/repos\/org\/repo\/pulls\/\d+\/reviews\?/.test(req.url))
      ) {
        return res.end("[]");
      }
      // A task from before titles were kept: the dashboard asks for its title once.
      if (req.method === "GET" && req.url === "/repos/org/repo/issues/3") {
        return res.end(JSON.stringify({ title: "An older pull request" }));
      }
      // A task from before pull requests were kept: looked up once.
      if (req.url === "/repos/org/repo/pulls?state=all&sort=updated&direction=desc&per_page=100") {
        const url = "https://github.com/org/repo/pull/3";
        return res.end(JSON.stringify([{ number: 3, html_url: url, state: "open", draft: false }]));
      }
      // Onboarding: the repo, its new issue, and the pull request the work run opened.
      if (req.method === "GET" && req.url === "/repos/org/repo") {
        return res.end(
          JSON.stringify({ node_id: "R_1", default_branch: "trunk", has_issues: true }),
        );
      }
      if (req.method === "POST" && req.url === "/repos/org/repo/issues") {
        return res.end(JSON.stringify({ number: 30 }));
      }
      if (req.url === "/repos/org/repo/pulls?state=open&per_page=100") {
        return res.end(
          JSON.stringify([
            {
              number: 31,
              head: { ref: "issue-30-deckhand-config", repo: { full_name: "org/repo" } },
              body: "",
            },
          ]),
        );
      }
      // Pull requests a comment can come from: a maintainer's branch, a fork's.
      if (req.method === "GET" && req.url === "/repos/org/repo/pulls/40") {
        const head = { ref: "feature/maintainer", repo: { full_name: "org/repo" } };
        return res.end(JSON.stringify({ number: 40, head }));
      }
      if (req.method === "GET" && req.url === "/repos/org/repo/pulls/41") {
        const head = { ref: "feature/x", repo: { full_name: "someone/repo" } };
        return res.end(JSON.stringify({ number: 41, head }));
      }
      // Pull requests saying they close #3: from a branch of the repo, from a fork.
      if (req.method === "GET" && req.url === "/repos/org/repo/pulls/42") {
        const head = { ref: "issue-3-fix", repo: { full_name: "org/repo" } };
        return res.end(JSON.stringify({ number: 42, body: "Closes #3", head }));
      }
      if (req.method === "GET" && req.url === "/repos/org/repo/pulls/43") {
        const head = { ref: "issue-3-fix", repo: { full_name: "mallory/repo" } };
        return res.end(JSON.stringify({ number: 43, body: "Closes #3", head }));
      }
      // The repo's open pull requests, every page (auto-pickup.mjs): none unless the test sets
      // them.
      if (req.url.startsWith("/repos/org/repo/pulls?state=open&per_page=100&page=")) {
        return res.end(req.url.endsWith("page=1") ? (files.openPulls ?? "[]") : "[]");
      }
      // An issue's events, as a JSON list, when the test sets them.
      const events = /^\/repos\/org\/repo\/issues\/(\d+)\/events\?/.exec(req.url);
      if (req.method === "GET" && events && files[`events:${events[1]}`]) {
        return res.end(req.url.endsWith("page=1") ? files[`events:${events[1]}`] : "[]");
      }
      // A branch's open pull requests (the git gateway, for a repo granted `workflows`).
      if (req.url.startsWith("/repos/org/repo/pulls?state=open&per_page=100&head=")) {
        return res.end("[]");
      }
      // The App's deliveries (redeliveries.mjs), as JSON, when the test sets them; none
      // otherwise.
      if (req.url.startsWith("/app/hook/deliveries?")) return res.end(files.deliveries ?? "[]");
      // A listener that restarted looks the installation up instead of reading it from a
      // delivery.
      if (req.url === "/repos/org/repo/installation") return res.end(JSON.stringify({ id: 7 }));
      if (req.url === "/app/installations/7/access_tokens") {
        const scoped = body.includes("repositories");
        const expires_at = new Date(Date.now() + 3600000).toISOString();
        return res.end(
          JSON.stringify({
            // The git gateway's for a repo granted `workflows`: told apart.
            token: !scoped
              ? "app-token"
              : body.includes("workflows")
                ? "workflows-token"
                : (files.repoToken ?? "repo-token"),
            expires_at,
          }),
        );
      }
      // The listener lists the App's repos when it starts: none here, so a real error in its
      // startup log stands out.
      if (req.url.startsWith("/app/installations?")) {
        return res.end(files.installations ?? JSON.stringify([{ id: 7 }]));
      }
      // The App's settings (github-app.mjs checkAppSettings()), when the test sets them.
      if (req.url === "/app" && files.app) return res.end(files.app);
      if (req.url.startsWith("/installation/repositories?")) {
        return res.end(files.installed ?? JSON.stringify({ repositories: [] }));
      }
      // The repo's open issues with the needs-input label (inputs.mjs sync()), when the test
      // sets them.
      if (req.url.startsWith("/repos/org/repo/issues?labels=") && files.labelled) {
        return res.end(files.labelled);
      }
      // The repo's open issues (the backlog), as JSON, when the test sets them.
      if (req.url.startsWith("/repos/org/repo/issues?state=open&") && files.backlog) {
        return res.end(files.backlog);
      }
      // A push the git gateway forwards: each ref updated, as receive-pack reports it.
      if (req.url.endsWith("/git-receive-pack")) {
        const pkt = (line) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
        const refs = [...body.matchAll(/[0-9a-f]{40} [0-9a-f]{40} ([^\0\n]+)/g)].map((m) => m[1]);
        return res.end(pkt("unpack ok\n") + refs.map((r) => pkt(`ok ${r}\n`)).join("") + "0000");
      }
      res.end(JSON.stringify({ id: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const waitFor = (match) =>
    new Promise((resolve) => {
      const found = requests.find(match);
      if (found) return resolve(found);
      waiters.push({ match, resolve });
    });
  // Holds back the answers to requests that `match`, until the returned function is called.
  const hold = (match) => {
    let release;
    holds.push({ match, released: new Promise((resolve) => (release = resolve)) });
    return () => release();
  };
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    waitFor,
    hold,
    server,
  };
}

// The runs' summaries, in the orchestrator's store (runlog.mjs: its file backend keeps them a
// file each, keys/): the first one's, or null.
function summary(dir) {
  try {
    const folder = join(dir, "store", "keys");
    const file = readdirSync(folder).find((f) => f.startsWith("summaries%2F"));
    return file ? JSON.parse(readFileSync(join(folder, file), "utf8")).value : null;
  } catch {
    return null;
  }
}

// The dashboard's API at edge's `port`, as alice (in ALLOWED_USERS), signed in: path → its JSON.
async function dashboardApi(port) {
  const base = `http://127.0.0.1:${port}`;
  const get = (path, cookie) =>
    fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const login = await get("/auth/login");
  const to = new URL(login.headers.get("location"));
  const state = login.headers.getSetCookie()[0].split(";")[0];
  const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
  const session = back.headers
    .getSetCookie()
    .find((c) => c.startsWith("deckhand_session="))
    .split(";")[0];
  return async (path) => (await get(path, session)).json();
}

// The runs' logs, as the runner keeps them (its store's blobs, runner/logs.mjs): their texts, by
// run id, their segments (`logs/<run>/<n>`) in order. Asked again until `ready(texts)` holds,
// for one still on its way to the runner.
function runLogs(dir) {
  const blobs = join(dir, "runner-store", "blobs");
  if (!existsSync(blobs)) return new Map();
  const segments = readdirSync(blobs)
    .map((file) => [decodeURIComponent(file).match(/^logs\/([^/]+)(?:\/(\d+))?$/), file])
    .filter(([key]) => key)
    .map(([[, id, n], file]) => ({ id, n: n === undefined ? -1 : Number(n), file }))
    .sort((a, b) => a.n - b.n);
  const texts = new Map();
  const shapes = new Map();
  for (const { id, n, file } of segments) {
    // A log is one blob (before segments, n -1) or segments, never both.
    const shape = n < 0 ? "blob" : "segments";
    if (shapes.get(id) && shapes.get(id) !== shape) throw new Error(`${id}: a blob and segments`);
    shapes.set(id, shape);
    texts.set(id, (texts.get(id) ?? "") + readFileSync(join(blobs, file), "utf8"));
  }
  return texts;
}

// The live runs' states the orchestrator saved (restart.mjs saveLive()), in its store (#617):
// `runs/<id>` in its file backend's state.json.
function liveStates(dir) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(join(dir, "store", "state.json"), "utf8"));
  } catch {
    return [];
  }
  return Object.entries(saved.keys ?? {})
    .filter(([key]) => key.startsWith("runs/"))
    .map(([, entry]) => entry.value);
}

// The one run's log of a test with a single run, once it is all at the runner: its live state
// goes after its last write is sent (runs.mjs teardown()).
async function onlyLog(dir) {
  const live = () => liveStates(dir).length > 0;
  for (let tries = 0; live() || !runLogs(dir).size; tries++) {
    if (tries > 500) throw new Error("timed out waiting for the run's log at the runner");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [...runLogs(dir).values()][0];
}

// Data folder → a wait for the orchestrator acting on it to have written to its store every map
// item it changed so far (its /ready's `waiting`), registered by listen().
const writesLanded = new Map();

// Map `name` as the orchestrator keeps it in its store (lib/store-map.mjs): { key: value }, read
// as another process on the store's folder would, once what the orchestrator changed so far
// landed there (its writes are in the background). Its items a file each (`apart`, #691).
async function storedMap(dir, name) {
  await writesLanded.get(dir)?.();
  const store = openStore(pathToFileURL(join(dir, "store")).href, { apart: [`${name}/`] });
  const found = {};
  for await (const [key, value] of values(store, `${name}/`)) {
    found[key.slice(name.length + 1)] = value;
  }
  await store.close();
  return found;
}

// What the tests' egress proxies serve as their CA's certificate.
const TEST_CA = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n";

// GitHub's tarball: one top folder holding the repo's files.
function tarOf(files) {
  const dir = tempDir(null, "deckhand-repo-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, "org-repo-abc", dirname(path)), { recursive: true });
    writeFileSync(join(dir, "org-repo-abc", path), text);
  }
  return execFileSync("tar", ["-czf", "-", "-C", dir, "org-repo-abc"]);
}

// `script`: the orchestrator's, edge's or the runner's; `also()`: more output its until() and
// output() read (edge's and the runner's, for the orchestrator's: what a run does is logged on
// every side). Killed by the test itself, which restarts some.
const start = (env, { script = "orchestrator/server.mjs", also } = {}) =>
  startService(null, script, env, { also });

// The models service of a test's listener (../models/server.mjs): its settings, the agents'
// credentials among them, as the listener's; its service tokens from the broker service, its
// login refreshes at the runner. Settings it can't start with: an answer of which credentials it
// holds alone, so that the listener says what is wrong with its own. → { handle, stop }.
function startModels(settings, { dir, runnerUrl, registry, log }) {
  const env = withCredentialFiles(settings);
  const names = { names: credentialNames(env) };
  const alone = {
    handle: (req, res) => res.writeHead(200).end(JSON.stringify(names)),
    stop: () => {},
  };
  let config;
  try {
    config = loadConfig(env, readConfigFile(env), { service: "models" });
  } catch (error) {
    if (error instanceof ConfigError) return alone;
    throw error;
  }
  const caller = createBrokerCaller({
    url: settings.BROKER_SERVICE_URL,
    service: "models",
    audiences: ["broker", "runner"],
  });
  const broker = createBrokerClient({ caller });
  broker.start().catch(() => {});
  const runner = runnerOf({ urls: runnerUrl, caller });
  const models = createModels({
    env,
    config,
    store: openStore("memory:"),
    seal: loginSeal(Buffer.alloc(32, 1)),
    keys: keyFolder(join(dir, "keys")),
    broker,
    caller,
    refresh: runner.refreshLogin,
    bound: networkCallers("proxy+orchestrator=127.0.0.0/8"),
    registry,
    log,
  });
  models.ready();
  const handle = models.server.listeners("request")[0];
  return { handle: (req, res) => handle(req, res), stop: () => broker.stop() };
}

// The github service (../github/), in this process: the App's key in its own folder, the
// broker's key for the tokens, the policy service for the runs' writes and pushes, the test's
// grants. `extra`: the listener's settings it reads too (GITHUB_URL…).
async function startGithubService(dir, github, credentials, { key, policyService, extra }) {
  const own = join(dir, "github-service");
  mkdirSync(own, { recursive: true });
  const { webhook_secret: _, client_secret: __, ...kept } = credentials;
  writeFileSync(join(own, "app.json"), JSON.stringify(kept));
  const config = loadConfig(
    {
      GITHUB_API: github.url,
      DATA_DIR: own,
      GRANTS_DIR: join(dir, "grants"),
      ...(extra?.GITHUB_URL && { GITHUB_URL: extra.GITHUB_URL }),
    },
    undefined,
    { service: "github" },
  );
  const app = createAppHolder({ dir: own, api: config.githubApi });
  const keys = () => new Map([[key.kid, key.publicKey]]);
  const policies = createPolicies({
    config,
    github: createGitHub(() => app.get()).github,
    service: policyClient({
      url: policyService,
      header: async () => `Bearer ${signServiceToken({ sub: "github", aud: "policy" }, key)}`,
    }),
  });
  // Its events the orchestrator took (handled, then acknowledged), by type: what a test waits
  // for rather than a while.
  const store = openStore("memory:");
  const types = new Map();
  const taken = new Map();
  const { append, ack } = store;
  store.append = async (stream, event, options) => {
    const id = await append(stream, event, options);
    types.set(id, event.type);
    return id;
  };
  store.ack = async (stream, consumer, ids, options) => {
    for (const id of ids) taken.set(types.get(id), (taken.get(types.get(id)) ?? 0) + 1);
    return ack(stream, consumer, ids, options);
  };
  const made = createGithubService({
    config,
    store,
    app,
    broker: { keys, serviceKeys: keys, unknownKey: async () => {} },
    bound: null,
    policies,
    // As github/server.mjs reads them.
    grants: {
      projects: (repo) => grantFor(loadGrants(config), config, repo).allowProjects,
      workflows: async (repo) =>
        (await grantOf(config, repo, { granted: grantsBy(policies) })).allowWorkflows === true,
    },
    mirrorDir: join(own, "mirrors"),
  });
  await new Promise((resolve) => made.server.listen(0, "127.0.0.1", resolve));
  made.server.unref();
  const url = `http://127.0.0.1:${made.server.address().port}`;
  return { ...made, url, taken: (type) => taken.get(type) ?? 0 };
}

// The egress proxy as the sandboxes reach it, played by the test: the fake sandbox (and the
// tests) call it in origin-form, as plain HTTP (`/run/…`, `/git/…`, `/anthropic/…`, `/relay/
// <host>/…`, `/egress?…`). The services' names go to a real proxy (../proxy/proxy.mjs), which
// asks the orchestrator's egress policy and forwards them; a relayed host's calls, which a sandbox
// makes over HTTPS the proxy decrypts, go to the service the policy names, as the proxy sends
// them (with its service token, the sandbox's credential apart, the network vouched for); the
// policy's questions are the proxy's own. That relay is a copy of the proxy's, without its TLS:
// egress-tls.test.mjs is what tests the proxy's own (intercept()). `policyPort()`: the
// orchestrator's, once it listens.
async function sandboxProxy({ policyPort, token, urls }) {
  const policyUrl = () => `http://127.0.0.1:${policyPort()}/egress`;
  const policy = (ip, host, options) => egressPolicy(policyUrl())(ip, host, options);
  const service = (name) => ({ url: urls[name], header: async () => token(name) });
  const services = {
    broker: service("broker"),
    github: service("github"),
    models: service("models"),
  };
  const proxy = createProxy({
    policy,
    brokerService: services.broker,
    githubService: services.github,
    modelsService: services.models,
  });
  // A relayed host's request, to its service: `/relay/<host><path>` there.
  async function relay(req, res, host, path) {
    const answer = await policy("127.0.0.1", host);
    const name =
      answer.relay && (answer.service === "github" ? "github" : answer.models && "models");
    const url = name && relayTarget(`${urls[name]}/relay`, host, path);
    if (!url) return res.writeHead(name ? 400 : 403).end("Deckhand's egress proxy refused it\n");
    const headers = { ...req.headers, host: url.host };
    for (const drop of ["connection", "keep-alive", RUN_AUTH_HEADER, RUN_TOKEN_HEADER]) {
      delete headers[drop];
    }
    if (name === "models") {
      headers[RUN_TOKEN_HEADER] = agentTokenOf(req.headers);
      for (const drop of AGENT_TOKEN_HEADERS) delete headers[drop];
    } else headers[RUN_AUTH_HEADER] = req.headers.authorization ?? "";
    Object.assign(headers, {
      authorization: await services[name].header(),
      [SANDBOX_HEADER]: answer.sandbox ?? "",
    });
    const out = httpRequest(url, { method: req.method, headers, agent: false }, (answered) => {
      res.writeHead(answered.statusCode, answered.headers);
      answered.pipe(res);
    });
    out.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(out);
  }
  const server = createServer((req, res) => {
    const done = (error) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    };
    if (req.url.startsWith("/egress?")) {
      return fetch(`${policyUrl()}${req.url.slice("/egress".length)}`)
        .then(async (answer) => res.writeHead(answer.status).end(await answer.text()))
        .catch(done);
    }
    const relayed = /^\/relay\/([^/]+)(\/.*)$/.exec(req.url);
    if (relayed) return relay(req, res, relayed[1], relayed[2]).catch(done);
    const name = /^\/run\//.test(req.url)
      ? "broker"
      : /^\/git\//.test(req.url)
        ? "github"
        : "models";
    req.url = `${SANDBOX_URLS[name]}${req.url}`;
    proxy.emit("request", req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return { server, port: server.address().port };
}

// Not root (#536): a data volume it can't write, one a root orchestrator of the release before
// wrote last, stops it at start, naming what and the chown. Only what comes before is started:
// the broker, for its service tokens, and the models service, which it asks before its settings.
test(
  "the orchestrator doesn't start on a data volume it can't write, and says the chown",
  { skip: (isRoot && "root writes anywhere") || needsModes },
  async (t) => {
    const dir = tempDir(t);
    const broker = createBrokerService({
      store: openStore("memory:"),
      key: testKey(),
      callers: createCallers({ networks: "orchestrator=127.0.0.0/8" }),
      keysDir: join(dir, "keys"),
    }).server;
    const models = createServer((req, res) =>
      res.end(
        JSON.stringify(
          req.url.startsWith("/credentials") ? { names: [] } : { salt: "s", values: [] },
        ),
      ),
    );
    for (const server of [broker, models]) {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => (server.closeAllConnections(), server.close()));
    }
    // Its store's state, root's again after the chown (the old orchestrator still saving it).
    const data = join(dir, "data");
    const state = join(data, "store", "state.json");
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, '{"keys":{"queue":{"value":["kept"]}}}');
    chmodSync(state, 0o400);
    const { child, output, exited } = start({
      DATA_DIR: data,
      ALLOWED_USERS: "alice",
      GRANTS_DIR: join(dir, "grants"),
      BROKER_SERVICE_URL: `http://127.0.0.1:${broker.address().port}`,
      MODELS_SERVICE_URL: `http://127.0.0.1:${models.address().port}`,
    });
    t.after(() => child.kill("SIGKILL"));
    const { code } = await exited;
    assert.equal(code, 1, output());
    assert.match(output(), /The orchestrator can't write .*state\.json \(EACCES\)/);
    assert.match(output(), /docker compose stop orchestrator.*--cap-add CHOWN/);
    // Nothing written: no folder of its own made, the state as it was.
    assert.ok(!existsSync(join(data, "logs")));
    assert.match(readFileSync(state, "utf8"), /kept/);
  },
);

// The orchestrator alone, on a real Redis (TEST_REDIS_URL, CI's) reached through a relay, stopped
// by SIGTERM before it is up, while what `refuses` fails is tried again (#692). `refuses(args)`:
// what a command is a try of, which the relay refuses (an unknown command in its place, whose
// error reply comes back where its own would have), or null. `env({ fail, dir, store })`: more
// settings, the services it calls among them, `fail(what)` marking a try of theirs refused. Once
// every one of `expect` failed, the SIGTERM. → its exit code, output, the tries made after the
// SIGTERM (`late`: none, the stop giving them up), and whether its lease was given back.
//
// Those tries' 5 s pauses are the orchestrator's own (lib/store-map.mjs, github/client.mjs,
// persist()), out of the test's reach: the SIGTERM goes 2 s after the last first failure, and
// the lease's release is held until 5.8 s after it, past the next try of each, had it gone on,
// and before the release's own 5 s timeout (lib/resp.mjs) 1.2 s later.
async function stoppedEarly(t, { refuses, expect, env = () => ({}) }) {
  const dir = tempDir(t);
  const broker = createBrokerService({
    store: openStore("memory:"),
    key: testKey(),
    callers: createCallers({ networks: "orchestrator=127.0.0.0/8" }),
    keysDir: join(dir, "keys"),
  }).server;
  const models = createServer((req, res) =>
    res.end(
      JSON.stringify(
        req.url.startsWith("/credentials") ? { names: [] } : { salt: "s", values: [] },
      ),
    ),
  );
  const failed = new Map();
  let signalled = false;
  const late = [];
  const fail = (what) => {
    if (!failed.has(what)) failed.set(what, Date.now());
    if (signalled) late.push(what);
  };
  const lastFailure = () => Math.max(...failed.values());
  const upstream = new URL(process.env.TEST_REDIS_URL);
  const relay = createNetServer((client) => {
    const redis = connect(Number(upstream.port || 6379), upstream.hostname);
    client.on("error", () => redis.destroy());
    redis.on("error", () => client.destroy());
    client.on("close", () => redis.destroy());
    redis.pipe(client);
    // In order: a held command holds back the ones after it, as a slow Redis would.
    let sent = Promise.resolve();
    client.on(
      "data",
      replyParser((args) => {
        const text = args.map(String);
        const what = refuses(text);
        if (what) fail(what);
        const held = signalled && text.some((arg) => arg.endsWith(":l:orchestrator"));
        const wait = held ? lastFailure() + 5800 - Date.now() : 0;
        sent = sent
          .then(() => wait > 0 && new Promise((resolve) => setTimeout(resolve, wait)))
          .then(() => redis.write(encode(what ? ["DECKHAND-STORE-AWAY"] : args)));
      }),
    );
  });
  for (const server of [broker, models, relay]) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => (server.closeAllConnections?.(), server.close()));
  }
  const direct = new URL(process.env.TEST_REDIS_URL);
  direct.searchParams.set("prefix", freshRedisPrefix(t, process.env.TEST_REDIS_URL));
  const relayed = new URL(direct);
  relayed.host = `127.0.0.1:${relay.address().port}`;
  const store = openStore(direct.href);
  t.after(() => store.close());
  const data = join(dir, "data");
  mkdirSync(data);
  const { child, output } = start({
    DATA_DIR: data,
    STORE_URL: relayed.href,
    SERVICES_PORT: "0",
    ALLOWED_USERS: "alice",
    GRANTS_DIR: join(dir, "grants"),
    BROKER_SERVICE_URL: `http://127.0.0.1:${broker.address().port}`,
    MODELS_SERVICE_URL: `http://127.0.0.1:${models.address().port}`,
    ...(await env({ fail, dir: data, store })),
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.on("close", resolve));
  await waitUntil(() => expect.every((what) => failed.has(what)) || child.exitCode !== null, {
    ms: 30_000,
    what: expect.join(", "),
  });
  assert.equal(child.exitCode, null, output());
  await new Promise((resolve) => setTimeout(resolve, lastFailure() + 2000 - Date.now()));
  signalled = true;
  child.kill("SIGTERM");
  const code = await exited;
  // Given back: the next copy takes it at once, rather than once it expires.
  const lease = await store.acquire("orchestrator", "test", { ttlMs: 1000 });
  return { code, output: output(), late, leaseFree: !!lease };
}

const stopsEarly = {
  skip: (!process.env.TEST_REDIS_URL && "no Redis: set TEST_REDIS_URL") || needsSignals,
};

// The maps' load refused (its first command, the stamp storeMap() writes before it reads a
// map's items): read again every 5 s until the stop, which stops at the maps it never got
// rather than read them.
test(
  "a stop during the maps' first load gives up the read, exits cleanly and gives the lease back",
  stopsEarly,
  async (t) => {
    const stopped = await stoppedEarly(t, {
      refuses: (args) =>
        args.some((arg) => arg.includes(":k:store-maps/")) ? "the maps' read" : null,
      expect: ["the maps' read"],
    });
    assert.equal(stopped.code, 0, stopped.output);
    assert.doesNotMatch(stopped.output, /TypeError/);
    assert.deepEqual(stopped.late, []);
    assert.ok(stopped.leaseFree, stopped.output);
  },
);

// Past the maps, before it is up (edge, which it asks about the App, doesn't answer): a title's
// write (seeded from a run's summary; the maps' read, a SCAN of `titles/*`, goes through) and
// the App's key's handover to the github service tried again (a 500: a 503, the service's
// client asks again on its own, lib/service-client.mjs). The stop gives both up: a map's write
// carries no epoch, and would land over what the next copy wrote.
test(
  "a stop before the orchestrator is up gives up the maps' writes and the github service's calls",
  stopsEarly,
  async (t) => {
    const stopped = await stoppedEarly(t, {
      refuses: (args) => (args.some((arg) => /:k:titles\/[^*]/.test(arg)) ? "a title" : null),
      expect: ["a title", "the App's key"],
      env: async ({ fail, dir, store }) => {
        await store.set("summaries/org-repo-5-1", {
          id: "org-repo-5-1",
          key: "org/repo#5",
          repo: "org/repo",
          title: "Five",
          startedAt: 1,
        });
        writeFileSync(
          join(dir, "app.json"),
          JSON.stringify({ id: 1, slug: "deckhand", owner: "org", pem: "not a key" }),
        );
        const github = createServer((req, res) => {
          if (req.method === "PUT" && req.url === "/app") fail("the App's key");
          res.writeHead(500).end("{}");
        });
        // Never answers: the orchestrator waits for it, 15 s at most, before it goes on.
        const edge = createServer(() => {});
        for (const server of [github, edge]) {
          await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
          t.after(() => (server.closeAllConnections(), server.close()));
        }
        return {
          GITHUB_SERVICE_URL: `http://127.0.0.1:${github.address().port}`,
          EDGE_URL: `http://127.0.0.1:${edge.address().port}`,
        };
      },
    });
    assert.equal(stopped.code, 0, stopped.output);
    assert.deepEqual(stopped.late, []);
    assert.ok(stopped.leaseFree, stopped.output);
  },
);

// Each test runs its own listener, fake GitHub and fake Docker in its own temp dir, on ports
// the OS picks, and mostly waits on them: they run side by side, two per core (eight at most).
// Not on Windows: the fake docker is a shell script, and its sandboxes are process groups.
const options = { concurrency: Math.min(8, 2 * availableParallelism()), skip: needsBash };
describe("listener", options, () => {
  // The ports a listener bound, from its log: edge's, its egress policy's.
  async function ports(listener) {
    const bound = async (name) => {
      const re = new RegExp(`${name} on :(\\d+)\n`);
      return Number((await listener.until(re)).match(re)[1]);
    };
    return [await bound("Listening"), await bound("Egress policy")];
  }

  // A listener with an App, a fake Docker and a fake GitHub serving `files`; `extra`: more
  // settings. Either may be a function of the listener's temp dir (and `extra`, of the fake
  // GitHub).
  // The operator's grant for org/repo, in the test's grants folder.
  function writeGrant(dir, text) {
    mkdirSync(join(dir, "grants", "org"), { recursive: true });
    writeFileSync(join(dir, "grants", "org", "repo.yaml"), text);
  }

  // What the operator's policies grant org/repo (grants.mjs GRANTS, #498): its policy/grants.rego,
  // which the policy service's fake opa reads back (helpers.mjs grantDecision()).
  function writeGrants(dir, names) {
    mkdirSync(join(dir, "grants", "policy"), { recursive: true });
    writeFileSync(join(dir, "grants", "policy", "grants.rego"), grantsPolicy(names));
  }

  // `opa`: the policy service's (fakeOpa()'s, allowing everything by default).
  async function listen(t, files, extra = {}, { opa } = {}) {
    // Removed once the file is done: its listener and sandboxes are stopped by then.
    const dir = tempDir(null);
    fakeDocker(dir);
    const github = await fakeGitHub(typeof files === "function" ? files(dir) : files);
    // The egress proxy's CA, which every run that reaches GitHub trusts (its calls are relayed).
    const egress = createServer((req, res) =>
      req.url === "/deckhand-ca.crt" ? res.end(TEST_CA) : res.writeHead(404).end(),
    );
    await new Promise((resolve) => egress.listen(0, "127.0.0.1", resolve));
    // The broker service, which signs the runs' tokens and the services' own: the listener (as
    // the orchestrator, edge and models) and the runner call it from loopback, each asking as
    // itself. Its public key goes in keys/.
    const brokerKey = testKey();
    // Its store and clock, which a test reads and moves on (`brokerClock.skewMs`).
    const brokerStore = openStore("memory:");
    const brokerClock = { skewMs: 0 };
    const brokerService = createBrokerService({
      store: brokerStore,
      now: () => Date.now() + brokerClock.skewMs,
      key: brokerKey,
      callers: createCallers({ networks: "edge+orchestrator+models+runner+proxy=127.0.0.0/8" }),
      keysDir: join(dir, "keys"),
    }).server;
    await new Promise((resolve) => brokerService.listen(0, "127.0.0.1", resolve));
    brokerService.unref();
    // The policy service, with an opa that denies nothing, for Deckhand's default policies: the
    // listener's service tokens, from the broker service, are checked there with keys/.
    const policyService = await servePolicies(t, {
      grantsDir: join(dir, "grants"),
      keysDir: join(dir, "keys"),
      ...(opa && { opa }),
    });
    // The App's credentials, the key with them: a listener's from before the github service,
    // which hands its key over at start; the github service holds the same App already.
    const credentials = {
      id: 5,
      client_id: "Iv1.x",
      client_secret: "cs",
      slug: "deckhand-x",
      bot_id: 77,
      webhook_secret: SECRET,
      pem: PEM,
    };
    writeFileSync(join(dir, "app.json"), JSON.stringify(credentials));
    // Edge holds the same App, but its key: the orchestrator hands the listener's over to it all
    // the same, which edge takes (the same App), and removes it from its volume.
    const edgeDir = join(dir, "edge");
    mkdirSync(edgeDir);
    const { pem: _pem, ...edgeApp } = credentials;
    writeFileSync(join(edgeDir, "app.json"), JSON.stringify(edgeApp));
    const more = typeof extra === "function" ? extra(dir, github) : extra;
    const githubService = await startGithubService(dir, github, credentials, {
      key: brokerKey,
      policyService,
      extra: more,
    });
    // The models service, in process, with the agents' credentials of `settings` (below): the
    // listener asks it which it holds, and relays the sandboxes' agent calls to it.
    let modelsOut = "";
    let models = null;
    const modelsServer = createServer((req, res) =>
      models ? models.handle(req, res) : res.writeHead(503).end(),
    );
    await new Promise((resolve) => modelsServer.listen(0, "127.0.0.1", resolve));
    modelsServer.unref();
    // The egress proxy, played by the test: the fake sandbox calls the services through it.
    let policyPortNow = 0;
    const brokerUrl = `http://127.0.0.1:${brokerService.address().port}`;
    const standIn = await sandboxProxy({
      policyPort: () => policyPortNow,
      token: (aud) => `Bearer ${signServiceToken({ sub: "proxy", aud }, brokerKey)}`,
      urls: {
        broker: brokerUrl,
        github: githubService.url,
        models: `http://127.0.0.1:${modelsServer.address().port}`,
      },
    });
    // Port 0: the OS picks free ports, which each service logs. Each calls the others: the
    // orchestrator the runner and edge, they the orchestrator, before either has started, and
    // the orchestrator and the runner restart. So they reach each other through ports of the
    // test's own, passing calls on to the copy now running (forwarder()): `listener`, `edge` and
    // `runner` below, once they listen.
    let edge = null;
    let listener = null;
    let runner = null;
    // None while the copy has exited: its port, from port 0, may be another process's already.
    const portOf = (copy, re) =>
      !copy || copy.child.exitCode !== null || copy.child.signalCode
        ? 0
        : Number([...copy.own().matchAll(re)].at(-1)?.[1] ?? 0);
    const runnerPort = await forwarder(t, () =>
      portOf(runner, /Deckhand runner \(\w+\) on :(\d+)/g),
    );
    const edgeInternalPort = await forwarder(t, () => portOf(edge, /Internal port on :(\d+)\n/g));
    const servicesPort = await forwarder(t, () => portOf(listener, /Services on :(\d+)\n/g));
    writesLanded.set(dir, () =>
      waitUntil(
        async () => {
          const res = await fetch(`http://127.0.0.1:${servicesPort}/ready`).catch(() => null);
          const body = res && (await res.json());
          return body?.ok && body.waiting === 0;
        },
        { ms: 10_000, what: "the orchestrator's map writes" },
      ),
    );
    t.after(() => writesLanded.delete(dir));
    const policyPort = await forwarder(t, () => portOf(listener, /Egress policy on :(\d+)\n/g));
    policyPortNow = policyPort;
    const settings = {
      BROKER_SERVICE_URL: brokerUrl,
      PATH: `${dir}:${process.env.PATH}`,
      DATA_DIR: dir,
      ALLOWED_USERS: "alice,bob",
      PORT: "0",
      POLICY_PORT: "0",
      SERVICES_PORT: "0",
      // A copy killed leaves its lease for this long: the next one waits it out.
      LEASE_SECONDS: "2",
      EDGE_URL: `http://127.0.0.1:${edgeInternalPort}`,
      // Where the fake sandbox reaches the services' names (fixtures/fake-docker.sh).
      DECKHAND_TEST_PROXY: `http://127.0.0.1:${standIn.port}`,
      RUNNER_URL: `http://127.0.0.1:${runnerPort}`,
      // Everything the runner and edge call from, and are called from, is this host's.
      SERVICE_NETWORKS: "runner+edge=127.0.0.0/8",
      GITHUB_API: github.url,
      PUBLIC_URL: "https://hooks.example.com",
      DEBOUNCE_MS: "0",
      BRAINSTORM_DEBOUNCE_MS: "0",
      // The egress proxy asks from here: in the tests, the fake sandbox itself.
      EGRESS_PROXY: `http://127.0.0.1:${egress.address().port}`,
      GRANTS_DIR: join(dir, "grants"),
      POLICY_SERVICE_URL: policyService,
      GITHUB_SERVICE_URL: githubService.url,
      MODELS_SERVICE_URL: `http://127.0.0.1:${modelsServer.address().port}`,
      ...more,
    };
    // Its metrics (models/metrics.mjs), which a test reads (modelsMetrics()).
    const modelsRegistry = createRegistry();
    models = startModels(settings, {
      dir,
      runnerUrl: settings.RUNNER_URL,
      registry: modelsRegistry,
      log: (line) => (modelsOut += `${line}\n`),
    });
    // The listener holds none of them (the models service does): those in `settings` go there.
    const listenerEnv = (env) =>
      Object.fromEntries(Object.entries(env).filter(([name]) => !AGENT_SECRETS.includes(name)));
    // The runner: the same settings (those it reads), its own port and store, the broker
    // service's keys, the listener's services port as its orchestrator and github service.
    // Started once the listener's is known.
    let runnerSettings = null;
    const runnerOut = () => (runner?.own() ?? "") + modelsOut;
    const startRunner = (more = {}) => {
      runner = start({ ...runnerSettings, ...more, PORT: "0" }, { script: "runner/server.mjs" });
      return runner.until(/Deckhand runner \(\w+\) on :\d+/);
    };
    // Edge, in front: its own data folder (the App but its key) and store, the orchestrator's
    // services port to pass the dashboard's API on to, its internal port for the orchestrator.
    const edgeEnv = (env) => ({
      ...listenerEnv(env),
      PORT: env.EDGE_PORT ?? "0",
      INTERNAL_PORT: "0",
      DATA_DIR: edgeDir,
      ORCHESTRATOR_URL: `http://127.0.0.1:${servicesPort}`,
      SERVICE_NETWORKS: "orchestrator=127.0.0.0/8",
    });
    edge = start(edgeEnv(settings), { script: "edge/server.mjs" });
    const edgeOut = () => edge.own();
    const others = () => edgeOut() + runnerOut();
    listener = start(listenerEnv(settings), { also: others });
    t.after(() => {
      listener.child.kill("SIGKILL");
      edge.child.kill("SIGKILL");
      runner?.child.kill("SIGKILL");
      github.server.close();
      githubService.server.closeAllConnections();
      githubService.server.close();
      egress.close();
      standIn.server.close();
      brokerService.closeAllConnections();
      brokerService.close();
      models?.stop();
      modelsServer.closeAllConnections();
      modelsServer.close();
      stopSandboxes(dir);
    });
    runnerSettings = {
      ...settings,
      SERVICE_NETWORKS: "edge+orchestrator+models=127.0.0.0/8",
      STORE_URL: `file://${join(dir, "runner-store")}`,
      ORCHESTRATOR_URL: `http://127.0.0.1:${servicesPort}`,
      SERVICE_KEYS_DIR: join(dir, "keys"),
    };
    await startRunner();
    const [port] = await ports(listener);
    settings.PORT = String(port);
    // `id`: its GUID (X-GitHub-Delivery), for a redelivery.
    const send = (payload, event = "issue_comment", id) => {
      const body = JSON.stringify(payload);
      return fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          ...(id && { "x-github-delivery": id }),
          "x-github-event": event,
          "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
        },
        body,
      });
    };
    // Stops the listener (SIGTERM unless `signal` says otherwise) and starts another one on the
    // same data and ports, with `more` settings.
    const restart = async ({ signal = "SIGTERM", ...more } = {}) => {
      const old = listener;
      const { child } = old;
      const exited = new Promise((resolve) => child.on("exit", resolve));
      const code = child.exitCode ?? (child.signalCode || (child.kill(signal), await exited));
      listener = start(listenerEnv({ ...settings, ...more }), { also: others });
      await ports(listener);
      return { code, output: old.output() };
    };
    // A handover (#506): the next copy started first, waiting for the lease, then this one
    // stopped (SIGTERM, or SIGKILL: a crash, its lease left to expire), `more` settings for the
    // next, `waiting(next)` while it waits. → the old copy's output and epoch, and the new one's
    // epoch, once it acts.
    const handOver = async ({
      signal = "SIGTERM",
      between = async () => {},
      more = {},
      waiting = async () => {},
    } = {}) => {
      const old = listener;
      const epochOf = (out) => Number(/orchestrator: lease taken \(epoch (\d+)\)/.exec(out)?.[1]);
      const next = start(listenerEnv({ ...settings, ...more }), { also: others });
      await next.until("Waiting for the orchestrator's lease");
      await waiting(next);
      const exited = new Promise((resolve) => old.child.on("exit", resolve));
      const killed = Date.now();
      old.child.kill(signal);
      await between();
      listener = next;
      await next.until("orchestrator: lease taken");
      const took = Date.now() - killed;
      await ports(next);
      await exited;
      return { output: old.output(), epoch: epochOf(old.own()), next: epochOf(next.own()), took };
    };
    // A service token the broker would sign `sub` for `aud`: the old copy's calls, after it.
    const serviceToken = (sub, aud) => `Bearer ${signServiceToken({ sub, aud }, brokerKey)}`;
    // The runner stopped (SIGTERM unless said otherwise) and another started on the same store,
    // with `more` settings: the listener carries on with it.
    const restartRunner = async ({ signal = "SIGTERM", ...more } = {}) => {
      const { child } = runner;
      const exited = new Promise((resolve) => child.on("exit", resolve));
      if (child.exitCode === null && !child.signalCode) child.kill(signal);
      await exited;
      await startRunner(more);
    };
    return {
      dir,
      github,
      get listener() {
        return listener;
      },
      get edge() {
        return edge;
      },
      get runner() {
        return runner;
      },
      port,
      // The egress proxy the test plays (sandboxProxy()).
      proxyPort: standIn.port,
      brokerStore,
      brokerClock,
      policyPort,
      send,
      restart,
      restartRunner,
      handOver,
      serviceToken,
      githubService,
      modelsMetrics: () => modelsRegistry.render(),
      urls: {
        github: githubService.url,
        runner: settings.RUNNER_URL,
        broker: settings.BROKER_SERVICE_URL,
      },
    };
  }

  function comment(login, body = "Deckhand") {
    return {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      issue: { number: 12 },
      comment: { id: 99, body, user: { login, type: "User" } },
      sender: { login },
    };
  }

  test("a listener's App: its key to the github service, the rest to edge, nothing left in its volume", async (t) => {
    const { dir, listener } = await listen(t);
    await listener.until("handed over to the github service, removed from app.json");
    await listener.until("handed over to edge, removed from /data");
    // The orchestrator keeps none of it.
    for (const name of ["app.json", "session.key", "sessions.json"]) {
      assert.equal(existsSync(join(dir, name)), false, name);
    }
    // What edge keeps: the webhook secret, the OAuth client's; never the key.
    const kept = JSON.parse(readFileSync(join(dir, "edge", "app.json"), "utf8"));
    assert.equal(kept.pem, undefined);
    assert.equal(kept.webhook_secret, SECRET);
    assert.equal(kept.client_secret, "cs");
    const held = JSON.parse(readFileSync(join(dir, "github-service", "app.json"), "utf8"));
    assert.equal(held.pem, PEM);
    assert.equal(held.webhook_secret, undefined);
  });

  test("a delivery whose handling throws is logged, and the next one is still handled", async (t) => {
    const { listener, send } = await listen(t);
    assert.equal((await send(null)).status, 202);
    await listener.until(/Delivery issue_comment {2}failed: TypeError/);
    await send(comment("alice"));
    await listener.until("done (ok)");
  });

  test("deliveries GitHub couldn't hand over are redelivered at start, once", async (t) => {
    const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    const deliveries = JSON.stringify([
      { id: 3, guid: "g-ok", delivered_at: at(1), status_code: 202, event: "issue_comment" },
      { id: 2, guid: "g-lost", delivered_at: at(2), status_code: 0, event: "issue_comment" },
      { id: 1, guid: "g-ok", delivered_at: at(3), status_code: 503, event: "issue_comment" },
      { id: 0, guid: "g-pr", delivered_at: at(4), status_code: 503, event: "pull_request" },
    ]);
    // Merged since its ready_for_review failed.
    const merged = {
      number: 13,
      html_url: "https://github.com/org/repo/pull/13",
      body: "Closes #12",
      state: "closed",
      merged: true,
      draft: false,
      head: { ref: "issue-12-fix", repo: { full_name: "org/repo" } },
    };
    const { github, listener, restart, send } = await listen(t, {
      deliveries,
      "pull:13": JSON.stringify(merged),
    });
    await listener.until("Redelivered g-lost (issue_comment");
    const attempts = () =>
      github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/attempts"));
    await listener.until("Redelivered g-pr (pull_request");
    assert.deepEqual(
      attempts().map((r) => r.path),
      ["/app/hook/deliveries/0/attempts", "/app/hook/deliveries/2/attempts"],
    );
    // GitHub sends it again, as it was then: handled as the pull request is now, merged.
    const then = {
      action: "ready_for_review",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      pull_request: { ...merged, state: "open", merged: false },
      sender: { login: "alice" },
    };
    await send(then, "pull_request", "g-pr");
    await listener.until("org/repo#12: pull request #13 merged");
    assert.match(listener.output(), /Delivery pull_request ready_for_review: redelivered, as/);
    assert.doesNotMatch(listener.output(), /pull request #13 ready/);
    // Asked once: the orchestrator restarted, edge scans again for its Sync at start, and asks
    // for none again.
    const scans = () =>
      github.requests.filter((r) => r.path.startsWith("/app/hook/deliveries?")).length;
    const before = scans();
    await restart();
    for (let i = 0; i < 200 && scans() <= before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(scans(), before + 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(attempts().length, 2);
  });

  test("the Claude credential stays out of sandboxes, and a reply leaking secrets is redacted", async (t) => {
    const credential = "sk-ant-oat01-operator-credential";
    const { dir, github, send, listener } = await listen(
      t,
      (dir) => (writeFileSync(join(dir, "leak"), credential), {}),
      (dir, github) => ({ CLAUDE_CODE_OAUTH_TOKEN: credential, ANTHROPIC_BASE_URL: github.url }),
    );
    await send(comment("alice"));
    const reply = await github.waitFor((r) => r.path === "/repos/org/repo/issues/12/comments");
    await listener.until("done (ok)");
    // A plan's token: the operator is warned at start.
    assert.match(
      listener.output(),
      /Warning: CLAUDE_CODE_OAUTH_TOKEN is a Claude plan's credential/,
    );

    // The sandbox has the run's secret where the credential would be, and the listener's URL.
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.ok(!runEnv.includes(credential));
    const agentToken = agentTokenIn(runEnv, "CLAUDE_CODE_OAUTH_TOKEN", secret);
    assert.doesNotMatch(runEnv, /^ANTHROPIC_API_KEY=/m);
    assert.match(runEnv, /^ANTHROPIC_BASE_URL=http:\/\/models:8080\/anthropic$/m);

    // Its API call reached "Anthropic" with the operator's credential, not the secret.
    const call = await github.waitFor((r) => r.path === "/v1/messages?beta=true");
    assert.equal(call.auth, `Bearer ${credential}`);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "anthropic-answer"), "utf8")), { id: 1 });

    // Neither secret is posted, nor stored in the run's log, nor its agent token in the
    // orchestrator's store, its saved state among the rest (#617). That state goes once the run
    // is cleaned up, just after "done": wait for that first.
    const body = JSON.parse(reply.body).body;
    assert.match(body, /^Leaked \[redacted\] and \[redacted\]\./);
    assert.ok(!body.includes(secret) && !body.includes(credential));
    assert.ok(!body.includes(agentToken));
    await until(() => !liveStates(dir).length, "the run's state to go");
    // Its summary and its log, the runner's, and the orchestrator's store.
    const kept = readdirSync(join(dir, "logs")).map((f) =>
      readFileSync(join(dir, "logs", f), "utf8"),
    );
    kept.push(readFileSync(join(dir, "store", "state.json"), "utf8"));
    for (const log of [...kept, ...runLogs(dir).values()]) {
      assert.ok(!log.includes(secret) && !log.includes(credential));
      assert.ok(!log.includes(agentToken));
    }
    // Its log's first line says it ran on the plan, for the dashboard after a restart.
    const header = JSON.parse((await onlyLog(dir)).split("\n")[0]);
    assert.deepEqual(
      [header.provider, header.credential, header.auth],
      ["anthropic", null, "plan"],
    );
    // At the runner, in segments: one per step of the run (its phases), the last closed at its
    // end (runner/logs.mjs).
    const [[id, text]] = runLogs(dir);
    const store = openStore(`file://${join(dir, "runner-store")}`);
    t.after(() => store.close());
    const index = () => store.get(`logs/${id}/index`);
    await waitUntil(async () => (await index())?.open === Buffer.byteLength(text), {
      what: "its last segment closed",
    });
    const { segments } = await index();
    assert.ok(segments.length >= 2, `${segments.length} segments`);
    assert.ok(segments.every((s) => s.size > 0));
  });

  test("through a gateway: its token stays out too, and opus means the gateway's model", async (t) => {
    const credential = "sk-or-v1-operator-gateway-token";
    const { dir, github, send, listener } = await listen(t, {}, (dir, github) => ({
      ANTHROPIC_AUTH_TOKEN: credential,
      ANTHROPIC_API_KEY: "sk-ant-api03-ignored-for-the-gateway",
      ANTHROPIC_BASE_URL: `${github.url}/api/`,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.1",
      SANDBOX_MODEL: "openai/gpt-5",
    }));
    await send(comment("alice"));
    await listener.until("done (ok)");

    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.ok(!runEnv.includes(credential));
    agentTokenIn(runEnv, "ANTHROPIC_AUTH_TOKEN", secret);
    // Only the variables named with -e reach the container: not the unused API key.
    const passed = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(passed.includes("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(!passed.includes("ANTHROPIC_API_KEY") && !passed.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    assert.match(runEnv, /^ANTHROPIC_BASE_URL=http:\/\/models:8080\/anthropic$/m);
    assert.match(runEnv, /^ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic\/claude-opus-4\.1$/m);
    assert.doesNotMatch(runEnv, /^ANTHROPIC_DEFAULT_SONNET_MODEL=/m);
    assert.match(runEnv, /^SANDBOX_MODEL=openai\/gpt-5$/m);

    // The call reached the gateway under its own path, with its token as a bearer.
    const call = await github.waitFor((r) => r.path === "/api/v1/messages?beta=true");
    assert.equal(call.auth, `Bearer ${credential}`);
  });

  test("Codex: its key stays out, its calls go through the listener, a mid-run comment gets a follow-up run", async (t) => {
    const key = "sk-proj-operator-openai-key";
    const { dir, github, send, listener } = await listen(
      t,
      {},
      (dir, github) => (
        writeFileSync(join(dir, "hold"), ""),
        { OPENAI_API_KEY: key, OPENAI_BASE_URL: `${github.url}/v1`, SANDBOX_AGENT: "codex" }
      ),
    );
    await send(comment("alice"));
    const egress = join(dir, "egress");
    await until(() => exists(egress)?.trim().split("\n").length === 10, "the sandbox");

    // Codex, installed into its own volume, with its session volume and the run's secret.
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.ok(!runEnv.includes(key));
    assert.match(runEnv, /^SANDBOX_AGENT=codex$/m);
    assert.match(runEnv, /^CODEX_VERSION=0\.162\.1$/m);
    agentTokenIn(runEnv, "OPENAI_API_KEY", secret);
    assert.match(runEnv, /^OPENAI_BASE_URL=http:\/\/models:8080\/openai$/m);
    assert.match(runEnv, /^SANDBOX_MODEL=gpt-6-astra$/m);
    assert.doesNotMatch(runEnv, /^(ANTHROPIC_|CLAUDE_CODE_VERSION=)/m);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(args.includes("deckhand-codex:/opt/codex:ro"));
    const session = args.find((a) => a.endsWith("-codex:/home/node/.codex"));
    assert.ok(session, "the issue's Codex session volume");
    assert.ok(!args.some((a) => a.endsWith(":/home/node/.claude")));
    const calls = readFileSync(join(dir, "docker-calls"), "utf8");
    assert.match(
      calls,
      /-e CODEX_VERSION=0\.162\.1 -v deckhand-codex:\/opt\/codex --entrypoint deckhand-install-codex/,
    );

    // Its egress: GitHub's, not Anthropic's.
    const answers = Object.fromEntries(
      readFileSync(egress, "utf8")
        .trim()
        .split("\n")
        .map((l) => [l.split(" ")[0], JSON.parse(l.slice(l.indexOf(" ") + 1)).allowed]),
    );
    assert.equal(answers["api.anthropic.com"], false);
    assert.equal(answers["github.com"], true);

    // A comment while it works: Codex takes none, so it waits for the next run, which goes
    // on in the issue's session.
    writeFileSync(join(dir, "volumes"), `${session.split(":")[0]}\n`);
    await send(followUp(100, "Also cover the edge case"));
    await listener.until("org/repo#12: queued after the running one (work)");
    writeFileSync(join(dir, "go"), "");

    // Its API call reached "OpenAI" with the operator's key, not the secret.
    const call = await github.waitFor((r) => r.path === "/v1/responses");
    assert.equal(call.auth, `Bearer ${key}`);
    const answer = await until(() => exists(join(dir, "openai-answer"))?.trim(), "its answer");
    assert.deepEqual(JSON.parse(answer), { id: 1 });

    // Two replies: the first run's, then the follow-up's, which resumed the session.
    await until(() => replies(github).length === 2, "the follow-up's reply");
    const [first, second] = replies(github).map((r) => JSON.parse(r.body).body);
    assert.match(first, /^Codex did: /);
    assert.match(first, /🤖 Codex gpt-6-astra · medium effort · 1 min/);
    assert.match(second, /^Codex did: [^]*Also cover the edge case/);
    assert.equal(exists(join(dir, "delivered")), null);
    assert.match(
      listener.output(),
      /org\/repo#12: running \S+ \(work, continue, codex gpt-6-astra\/medium\)/,
    );
    await settled(github, [99, 100]);
  });

  test("the Antigravity CLI: its plan's login stays out, its hosts relayed with the proxy's CA", async (t) => {
    const pem = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n";
    let serving = true;
    const proxy = createServer((req, res) => {
      if (req.url !== "/deckhand-ca.crt" || !serving) return res.writeHead(404).end();
      res.end(pem);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => proxy.close());
    const access = "ya29.operator-plan-access-token";
    const { dir, github, send, proxyPort, listener } = await listen(t, {}, (dir) => {
      // In the credentials folder, under its fixed name: no AGY_AUTH_FILE needed.
      mkdirSync(join(dir, "credentials"));
      const file = join(dir, "credentials", "agy-auth.json");
      writeFileSync(
        file,
        JSON.stringify({
          auth_method: "consumer",
          token: { access_token: access, refresh_token: "1//plan", expiry: "2099-01-01T00:00:00Z" },
        }),
      );
      return {
        SANDBOX_AGENT: "antigravity",
        EGRESS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      };
    });
    await send(comment("alice"));
    const reply = (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments";
    const posted = await github.waitFor(reply);
    assert.match(JSON.parse(posted.body).body, /^agy did: /);
    assert.match(
      listener.output(),
      /Antigravity CLI: a Google AI plan's login, from \S+\/credentials\/agy-auth\.json/,
    );
    assert.match(
      JSON.parse(posted.body).body,
      /🤖 Antigravity CLI gemini-4-argon-high · medium effort/,
    );

    // Installed into its own volume, its session volume, the proxy's CA; nothing of the login.
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.ok(!runEnv.includes(access) && !runEnv.includes("1//plan"));
    assert.match(runEnv, /^SANDBOX_AGENT=antigravity$/m);
    assert.match(runEnv, /^SANDBOX_PROVIDER=google$/m);
    assert.match(runEnv, /^AGY_VERSION=1\.4\.0$/m);
    assert.match(runEnv, /^SANDBOX_MODEL=gemini-4-argon-high$/m);
    const args = readFileSync(join(dir, "run-args"), "utf8");
    assert.match(args, /^deckhand-antigravity:\/opt\/antigravity:ro$/m);
    assert.match(args, /-antigravity:\/home\/node\/\.gemini$/m);
    assert.match(args, /^DECKHAND_CA=http:\/\/[^/]+\/run\/ca$/m);
    assert.match(
      readFileSync(join(dir, "docker-calls"), "utf8"),
      /-e AGY_VERSION=1\.4\.0 -e AGY_SHA256=x64:[0-9a-f]{64},arm64:[0-9a-f]{64} -v deckhand-antigravity:\/opt\/antigravity --entrypoint deckhand-install-antigravity/,
    );

    // Its token's hosts relayed, telemetry refused, the flags and the avatar a tunnel.
    const answers = Object.fromEntries(
      readFileSync(join(dir, "egress-agy"), "utf8")
        .trim()
        .split("\n")
        .map((l) => [l.split(" ")[0], JSON.parse(l.slice(l.indexOf(" ") + 1))]),
    );
    assert.equal(answers["daily-cloudcode-pa.googleapis.com"].relay, true);
    assert.equal(answers["www.googleapis.com"].relay, true);
    assert.deepEqual(answers["antigravity-unleash.goog"].relay, false);
    assert.equal(answers["antigravity-unleash.goog"].allowed, true);
    assert.equal(answers["play.googleapis.com"].allowed, false);
    assert.equal(answers["lh3.googleusercontent.com"].allowed, true);
    assert.equal(answers["lh3.googleusercontent.com"].relay, false);
    // The models service's relay knew the run's token, and refused a path agy doesn't call.
    assert.equal(readFileSync(join(dir, "relay-answer"), "utf8"), "404");
    // Its run over, its sandbox's address reaches nothing there.
    const stranger = await fetch(
      `http://127.0.0.1:${proxyPort}/relay/www.googleapis.com/oauth2/v2/userinfo`,
      { headers: { authorization: "Bearer not-a-run" } },
    );
    assert.equal(stranger.status, 403);

    // A login that can't be refreshed fails agy's model list: the reply says why, not only
    // agy's model error (#224).
    const file = join(dir, "credentials", "agy-auth.json");
    const login = JSON.parse(readFileSync(file, "utf8"));
    login.token.expiry = "2000-01-01T00:00:00Z";
    writeFileSync(file, JSON.stringify(login));
    writeFileSync(join(dir, "agy-no-models"), "");
    await send(followUp(101, "Deckhand\nOnce more"));
    const failed = await github.waitFor(
      (r) => reply(r) && JSON.parse(r.body).body.includes("stopped with an error"),
    );
    assert.match(
      JSON.parse(failed.body).body,
      /> invalid model selection [^\n]*\n\nIts last failed API call, through Deckhand: the operator's login for Google can't be refreshed right now: see the models service's log\./,
    );
    rmSync(join(dir, "agy-no-models"));

    // Without the proxy's CA, its calls can't be relayed: the run stops, saying so.
    serving = false;
    await send(followUp(100, "Deckhand\nAgain"));
    const stopped = await github.waitFor(
      (r) => reply(r) && JSON.parse(r.body).body.includes("no CA"),
    );
    assert.match(
      JSON.parse(stopped.body).body,
      /^Antigravity CLI can't run here: the egress proxy has no CA/,
    );
  });

  test("the Antigravity CLI with GEMINI_API_KEY: its key stays out, its calls go to GEMINI_BASE_URL", async (t) => {
    const key = "AIza-operator-gemini-key";
    const { dir, github, send, listener } = await listen(t, {}, (_dir, github) => ({
      GEMINI_API_KEY: key,
      GEMINI_BASE_URL: `${github.url}/gemini`,
      SANDBOX_AGENT: "antigravity",
      SANDBOX_MODEL: "fast",
    }));
    await send(comment("alice"));
    await listener.until("done (ok)");

    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.ok(!runEnv.includes(key));
    agentTokenIn(runEnv, "GEMINI_API_KEY", secret);
    assert.match(runEnv, /^GOOGLE_GEMINI_BASE_URL=http:\/\/models:8080\/google$/m);
    // The proxy's CA, which its GitHub calls need, if not its own.
    assert.match(readFileSync(join(dir, "run-args"), "utf8"), /^DECKHAND_CA=/m);

    const call = await github.waitFor((r) =>
      r.path.startsWith("/gemini/v1beta/models/gemini-3.8-flash-medium:streamGenerateContent"),
    );
    assert.equal(call.headers["x-goog-api-key"], key);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "google-answer"), "utf8")), { id: 1 });
  });

  // A Claude credential, an OpenRouter key and an OpenAI key, with FALLBACKS; `failing`: the
  // entries whose provider fails.
  function falling(t, fallbacks, failing, more = {}) {
    return listen(
      t,
      (dir) => (writeFileSync(join(dir, "failing"), failing.join("\n") + "\n"), {}),
      (dir, github) => ({
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-operator",
        ANTHROPIC_BASE_URL: github.url,
        OPENROUTER_API_KEY: "sk-or-v1-operator",
        OPENROUTER_BASE_URL: `${github.url}/openrouter`,
        OPENAI_API_KEY: "sk-proj-operator",
        OPENAI_BASE_URL: `${github.url}/v1`,
        FALLBACKS: fallbacks,
        ...more,
      }),
    );
  }

  const seen = (dir) => exists(join(dir, "runs-seen"))?.trim().split("\n") ?? [];
  const messages = (dir) => exists(join(dir, "messages"))?.split("----\n").slice(0, -1) ?? [];

  test("a provider error: the run goes on with the same agent on the next provider, one reply naming it", async (t) => {
    const { dir, github, send, listener, modelsMetrics } = await falling(
      t,
      "claude@openrouter, codex",
      ["claude@anthropic"],
      { METRICS_PORT: "0" },
    );
    await send(comment("alice", "Deckhand\nFix the login"));
    await until(() => replies(github).length === 1, "the reply");
    await settled(github, [99]);

    // Claude on Anthropic, then on OpenRouter, told why; no reply for the first run.
    assert.deepEqual(seen(dir), ["claude@anthropic default", "claude@openrouter default"]);
    const second = messages(dir)[1];
    assert.match(
      second,
      /^\(Your provider failed: overloaded \(529\)\. This run goes on in the same session through openrouter/,
    );
    assert.match(second, /Fix the login/);
    const body = JSON.parse(replies(github)[0].body).body;
    assert.match(body, /^All done\./);
    assert.match(
      body,
      /🤖 Claude \(openrouter\) opus · medium effort · 1 min · fell back from Claude \(anthropic, plan\): overloaded \(529\)/,
    );
    // Its call went to OpenRouter with the operator's key, as a bearer.
    const call = await github.waitFor((r) => r.path === "/openrouter/v1/messages?beta=true");
    assert.equal(call.auth, "Bearer sk-or-v1-operator");
    assert.match(
      listener.output(),
      /Claude \(anthropic, plan\)'s provider failed: overloaded \(529\)\. Falling back to Claude \(openrouter\)/,
    );
    // The fallback, counted by the orchestrator; each run's call by the models service (the fake
    // agent's 529 is its output's: its call got a 200).
    const port = /Metrics on :(\d+)\/metrics/.exec(listener.own())[1];
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(
      text,
      /^deckhand_model_fallbacks_total\{from="claude@anthropic:plan",to="claude@openrouter"\} 1$/m,
    );
    const calls = await modelsMetrics();
    assert.match(
      calls,
      /^deckhand_model_calls_total\{provider="anthropic",agent="claude",status="200"\} 1$/m,
    );
    assert.match(
      calls,
      /^deckhand_model_calls_total\{provider="openrouter",agent="claude",status="200"\} 1$/m,
    );
  });

  test("a webhook from the App runs a sandbox whose GitHub calls get its repo's token at the gateway", async (t) => {
    // A screenshot an orchestrator of the release before kept in its shots/ (#609).
    const kept = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("kept")]);
    const before = "00000000000000000000beef";
    const { dir, github, listener, port, proxyPort } = await listen(t, undefined, (dir) => {
      mkdirSync(join(dir, "shots", before), { recursive: true });
      writeFileSync(join(dir, "shots", before, "old.png"), kept);
      return {};
    });
    const payload = JSON.stringify(comment("alice"));
    const deliver = (signature) =>
      fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          "x-github-event": "issue_comment",
          "x-hub-signature-256": signature,
        },
        body: payload,
      });
    // Not signed with the App's secret: refused, nothing runs.
    const forged = createHmac("sha256", "other").update(payload).digest("hex");
    assert.equal((await deliver(`sha256=${forged}`)).status, 401);
    // A screenshot the sandbox uploads (a PNG's first bytes are enough).
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("png")]);
    writeFileSync(join(dir, "shot"), png);
    // Assignees it adds to its issue: one of ALLOWED_USERS, and someone else.
    writeFileSync(join(dir, "assignees"), "alice\nmallory\n");
    const good = createHmac("sha256", SECRET).update(payload).digest("hex");
    assert.equal((await deliver(`sha256=${good}`)).status, 202);

    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(JSON.parse(reply.body).body, /^All done\./);
    // The listener talks to GitHub as the installation, not with a personal token.
    assert.equal(reply.auth, "Bearer app-token");

    // The sandbox's GitHub call went through the GitHub gateway, which sent it on with a token
    // limited to its repo; the sandbox got GitHub's answer, never the token.
    assert.equal(
      JSON.parse(readFileSync(join(dir, "broker-answer"), "utf8")).default_branch,
      "trunk",
    );
    // (The listener read it too, as the installation: for its author's access, and its
    // visibility for the run's capabilities.)
    const relayed = github.requests.filter(
      (r) => r.method === "GET" && r.path === "/repos/org/repo",
    );
    assert.deepEqual(
      relayed.map((r) => r.auth),
      ["Bearer app-token", "Bearer app-token", "token repo-token"],
    );
    // Its assignees: an allowed user goes on to GitHub, anyone else is refused at the gateway.
    assert.equal(readFileSync(join(dir, "assign-alice"), "utf8"), "200");
    assert.equal(readFileSync(join(dir, "assign-mallory"), "utf8"), "403");
    const assigned = github.requests.filter(
      (r) => r.path === "/repos/org/repo/issues/12/assignees",
    );
    assert.deepEqual(
      assigned.map((r) => JSON.parse(r.body).assignees),
      [["alice"]],
    );
    const mint = github.requests.find((r) => r.body.includes("repositories"));
    assert.deepEqual(JSON.parse(mint.body).repositories, ["repo"]);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(args.includes("--network"));
    assert.ok(args.includes("deckhand.task=org/repo#12"));
    assert.equal(
      args.some((a) => a.includes(".ssh") || a.includes(".gitconfig")),
      false,
    );
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^REPO_URL=https:\/\/github\.com\/org\/repo\.git$/m);
    assert.match(runEnv, /^BASE_BRANCH=trunk$/m);
    assert.match(runEnv, /^GIT_AUTHOR_EMAIL=77\+deckhand-x\[bot\]@users\.noreply\.github\.com$/m);
    assert.doesNotMatch(runEnv, /^GH_TOKEN=/m);

    // Hardened, limited, and no volume of the listener's: its screenshots go to the broker.
    const joined = args.join(" ");
    assert.match(joined, /--cap-drop ALL --security-opt no-new-privileges/);
    // uid 1000 whatever the image's USER says.
    assert.match(joined, /--user 1000:1000/);
    assert.match(joined, /--cpus 2 --memory 4g --memory-swap 4g --pids-limit 2048/);
    assert.match(runEnv, /^SCREENSHOT_URL=https:\/\/hooks\.example\.com\/shots\/\w{24}$/m);
    assert.ok(!args.some((a) => /screenshots|deckhand-runs|volume-subpath/.test(a)));
    assert.match(runEnv, /^SCREENSHOT_DIR=\/tmp\/screenshots$/m);
    // Uploaded through the broker, served under SCREENSHOT_URL as before.
    assert.equal(readFileSync(join(dir, "shot-answer"), "utf8"), "204");
    const token = runEnv.match(/^SCREENSHOT_URL=.*\/shots\/(\w+)$/m)[1];
    // The broker keeps it, and edge serves it from there (#609).
    let served;
    for (let i = 0; i < 100; i++) {
      served = await fetch(`http://127.0.0.1:${port}/shots/${token}/page.png`);
      if (served.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    // The one kept before, moved to the broker at start, its folder removed: its link still works.
    await until(() => readdirSync(join(dir, "shots")).length === 0, "the screenshots moved");
    const old = await fetch(`http://127.0.0.1:${port}/shots/${before}/old.png`);
    assert.deepEqual(Buffer.from(await old.arrayBuffer()), kept);
    // Out through the egress proxy only, the broker directly.
    assert.match(runEnv, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(runEnv, /^https_proxy=http:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(runEnv, /^NO_PROXY=localhost,127\.0\.0\.1,::1$/m);
    assert.match(runEnv, /^NODE_USE_ENV_PROXY=1$/m);
    // The default policy: Anthropic and GitHub, nothing else.
    const egress = egressAnswers(dir);
    assert.deepEqual(allowedHosts(egress), [
      "api.anthropic.com",
      "github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
    ]);
    assert.match(listener.output(), /Egress: refused evil\.example for org\/repo#12/);

    // Once the run is over, its sandbox reaches nothing: the egress proxy refuses its calls,
    // GitHub's and its pushes (git-gateway.mjs) alike.
    await listener.until("done (ok)");
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const after = await fetch(`http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo`, {
      headers: { authorization: `token ${secret}` },
    });
    assert.equal(after.status, 403);
    const push = await fetch(
      `http://127.0.0.1:${proxyPort}/git/org/repo.git/info/refs?service=git-receive-pack`,
      {
        headers: { authorization: `Basic ${Buffer.from(`deckhand:${secret}`).toString("base64")}` },
      },
    );
    assert.equal(push.status, 403);
  });

  // The agent's token in `name` of the sandbox's environment (sandbox-spec.mjs tokenEnv()),
  // checked: for the agents' endpoints, of the same run as the run token.
  function agentTokenIn(runEnv, name, runToken) {
    const value = new RegExp(`^${name}=(.*)$`, "m").exec(runEnv)?.[1];
    assert.ok(value, `${name} in the sandbox's environment`);
    const claims = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    assert.equal(claims(value).aud, "deckhand:agents");
    assert.equal(claims(runToken).aud, "deckhand:broker");
    assert.equal(claims(value).jti, claims(runToken).jti);
    return value;
  }

  // "host {json}" lines the fake sandbox wrote → { host: answer }.
  function egressAnswers(dir) {
    const lines = readFileSync(join(dir, "egress"), "utf8").trim().split("\n");
    return Object.fromEntries(lines.map((l) => [l.split(" ")[0], JSON.parse(l.split(" ")[1])]));
  }

  function allowedHosts(answers) {
    return Object.keys(answers).filter((h) => answers[h].allowed);
  }

  const CONFIG = `# Node project
users: [alice, mallory]   # mallory isn't in ALLOWED_USERS: ignored
model: sonnet
setup: npm ci
instructions: docs/agents.md
dockerfile: docker/Dockerfile
caches:
  - /home/node/.npm
`;

  test("a repo's config: its image, caches, setup and model", async (t) => {
    const { dir, github, listener, send } = await listen(
      t,
      {
        ".deckhand.yaml": CONFIG,
        "docker/Dockerfile": "ARG DECKHAND_BASE\nFROM $DECKHAND_BASE\nRUN true\n",
      },
      (dir) => {
        writeGrants(dir, ["dockerfile"]);
        // Another repo's broken grant: said at start, and the orchestrator starts anyway.
        mkdirSync(join(dir, "grants", "org"), { recursive: true });
        writeFileSync(join(dir, "grants", "org", "other.yaml"), "hosts: [bad host]\n");
        return {};
      },
    );
    await listener.until("grants: org/other.yaml: hosts:");
    // Bob is allowed by the operator, not by the repo: nothing runs for him.
    await send(comment("bob"));
    await listener.until("bob not in ALLOWED_USERS");
    assert.equal((await send(comment("alice"))).status, 202);
    await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );

    const calls = readFileSync(join(dir, "docker-calls"), "utf8");
    // Built from the default branch's Dockerfile, FROM the base image.
    assert.match(
      calls,
      /^build .*--build-arg DECKHAND_BASE=deckhand-sandbox .*-t deckhand-repo-org-repo-[0-9a-f]{10}:[0-9a-f]{16} /m,
    );
    assert.match(readFileSync(join(dir, "built-dockerfile"), "utf8"), /FROM \$DECKHAND_BASE/);
    // Claude Code in its own container, then the cache volume, handed to the sandbox's user.
    assert.match(
      calls,
      /^run --rm .*CLAUDE_CODE_VERSION=.* --entrypoint deckhand-install-claude-code deckhand-sandbox$/m,
    );
    assert.match(calls, /^volume create .*deckhand-cache-org-repo-home-node-npm-[0-9a-f]{10}$/m);
    assert.match(
      calls,
      /-v deckhand-cache-org-repo-home-node-npm-\w+:\/home\/node\/\.npm --entrypoint chown deckhand-repo-org-repo-[0-9a-f]{10}:\w+ 1000:1000/,
    );

    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.match(args.at(-2), /^deckhand-repo-org-repo-[0-9a-f]{10}:[0-9a-f]{16}$/);
    assert.ok(
      args.some((a) => /^deckhand-cache-org-repo-home-node-npm-\w+:\/home\/node\/\.npm$/.test(a)),
    );
    // Shared by every repository: no run may change what the next one runs.
    assert.ok(args.includes("deckhand-claude-code:/opt/claude-code:ro"));
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    // No engine without `docker`: no DOCKER_HOST either.
    assert.throws(() => readFileSync(join(dir, "engine-args")));
    assert.doesNotMatch(args.join("\n"), /DOCKER_HOST/);
    assert.match(runEnv, /^SANDBOX_SETUP=npm ci$/m);
    assert.match(runEnv, /^SANDBOX_INSTRUCTIONS=docs\/agents\.md$/m);
    assert.match(runEnv, /^SANDBOX_MODEL=sonnet$/m);
  });

  test("cached_hosts: with the proxy's CA, cached but never GitHub's or the agent's; no run without it", async (t) => {
    const pem = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n";
    let serving = true;
    const proxy = createServer((req, res) => {
      if (req.url !== "/deckhand-ca.crt" || !serving) return res.writeHead(404).end();
      res.end(pem);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => proxy.close());
    const grants = (dir) => {
      mkdirSync(join(dir, "grants"), { recursive: true });
      writeFileSync(
        join(dir, "grants", "default.yaml"),
        `hosts: [registry.npmjs.org]\ncached_hosts: [registry.npmjs.org, github.com, "*.githubusercontent.com", api.anthropic.com]\n`,
      );
      return { EGRESS_PROXY: `http://127.0.0.1:${proxy.address().port}` };
    };
    const run = async () => {
      const { dir, github, send } = await listen(t, {}, grants);
      assert.equal((await send(comment("alice"))).status, 202);
      const reply = await github.waitFor(
        (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
      );
      if (!serving) return JSON.parse(reply.body).body;
      const egress = egressAnswers(dir);
      const cached = Object.entries(egress).filter(([, a]) => a.cache);
      const args = readFileSync(join(dir, "run-args"), "utf8");
      return { cached: cached.map(([host]) => host), args, egress };
    };
    const withCa = await run();
    assert.deepEqual(withCa.cached, ["registry.npmjs.org"]);
    assert.match(withCa.args, /^DECKHAND_CA=http:\/\/[^/]+\/run\/ca$/m);
    // GitHub's hosts are relayed to the github service's gateway instead, never a tunnel, the
    // run's network vouched for there.
    const { sandbox, ...github } = withCa.egress["github.com"];
    assert.deepEqual(github, {
      allowed: true,
      private: true,
      cache: false,
      decrypt: true,
      relay: true,
      service: "github",
      source: "sandbox",
    });
    assert.match(sandbox, /^id-deckhand-org-repo-12-/);
    // A work run that isn't a fork's: every *.githubusercontent.com host relayed, as GitHub's CDN
    // answers for one another (egress.mjs githubContent()).
    assert.equal(withCa.egress["objects.githubusercontent.com"].relay, true);
    // Raw files too, which the gateway sends on without a token (github-forks.mjs).
    assert.equal(withCa.egress["raw.githubusercontent.com"].relay, true);

    // The proxy has no CA (its cache is off): the run can't reach GitHub, and stops saying so.
    serving = false;
    assert.match(
      await run(),
      /^Claude can't run here: the egress proxy has no CA, and its calls to GitHub go through it/,
    );
  });

  test("hosts from default.yaml and the repo's grant, not the repo; granted mounts and limits", async (t) => {
    const { dir, github, send } = await listen(
      t,
      (dir) => ({
        ".deckhand.yaml": `hosts: [lan.internal, example.com]
mounts:
  - path: ${RW_MOUNT}
    read_only: false
  - path: ${dir}/nfs/docs
`,
      }),
      (dir) => {
        mkdirSync(join(dir, "nfs", "docs"), { recursive: true });
        writeGrant(
          dir,
          `hosts: [pypi.org, "*.example.com"]
limits: { memory: 8g }
mounts:
  - root: ${RW_MOUNT}
    read_only: false
  - ${join(dir, "nfs")}
`,
        );
        writeFileSync(join(dir, "grants", "default.yaml"), "hosts: [registry.npmjs.org]\n");
        return {};
      },
    );
    assert.equal((await send(comment("alice"))).status, 202);
    await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    const egress = egressAnswers(dir);
    assert.deepEqual(allowedHosts(egress), [
      "api.anthropic.com",
      "github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
      "registry.npmjs.org",
      "pypi.org",
      "a.b.example.com",
    ]);
    // Every host is the operator's: each may resolve to a private address (proxy.mjs), those
    // of default.yaml too, as ALLOWED_HOSTS's did.
    assert.equal(egress["registry.npmjs.org"].private, true);
    assert.equal(egress["pypi.org"].private, true);
    assert.equal(egress["a.b.example.com"].private, true);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    const joined = args.join(" ");
    assert.match(joined, /--cpus 2 --memory 8g --memory-swap 8g --pids-limit 2048/);
    assert.ok(args.includes(`type=bind,src=${RW_MOUNT},dst=${RW_MOUNT}`));
    assert.ok(
      args.includes(
        `type=bind,src=${join(dir, "nfs", "docs")},dst=${join(dir, "nfs", "docs")},readonly`,
      ),
    );
  });

  test("a run's network with a route out stops the run", async (t) => {
    const { dir, github, send } = await listen(t, {}, (dir) => {
      writeFileSync(join(dir, "network-internal"), "false\n");
      return {};
    });
    await send(comment("alice"));
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(
      JSON.parse(reply.body).body,
      /^Claude couldn't start: the run's network deckhand-org-repo-12-\S+ is not internal/,
    );
    // Neither the sandbox nor its network is left.
    assert.throws(() => readFileSync(join(dir, "run-args")));
    assert.deepEqual(readdirSync(join(dir, "nets")), []);
  });

  // Polls until `check()` is truthy (or resolves to it).
  async function until(check, what) {
    for (let i = 0; i < 400; i++) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  function exists(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  // Temporary files of state writes, in the data volume and its logs.
  const leftovers = (dir) =>
    [...readdirSync(dir), ...readdirSync(join(dir, "logs"))].filter((f) => f.endsWith(".tmp"));

  const replies = (github) =>
    github.requests.filter(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );

  // A follow-up comment on issue 12 (no trigger line), with its own id.
  function followUp(id, body) {
    const payload = comment("alice", body);
    payload.comment = { ...payload.comment, id };
    return payload;
  }

  // A listener whose sandbox waits (`hold`) before Claude's first answer, with a run started by
  // a comment saying `body`.
  async function holding(t, body, extra = () => ({})) {
    const ctx = await listen(t, {}, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      return extra(dir, github);
    });
    await ctx.send(comment("alice", body));
    const egress = join(ctx.dir, "egress");
    await until(() => exists(egress)?.trim().split("\n").length === 10, "the sandbox");
    return ctx;
  }

  // The comments' outcome reactions: the last thing a finished run does, its reply posted.
  async function settled(github, ids) {
    for (const id of ids) {
      await github.waitFor(
        (r) =>
          r.path === `/repos/org/repo/issues/comments/${id}/reactions` && /rocket/.test(r.body),
      );
    }
  }

  // What the running sandbox's secret gets from the git gateway and from opening its pull
  // request through the GitHub gateway (`gh pr create`'s write, over REST).
  async function pushAndOpen({ dir, proxyPort }) {
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const basic = Buffer.from(`deckhand:${secret}`).toString("base64");
    const push = await fetch(
      `http://127.0.0.1:${proxyPort}/git/org/repo.git/info/refs?service=git-receive-pack`,
      { headers: { authorization: `Basic ${basic}` } },
    );
    const opened = await fetch(
      `http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo/pulls`,
      {
        method: "POST",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({ title: "t", head: "issue-12-x", base: "trunk" }),
      },
    );
    return [`${push.status} ${await push.text()}`, `${opened.status} ${await opened.text()}`];
  }

  // The reactions a comment got, by content.
  const reactions = (github, id) =>
    github.requests
      .filter(
        (r) => r.method === "POST" && r.path === `/repos/org/repo/issues/comments/${id}/reactions`,
      )
      .map((r) => JSON.parse(r.body).content);

  test("/cancel stops a working run: a short reply, no fallback, and what was queued runs next", async (t) => {
    const ctx = await holding(t);
    const { dir, github, send } = ctx;
    // A brainstorm comment waits for the next run: it isn't the running session's mode.
    await send(followUp(100, "Deckhand\n/mode brainstorm\nWhat else?"));
    await ctx.listener.until("queued after the running one");
    // The next run doesn't wait.
    rmSync(join(dir, "hold"));
    await send(followUp(101, "/cancel"));
    await ctx.listener.until("done (cancelled)");
    const calls = readFileSync(join(dir, "docker-calls"), "utf8");
    assert.match(calls, /^stop -t 10 deckhand-org-repo-12-0e9572aae2$/m);
    // The agent never got it; its sandbox and saved state went as usual, its volumes stay.
    assert.doesNotMatch(ctx.listener.output(), /for the running session/);
    assert.doesNotMatch(calls, /^volume rm/m);
    // How long the run took is the machine's: a slow runner says 0.1 min.
    const [stopped] = replies(github);
    assert.match(
      JSON.parse(stopped.body).body,
      /^Stopped by @alice\.\n\n<sub>🤖 Claude opus · medium effort · [\d.]+ min<\/sub>/,
    );
    assert.doesNotMatch(JSON.parse(stopped.body).body, /stopped with an error/);
    // Then the brainstorm runs: what was queued wasn't dropped.
    await ctx.listener.until("done (ok)");
    await settled(github, [100]);
    assert.equal(replies(github).length, 2);
    assert.deepEqual(reactions(github, 101), ["+1"]);
    // 👀 only: no error, no 🚀 for the comment of the stopped run.
    assert.deepEqual(reactions(github, 99), ["eyes"]);
    assert.ok(
      github.requests.some((r) => r.method === "DELETE" && /comments\/99\/reactions/.test(r.path)),
    );
    assert.doesNotMatch(ctx.listener.output(), /Falling back|done \(error\)/);
    // The dashboard's list, rebuilt from the summaries after a restart, keeps it cancelled, and
    // its log at the runner says who.
    await ctx.restart();
    const cancelled = [...runLogs(dir).values()].filter((text) =>
      /"event":"cancelled","by":"alice"/.test(text),
    );
    assert.equal(cancelled.length, 1);
  });

  test("/cancel while the run is prepared: no sandbox starts, the run ends cancelled", async (t) => {
    const ctx = await listen(t, {}, (dir) => {
      const script = join(dir, "while-preparing");
      writeFileSync(
        script,
        `#!/bin/bash\ntouch "${dir}/preparing"\nuntil [ -e "${dir}/prepared" ]; do sleep 0.05; done\n`,
      );
      chmodSync(script, 0o755);
      return {};
    });
    const { dir, github } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "preparing")) !== null, "the run's preparation");
    await ctx.send(followUp(101, "/cancel"));
    await ctx.listener.until("cancelled by alice");
    writeFileSync(join(dir, "prepared"), "");
    await ctx.listener.until("done (cancelled)");
    assert.equal(exists(join(dir, "run-args")), null);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^Stopped by @alice\./);
  });

  test("/cancel with nothing running: a reply says so, nothing stops", async (t) => {
    const ctx = await listen(t, {});
    await ctx.send(comment("alice", "/cancel"));
    await ctx.github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(JSON.parse(replies(ctx.github)[0].body).body, /^Nothing is running on #12\./);
    assert.equal(exists(join(ctx.dir, "run-args")), null);
  });

  test("a listener restarted between the cancel and the exit: still cancelled, nothing requeued", async (t) => {
    const ctx = await holding(t);
    const { dir, github } = ctx;
    writeFileSync(join(dir, "stuck"), "");
    await ctx.send(followUp(101, "/cancel"));
    await until(() => /^stop /m.test(exists(join(dir, "docker-calls")) ?? ""), "the stop");
    rmSync(join(dir, "stuck"));
    await ctx.restart();
    await ctx.listener.until("done (cancelled)");
    // Stopped again by the new listener, once.
    const stops = readFileSync(join(dir, "docker-calls"), "utf8").match(/^stop /gm);
    assert.equal(stops.length, 2);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^Stopped by @alice\./);
    // Removed once the run is torn down, after its end is logged (runs.mjs teardown()).
    await until(() => !readdirSync(join(dir, "containers")).length, "the sandbox's removal");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.doesNotMatch(ctx.listener.output(), /queued again|interrupted|queued \(work/);
  });

  test("a listener restarted after a run's output passed RUN_LOG_MAX_MB: stopped again, failed, nothing requeued", async (t) => {
    const ctx = await holding(t, undefined, () => ({ RUN_LOG_MAX_MB: "1" }));
    const { dir, github } = ctx;
    writeFileSync(join(dir, "stuck"), "");
    const [name] = readdirSync(join(dir, "containers"));
    const line = "x".repeat(100 * 1024) + "\n";
    appendFileSync(join(dir, "containers", name, "out"), line.repeat(12));
    await until(() => /^stop /m.test(exists(join(dir, "docker-calls")) ?? ""), "the stop");
    rmSync(join(dir, "stuck"));
    await ctx.restart();
    await ctx.listener.until("done");
    const stops = readFileSync(join(dir, "docker-calls"), "utf8").match(/^stop /gm);
    assert.equal(stops.length, 2);
    assert.equal(replies(github).length, 1);
    assert.match(
      JSON.parse(replies(github)[0].body).body,
      /^Claude was stopped as failed: its output passed RUN_LOG_MAX_MB \(1 MB\)/,
    );
    // Removed once the run is torn down, after its end is logged (runs.mjs teardown()).
    await until(() => !readdirSync(join(dir, "containers")).length, "the sandbox's removal");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.doesNotMatch(ctx.listener.output(), /queued again|interrupted|queued \(work/);
  });

  test("/cancel on a run that answered but didn't exit, after a restart: its answer is posted", async (t) => {
    const ctx = await listen(t, {}, (dir) => {
      writeFileSync(join(dir, "linger"), "");
      return {};
    });
    const { dir, github } = ctx;
    await ctx.send(comment("alice"));
    // Its answer read and its inbox closed, the sandbox still running.
    const answered = () => liveStates(dir).some((saved) => saved.answered === true);
    await until(answered, "the answer");
    await ctx.restart();
    await ctx.listener.until("picked up");
    await ctx.send(followUp(101, "/cancel"));
    await ctx.listener.until("done (cancelled)");
    assert.equal(replies(github).length, 1);
    assert.match(
      JSON.parse(replies(github)[0].body).body,
      /^All done\.\n\nStopped by @alice after its answer\.\n\n<sub>🤖 Claude/,
    );
  });

  test("a brainstorm can't push or open a pull request, before or after a restart", async (t) => {
    const ctx = await holding(t, "Deckhand\n/mode brainstorm\nWhat about dark mode?");
    const refused = [
      /^403 Deckhand: this run can't push/,
      // It has no branch: refused before any policy.
      /^403 .*issue-12-x is not this run's branch/,
    ];
    const check = async () => {
      const answers = await pushAndOpen(ctx);
      answers.forEach((answer, i) => assert.match(answer, refused[i]));
    };
    await check();
    assert.match(readFileSync(join(ctx.dir, "run-env"), "utf8"), /^SANDBOX_LIGHT=1$/m);
    await ctx.restart();
    await ctx.listener.until("again");
    await check();
  });

  test("a brainstorm's REST writes: its issue's description, not another issue's, after a restart too", async (t) => {
    const files = {
      "issue:12": JSON.stringify({ number: 12, user: { login: "alice" }, labels: [] }),
      "issue:3": JSON.stringify({ number: 3, user: { login: "bob" }, labels: [] }),
    };
    const ctx = await listen(t, files, (dir) => (writeFileSync(join(dir, "hold"), ""), {}), {
      opa: brainstormOpa(),
    });
    await ctx.send(comment("alice", "Deckhand\n/mode brainstorm\nWhat about dark mode?"));
    await until(() => exists(join(ctx.dir, "egress"))?.trim().split("\n").length === 10, "the run");
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const patch = (number) =>
      fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo/issues/${number}`, {
        method: "PATCH",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({ body: "Updated." }),
      });
    const check = async () => {
      const own = await patch(12);
      assert.equal(own.status, 200);
      const other = await patch(3);
      assert.equal(other.status, 403);
      assert.match(
        (await other.json()).message,
        /no rule allows `edit` on `other_issue` for a `brainstorm` run/,
      );
    };
    await check();
    const edits = ctx.github.requests.filter((r) => r.method === "PATCH");
    assert.deepEqual(
      edits.map((r) => [r.path, r.auth]),
      [["/repos/org/repo/issues/12", "token repo-token"]],
    );
    // Its kind looked up with the listener's token, not the run's.
    const lookup = ctx.github.requests.find(
      (r) => r.method === "GET" && r.path === "/repos/org/repo/issues/3/parent",
    );
    assert.equal(lookup.auth, "Bearer app-token");
    await ctx.restart();
    await ctx.listener.until("again");
    await check();
  });

  test("a brainstorm's GraphQL: checked from its nodes, printed again, the only call whose token writes", async (t) => {
    const issue = (number) => ({
      __typename: "Issue",
      number,
      databaseId: number,
      repository: { nameWithOwner: "org/repo" },
    });
    const files = {
      "issue:12": JSON.stringify({ number: 12, user: { login: "alice" }, labels: [] }),
      "issue:3": JSON.stringify({ number: 3, user: { login: "bob" }, labels: [] }),
      nodes: JSON.stringify({ data: { nodes: [issue(12), issue(3)] } }),
    };
    const ctx = await listen(t, files, (dir) => (writeFileSync(join(dir, "hold"), ""), {}), {
      opa: brainstormOpa(),
    });
    await ctx.send(comment("alice", "Deckhand\n/mode brainstorm\nWhat about dark mode?"));
    await until(() => exists(join(ctx.dir, "egress"))?.trim().split("\n").length === 10, "the run");
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const graphql = (query) =>
      fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/graphql`, {
        method: "POST",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({ query }),
      });
    const mints = () => ctx.github.requests.filter((r) => r.body.includes("repositories"));
    // Its own issue's description goes on, the other one's refuses the call.
    const both = (second) =>
      `mutation { a: updateIssue(input: {id: "I_12", body: "Hi"}) { clientMutationId } b: updateIssue(input: {id: "${second}", body: "Hi"}) { clientMutationId } }`;
    const refused = await graphql(both("I_3"));
    assert.equal(refused.status, 403);
    assert.match(
      (await refused.json()).message,
      /^Deckhand: b: .*no rule allows `edit` on `other_issue` for a `brainstorm` run/,
    );
    const relayed = () =>
      ctx.github.requests.filter((r) => r.path === "/graphql" && r.auth === "token repo-token");
    assert.deepEqual(relayed(), []);
    files.nodes = JSON.stringify({ data: { nodes: [issue(12)] } });
    const ok = await graphql(both("I_12"));
    assert.equal(ok.status, 200);
    // What GitHub got: the document as the gateway printed it, with a token that writes.
    const sent = relayed();
    assert.equal(sent.length, 1);
    assert.match(JSON.parse(sent[0].body).query, /^mutation \{\n {2}a: updateIssue\(input: \{/);
    assert.equal(JSON.parse(mints().at(-1).body).permissions.issues, "write");
    // Its nodes looked up with the listener's token, not the run's.
    const lookup = ctx.github.requests.find((r) => r.body.includes("nodes(ids:"));
    assert.equal(lookup.auth, "Bearer app-token");
    // A query: its token only reads, as every other call of the run's.
    assert.equal((await graphql("{ viewer { login } }")).status, 200);
    const levels = mints().map((m) => JSON.parse(m.body).permissions.issues);
    assert.deepEqual([...new Set(levels)].sort(), ["read", "write"]);
    assert.equal(levels.filter((l) => l === "write").length, 1);
    // CI's checks and statuses (`gh pr checks`): held to deny_github's read_checks, which
    // Deckhand's defaults allow, then read with a token that has them.
    const rollup =
      '{ repository(owner: "org", name: "repo") { pullRequest(number: 1) { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }';
    assert.equal((await graphql(rollup)).status, 200);
    await fetch(
      `http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo/commits/abc/check-runs`,
      {
        headers: { authorization: `token ${secret}` },
      },
    );
    assert.ok(ctx.github.requests.some((r) => r.path === "/repos/org/repo/commits/abc/check-runs"));
    assert.equal(JSON.parse(mints().at(-1).body).permissions.checks, "read");
    // A mutation Deckhand doesn't know: refused before anything is looked up.
    const deleted = await graphql(
      'mutation { deleteIssue(input: {issueId: "I_3"}) { clientMutationId } }',
    );
    assert.equal(deleted.status, 403);
  });

  test("projects: a granted project's item added by the run; the listener moves its issue at start and ready", async (t) => {
    const node = (n) => ({ data: { nodes: n } });
    const files = {
      ".deckhand.yaml":
        "projects:\n  - project: acme/3\n    start: In progress\n    ready: In review\n",
      "issue:12": JSON.stringify({ number: 12, user: { login: "alice" }, labels: [] }),
      "graphql:projectV2(number": JSON.stringify({
        data: {
          organization: {
            projectV2: {
              id: "PV_3",
              field: {
                __typename: "ProjectV2SingleSelectField",
                id: "F_status",
                options: [
                  { id: "O_1", name: "In progress" },
                  { id: "O_2", name: "In review" },
                ],
              },
            },
          },
        },
      }),
      "graphql:issue(number": JSON.stringify({ data: { repository: { issue: { id: "I_12" } } } }),
      "graphql:pullRequest(number": JSON.stringify({
        data: { repository: { pullRequest: { id: "PR_50" } } },
      }),
      "graphql:mutation($project: ID!, $content": JSON.stringify({
        data: { addProjectV2ItemById: { item: { id: "PVTI_12" } } },
      }),
      "graphql:updateProjectV2ItemFieldValue": JSON.stringify({
        data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_12" } } },
      }),
    };
    const ctx = await listen(t, files, (dir) => {
      writeGrant(dir, "allow_projects: [acme/3]\n");
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    const set = (option) => (r) =>
      r.path === "/graphql" &&
      r.body.includes("updateProjectV2ItemFieldValue") &&
      JSON.parse(r.body).variables.option === option;
    await ctx.send(comment("alice", "Deckhand"));
    // At start: In progress, with the listener's own token.
    const started = await ctx.github.waitFor(set("O_1"));
    assert.equal(started.auth, "Bearer app-token");
    assert.deepEqual(JSON.parse(started.body).variables, {
      project: "PV_3",
      item: "PVTI_12",
      field: "F_status",
      option: "O_1",
    });
    await ctx.listener.until("org/repo#12: projects: acme/3: In progress (start)");
    // The run adds its issue to the granted project, never to another.
    await until(() => exists(join(ctx.dir, "run-token")), "the run");
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const add = (project) =>
      fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/graphql`, {
        method: "POST",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({
          query: `mutation { addProjectV2ItemById(input: {contentId: "I_12", projectId: "${project}"}) { item { id } } }`,
        }),
      });
    const issue = { __typename: "Issue", number: 12, databaseId: 12 };
    const repo = { repository: { nameWithOwner: "org/repo" } };
    const project = (number) => ({
      __typename: "ProjectV2",
      number,
      title: "Roadmap",
      owner: { login: "acme" },
    });
    files.nodes = JSON.stringify(node([{ ...issue, ...repo }, project(9)]));
    const refused = await add("PV_9");
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).message, /write project acme\/9 \(allow_projects\)/);
    files.nodes = JSON.stringify(node([{ ...issue, ...repo }, project(3)]));
    assert.equal((await add("PV_3")).status, 200);
    const mints = ctx.github.requests.filter((r) => r.body.includes("repositories"));
    assert.equal(JSON.parse(mints.at(-1).body).permissions.organization_projects, "write");
    // Its pull request turns ready: In review.
    await ctx.send(
      {
        action: "ready_for_review",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        pull_request: {
          number: 50,
          state: "open",
          draft: false,
          body: "Closes #12",
          html_url: "https://github.com/org/repo/pull/50",
          head: { ref: "issue-12-x", sha: "abc", repo: { full_name: "org/repo" } },
          base: { ref: "trunk" },
          user: { login: "deckhand-x[bot]" },
        },
        sender: { login: "alice" },
      },
      "pull_request",
    );
    // Its issue and itself, the bot's pull request.
    await ctx.listener.until("org/repo#12 and #50: projects: acme/3: In review (ready)");
    const ready = ctx.github.requests.filter(set("O_2"));
    assert.equal(ready.length, 2);
    const added = ctx.github.requests.filter(
      (r) => r.path === "/graphql" && r.body.includes("$content") && r.auth === "Bearer app-token",
    );
    assert.deepEqual(
      added.map((r) => JSON.parse(r.body).variables.content),
      ["I_12", "I_12", "PR_50"],
    );
  });

  test("an installation token the github service used for a run: redacted from its log and reply by its fingerprint", async (t) => {
    // Long enough to fingerprint, and of no GitHub token's shape: only its fingerprint finds it.
    const used = "v1.installationtoken0123456789abcdef";
    const ctx = await listen(t, { repoToken: used }, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    await ctx.send(comment("alice"));
    const egress = join(ctx.dir, "egress");
    await until(() => exists(egress)?.trim().split("\n").length === 10, "the sandbox");
    // The run's call, relayed through the listener to the in-process github service, which mints
    // the token and sends its fingerprint to the listener.
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const read = await fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo`, {
      headers: { authorization: `token ${secret}` },
    });
    assert.equal(read.status, 200);
    assert.ok(ctx.github.requests.some((r) => r.auth === `token ${used}`));
    // Its fingerprint reaches the listener as an event, once the orchestrator took it.
    await until(() => ctx.githubService.taken("token"), "the token's fingerprint");
    writeFileSync(join(ctx.dir, "result"), `The token is ${used}.`);
    writeFileSync(join(ctx.dir, "go"), "");
    await ctx.listener.until("done (ok)");
    const log = await onlyLog(ctx.dir);
    assert.ok(!log.includes(used), "the token in the log");
    assert.match(log, /The token is \[redacted\]\./);
    const replies = ctx.github.requests.filter(
      (r) => r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.ok(replies.length);
    for (const reply of replies) assert.ok(!reply.body.includes(used), "the token in the reply");
  });

  test("a run's token sent from another address: the egress proxy lets none of it through", async (t) => {
    const ctx = await holding(t, undefined, (dir, github) => ({ GITHUB_URL: github.url }));
    // The sandbox no longer has the address the requests come from; a restarted runner looks
    // its addresses up again.
    writeFileSync(join(ctx.dir, "elsewhere"), "");
    await ctx.restartRunner();
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const token = await fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo`, {
      headers: { authorization: `token ${secret}` },
    });
    assert.equal(token.status, 403);
    // That address is no running sandbox's: no GitHub, push or ready, refused before any service.
    const [push, opened] = await pushAndOpen(ctx);
    assert.match(push, /^403 [^]*only a running sandbox reaches the github service/);
    assert.match(opened, /^403 /);
  });

  test("a run token renewed after a takeover: the broker's event has the next copy redact it by value (#617)", async (t) => {
    const ctx = await holding(t);
    await ctx.handOver();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    // A minute on at the broker: the sandbox's renewal gets a token of its own, not the last one.
    ctx.brokerClock.skewMs = 61_000;
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${ctx.proxyPort}/run/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(res.status, 200);
    const renewed = (await res.text()).trim();
    assert.notEqual(renewed, secret);
    // The orchestrator handled the broker's `renewed` event (acknowledged it).
    const pending = async () =>
      (await ctx.brokerStore.read("runs", "orchestrator")).some(
        ({ event }) => event.type === "renewed",
      );
    for (let i = 0; await pending(); i++) {
      if (i > 400) throw new Error("timed out waiting for the renewed event's handling");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Its signature alone, which no token shape matches: only its value redacts it.
    const signature = renewed.split(".")[2];
    writeFileSync(join(ctx.dir, "leak"), signature);
    writeFileSync(join(ctx.dir, "go"), "");
    const reply = await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/12/comments");
    const body = JSON.parse(reply.body).body;
    assert.match(body, /^Leaked \[redacted\] and \[redacted\]\./);
    assert.ok(!body.includes(signature));
  });

  test("a work run still pushes and opens its pull request, before and after a restart", async (t) => {
    const ctx = await holding(t, undefined, (dir, github) => ({ GITHUB_URL: github.url }));
    // Past the run checks: on to GitHub (here, a fake one that knows neither, rather than
    // github.com, which a sandbox without network waits for).
    const check = async () => {
      for (const answer of await pushAndOpen(ctx)) {
        assert.doesNotMatch(answer, /^40[13]|can't push|its ceiling/);
      }
      // Not a fork's run: a fork's pull request's head is refused it (github-forks.mjs).
      const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
      const archive = await fetch(
        `http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo/tarball/refs/pull/41/head`,
        { headers: { authorization: `token ${secret}` } },
      );
      assert.equal(archive.status, 403);
      assert.match(
        (await archive.json()).message,
        /pull request #41 is from a fork \(someone\/repo\)/,
      );
    };
    await check();
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    await check();
  });

  test("a work run on an issue without a branch: the listener creates and links it, TASK_BRANCH", async (t) => {
    const { dir, github, send } = await listen(t, {
      "branches:12": "[]",
      "ref:trunk": "base-sha",
      "issue:12": JSON.stringify({ number: 12, node_id: "I_12", title: "Add a thing", labels: [] }),
    });
    await send(comment("alice"));
    await until(() => exists(join(dir, "run-env")), "the run");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_BRANCH=issue-12-add-a-thing$/m);
    const link = github.requests.find(
      (r) => r.path === "/graphql" && r.body.includes("createLinkedBranch"),
    );
    // As the listener, at the base's head, before the sandbox started.
    assert.equal(link.auth, "Bearer app-token");
    assert.deepEqual(JSON.parse(link.body).variables.input, {
      issueId: "I_12",
      oid: "base-sha",
      name: "issue-12-add-a-thing",
      repositoryId: "R_1",
    });
    // Deckhand's gh-linked-branch.rego was asked: the task's page keeps its decision.
    const decisions = await storedMap(dir, "decisions");
    assert.deepEqual(
      decisions["org/repo#12"].map((d) => [d.rule, d.denied]),
      [["deny_link_branch", false]],
    );
  });

  test("on SIGTERM the orchestrator holds none of the sandboxes' calls: one in flight goes on as it exits", async (t) => {
    const ctx = await holding(t);
    const { dir, github, proxyPort, policyPort, listener } = ctx;
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    // A sandbox's call the GitHub gateway relays, left unanswered (an agent's stream, a push).
    const slow = (r) => r.method === "GET" && r.path === "/repos/org/repo/commits/held";
    const release = github.hold(slow);
    t.after(release);
    const inFlight = fetch(
      `http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo/commits/held`,
      { headers: { authorization: `token ${secret}` } },
    );
    await github.waitFor(slow);

    // The egress policy answers on its own port: the sandboxes' connections go on.
    const asked = await fetch(`http://127.0.0.1:${policyPort}/egress?ip=10.9.0.5&host=github.com`);
    assert.equal((await asked.json()).allowed, true);
    // The orchestrator exits without waiting for the call, which is the github service's.
    const exited = new Promise((resolve) => listener.child.on("exit", resolve));
    listener.child.kill("SIGTERM");
    assert.equal(await exited, 0);
    release();
    const answer = await inFlight;
    assert.equal(answer.status, 200);
    await answer.text();
  });

  test("a restart during a run: it goes on, a new comment reaches it, one reply", async (t) => {
    const ctx = await holding(t);
    const { dir, github, send, proxyPort } = ctx;
    const { code, output } = await ctx.restart();
    assert.equal(code, 0);
    assert.match(output, /Stopping: running sandboxes go on/);
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");

    // Its GitHub calls still go through, at the github service's gateway.
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const token = await fetch(`http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo`, {
      headers: { authorization: `token ${secret}` },
    });
    assert.equal(token.status, 200);

    // A comment without a trigger line goes to the running session, through its inbox.
    await send(followUp(100, "Also cover the edge case"));
    const [run] = readdirSync(join(dir, "runs"));
    const inbox = join(dir, "runs", run, "inbox.jsonl");
    await until(() => exists(inbox)?.includes("Also cover the edge case"), "the delivery");
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    assert.match(exists(join(dir, "delivered")), /Also cover the edge case/);
    // Both comments get their outcome.
    await settled(github, [99, 100]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^Answered\./);
    // The sandbox, its inbox and the run's saved state are gone, once the run is torn down.
    await until(() => !readdirSync(join(dir, "containers")).length, "the sandbox's removal");
    assert.deepEqual(readdirSync(join(dir, "runs")), []);
    assert.deepEqual(liveStates(dir), []);
    // Its state was written whole each time (lib/files.mjs).
    assert.deepEqual(leftovers(dir), []);
  });

  test("a recreated proxy joins the running sandbox's network again", async (t) => {
    const ctx = await holding(t);
    const { dir } = ctx;
    const [net] = readdirSync(join(dir, "nets"));
    const joined = () =>
      readFileSync(join(dir, "nets", net), "utf8")
        .split("\n")
        .filter(Boolean);
    // Its own network: the sandbox and the proxy, nothing else.
    assert.equal(joined().length, 2);
    assert.ok(joined().includes("egress-1"));
    // Left by a run nobody knows about any more.
    writeFileSync(join(dir, "nets", "deckhand-gone-1"), "egress-1\n");
    // `docker compose up -d`: new containers, on none of the runs' networks.
    writeFileSync(join(dir, "nets", net), joined()[0] + "\n");
    // The runner's settings: it joins it.
    await ctx.restartRunner({ EGRESS_CONTAINER: "egress-2" });
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    assert.deepEqual(joined().slice(1), ["egress-2"]);
    const calls = readFileSync(join(dir, "docker-calls"), "utf8");
    assert.match(calls, new RegExp(`^network connect ${net} egress-2$`, "m"));
    assert.deepEqual(readdirSync(join(dir, "nets")), [net]);
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    // The run's network goes with it.
    await until(() => !readdirSync(join(dir, "nets")).length, "the network's removal");
    assert.match(
      calls + readFileSync(join(dir, "docker-calls"), "utf8"),
      new RegExp(`^network rm ${net}$`, "m"),
    );
  });

  test("a comment queued for a running session is checked against the repo's users after a restart", async (t) => {
    const files = { ".deckhand.yaml": "users: [alice, bob]\n" };
    const ctx = await listen(t, files, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    const { dir } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    // Bob's comment waits out a long pause for the running session, then the listener stops.
    await ctx.restart({ DEBOUNCE_MS: "60000" });
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    await ctx.send({
      ...followUp(100, "Also delete the tests"),
      comment: { id: 100, body: "Also delete the tests", user: { login: "bob", type: "User" } },
    });
    await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/100/reactions");
    // Meanwhile, the repo's users leave bob out.
    files[".deckhand.yaml"] = "users: [alice]\n";
    const { output } = await ctx.restart({ DEBOUNCE_MS: "0" });
    assert.match(output, /1 task\(s\) with queued comments left to the next copy/);
    await ctx.listener.until("a queued comment dropped: bob is no longer an allowed user");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [run] = readdirSync(join(dir, "runs"));
    assert.doesNotMatch(exists(join(dir, "runs", run, "inbox.jsonl")) ?? "", /delete the tests/);
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
  });

  // The orchestrator's handover (#506), with its two copies: issue 12's run held, a comment on
  // issue 13 queued behind it (one run at a time), the next copy waiting for the lease.
  async function handingOver(t, { lease = 8 } = {}) {
    // A lease far longer than a handover: taking it at once shows it was released.
    // GITHUB_URL: the dashboard's sign-in, through the fake GitHub.
    const ctx = await holding(t, "Deckhand", (dir, github) => ({
      MAX_PARALLEL: "1",
      LEASE_SECONDS: String(lease),
      GITHUB_URL: github.url,
    }));
    const queued = comment("alice");
    queued.issue = { number: 13 };
    queued.comment = { ...queued.comment, id: 130 };
    await ctx.send(queued);
    for (let i = 0; ; i++) {
      const status = await (await fetch(`http://127.0.0.1:${ctx.port}/status`)).json();
      if (status.queued === 1) break;
      if (i > 400) throw new Error("timed out waiting for the queued comment");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return ctx;
  }

  const posted = (github, number) =>
    github.requests.filter(
      (r) => r.method === "POST" && r.path === `/repos/org/repo/issues/${number}/comments`,
    );

  // Its epoch refused by every service it called: the github service, the runner, the broker.
  async function staleEverywhere(ctx, epoch) {
    const headers = (aud) => ({
      authorization: ctx.serviceToken("orchestrator", aud),
      "x-deckhand-epoch": String(epoch),
      "content-type": "application/json",
    });
    const github = await fetch(`${ctx.urls.github}/reactions`, {
      method: "PUT",
      headers: headers("github"),
      body: JSON.stringify({ repo: "org/repo", subject: "comment:1", content: "eyes" }),
    });
    assert.equal(github.status, 409, await github.text());
    const runner = await fetch(`${ctx.urls.runner}/sandboxes/deckhand-org-repo-12-x/kill`, {
      method: "POST",
      headers: headers("runner"),
      body: "{}",
    });
    assert.equal(runner.status, 409, await runner.text());
    const broker = await fetch(`${ctx.urls.broker}/runs/nothing`, {
      method: "DELETE",
      headers: headers("broker"),
    });
    assert.equal(broker.status, 409, await broker.text());
  }

  // A crash's lease is waited out, twice: 4 s rather than 8, still past a handover's time.
  for (const [signal, how, lease] of [
    ["SIGTERM", "on SIGTERM: the lease released, taken at once", 8],
    ["SIGKILL", "after a crash: the lease taken once it expired", 4],
  ]) {
    test(`a handover ${how}; a queued comment runs once, a run's end gets one reply, the old epoch is refused`, async (t) => {
      const ctx = await handingOver(t, { lease });
      const { dir, github } = ctx;
      // The next copy's metrics (lib/metrics.mjs): its lease not held while it waits, then held.
      const scrape = async (copy) => {
        await copy.until(/Metrics on :\d+\/metrics/);
        const port = /Metrics on :(\d+)\/metrics/.exec(copy.own())[1];
        return (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      };
      const leaseHeld = async (copy) => {
        const text = await scrape(copy);
        // What only the acting copy knows (listener/metrics.mjs), the waiting one has no sample of.
        if (!copy.own().includes("lease taken")) {
          assert.doesNotMatch(text, /^deckhand_runs_running /m);
          assert.doesNotMatch(text, /^deckhand_runs_queued\{/m);
          assert.doesNotMatch(text, /^deckhand_auto_pickup_slots\{/m);
        }
        return /^deckhand_lease_held\{lease="orchestrator"\} (\d)$/m.exec(text)?.[1];
      };
      const { output, epoch, next, took } = await ctx.handOver({
        signal,
        // Claude answers issue 12 while the copies hand over.
        between: async () => writeFileSync(join(dir, "go"), ""),
        more: { METRICS_PORT: "0" },
        waiting: async (copy) => assert.equal(await leaseHeld(copy), "0"),
      });
      assert.equal(await leaseHeld(ctx.listener), "1");
      if (signal === "SIGTERM") {
        assert.match(output, /orchestrator: lease released/);
        // Not a lease's life (8 s here, 15 by default): the waiting copy took it at once.
        assert.ok(took < 3000, `${took} ms`);
      } else {
        // Its lease left to expire: at least what was left of it (2.7 s), its last renewal 4/3 s
        // ago at most.
        assert.ok(took > 2000, `${took} ms`);
      }
      assert.ok(next > epoch, `${next} after ${epoch}`);
      // Issue 12's run ended across the handover: one reply. Then 13's, from the queue: one run.
      await settled(github, [99, 130]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(posted(github, 12).length, 1);
      assert.equal(posted(github, 13).length, 1);
      const runs = ctx.listener.output().match(/org\/repo#13: done/g) ?? [];
      assert.equal(runs.length, 1, ctx.listener.output());
      // Its metrics (listener/metrics.mjs): 13's run started here, 12's and 13's ended here; its
      // calls to the github service counted.
      const text = await scrape(ctx.listener);
      const sum = (name) =>
        [...text.matchAll(new RegExp(`^${name}\\{[^}]*\\} (\\d+)$`, "gm"))].reduce(
          (n, m) => n + Number(m[1]),
          0,
        );
      assert.equal(sum("deckhand_runs_started_total"), 1, text);
      assert.equal(sum("deckhand_runs_finished_total"), 2, text);
      assert.match(text, /^deckhand_runs_finished_total\{mode="work",outcome="ok"\} 2$/m);
      assert.match(text, /^deckhand_runs_running 0$/m);
      assert.ok(sum("deckhand_service_calls_total") > 0, text);
      assert.match(text, /^deckhand_service_calls_total\{callee="github",status="200"\} \d+$/m);
      // The copy that stopped could no longer act, had it gone on.
      await staleEverywhere(ctx, epoch);
      // The dashboard's history, from the store alone (#618): the same after another handover.
      const api = await dashboardApi(ctx.port);
      const history = async () =>
        (await api("/api/state")).tasks.flatMap((task) => task.runs.map((r) => [r.id, r.status]));
      const before = await history();
      assert.equal(before.length, 2);
      await ctx.handOver({ signal });
      assert.deepEqual(await history(), before);
      assert.deepEqual(
        readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".json")),
        [],
      );
    });
  }

  test("a listener killed mid-run: Claude answers meanwhile, the next one replies once", async (t) => {
    const ctx = await holding(t);
    const { dir, github } = ctx;
    // Claude answers while no listener is there: the sandbox waits for its inbox to close.
    const killed = ctx.listener.child;
    killed.kill("SIGKILL");
    await new Promise((resolve) => killed.on("exit", resolve));
    writeFileSync(join(dir, "go"), "");
    const [name] = readdirSync(join(dir, "containers"));
    const out = join(dir, "containers", name, "out");
    await until(() => exists(out)?.includes('"type":"result"'), "Claude's answer");
    await ctx.restart();
    await ctx.listener.until("done (ok)");
    await settled(github, [99]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^All done\./);
    // Its log on the dashboard holds Claude's answer once.
    const results = (await onlyLog(dir)).match(/"type":"result"/g);
    assert.equal(results.length, 1);
  });

  test(
    "a listener killed during a comment's pause: the next one runs it once, at its deadline",
    { timeout: 120_000 },
    async (t) => {
      // Long enough for a slow engine to kill the first listener within it.
      const PAUSE_MS = 8000;
      const ctx = await listen(t, {}, { DEBOUNCE_MS: String(PAUSE_MS) });
      const sent = Date.now();
      await ctx.send(comment("alice"));
      await ctx.listener.until("queued (work");
      await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/99/reactions");
      // Its 👀's id saved once GitHub answered (a listener killed before can't know it).
      const state = join(ctx.dir, "store", "state.json");
      await until(() => /"eyes": ?1\b/.test(exists(state) ?? ""), "the 👀 in the saved queue");
      // No SIGTERM: nothing is saved on the way out. The next one's own pause is a minute, and
      // the comment's deadline still holds.
      await ctx.restart({ signal: "SIGKILL", DEBOUNCE_MS: "60000" });
      const line = await ctx.listener.until(
        /1 comment\(s\) queued before the restart, due in \d+ ms/,
      );
      assert.ok(Number(line.match(/due in (\d+) ms/)[1]) <= PAUSE_MS);
      await ctx.listener.until("done (ok)");
      assert.ok(Date.now() - sent >= PAUSE_MS);
      // Not after a pause of the next listener's own (a minute).
      assert.ok(Date.now() - sent < 30_000);
      assert.equal(prompts(ctx.dir).length, 1);
      assert.equal(replies(ctx.github).length, 1);
      // Its 👀 from before the restart is replaced by the outcome.
      await ctx.github.waitFor(
        (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/comments/99/reactions/1",
      );
      assert.deepEqual(leftovers(ctx.dir), []);
    },
  );

  test("a comment queued before a restart doesn't run once its author left ALLOWED_USERS", async (t) => {
    const ctx = await listen(t, {}, { DEBOUNCE_MS: "60000" });
    await ctx.send(comment("alice"));
    await ctx.listener.until("queued (work");
    await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/99/reactions");
    // Stopped first, to see what it leaves: the queue, the owner's only.
    const { child } = ctx.listener;
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    assert.equal(statSync(join(ctx.dir, "store", "state.json")).mode & 0o777, 0o600);
    await ctx.restart({ DEBOUNCE_MS: "0", ALLOWED_USERS: "bob" });
    await ctx.listener.until("dropped: alice is no longer an allowed user");
    // Its 👀 goes, and nothing runs.
    await ctx.github.waitFor(
      (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/comments/99/reactions/1",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(ctx.dir, "run-args")), null);
    assert.equal(replies(ctx.github).length, 0);
  });

  test("a comment whose author leaves the repo's users while it waits doesn't run", async (t) => {
    const files = { ".deckhand.yaml": "users: [alice, bob]\n" };
    const ctx = await listen(t, files, { DEBOUNCE_MS: "300" });
    await ctx.send(comment("alice"));
    await ctx.listener.until("queued (work");
    files[".deckhand.yaml"] = "users: [bob]\n";
    await ctx.listener.until("a queued comment dropped: alice is no longer an allowed user");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(ctx.dir, "run-args")), null);
    // The queue goes on: bob's comment runs.
    await ctx.send({
      ...comment("bob"),
      comment: { id: 100, body: "Deckhand", user: { login: "bob", type: "User" } },
    });
    await ctx.listener.until("done (ok)");
  });

  test("a comment on a pull request saying Closes #3 joins #3 only from a branch of the repo", async (t) => {
    const { github, send, listener } = await listen(t);
    const onPull = (number, id) => {
      const payload = comment("alice");
      // Opened by someone else than the App: its head is looked up.
      payload.issue = {
        number,
        body: "Closes #3",
        pull_request: {},
        user: { login: "github-actions[bot]", type: "Bot" },
        author_association: "NONE",
      };
      payload.comment = { ...payload.comment, id };
      return payload;
    };
    await send(onPull(42, 101));
    await listener.until("org/repo#3: queued");
    await listener.until("done (ok)");
    await send(onPull(43, 102));
    await listener.until("org/repo#pr-43: queued");
    assert.match(listener.output(), /org\/repo#pr-43: says it closes #3, not linked/);
    await listener.until(/org\/repo#pr-43: done \(ok\)/);
    assert.ok(github.requests.some((r) => r.path === "/repos/org/repo/pulls/43"));
  });

  test("a restart after Claude answered once: nothing is read twice", async (t) => {
    const ctx = await holding(t);
    const { dir, github, send } = ctx;
    writeFileSync(join(dir, "hold-answer"), "");
    await send(followUp(100, "Also cover the edge case"));
    const [run] = readdirSync(join(dir, "runs"));
    const inbox = join(dir, "runs", run, "inbox.jsonl");
    await until(() => exists(inbox)?.includes("Also cover the edge case"), "the delivery");
    writeFileSync(join(dir, "go"), "");
    // Claude answered the prompt and reads the comment: the listener restarts meanwhile.
    await until(() => exists(join(dir, "delivered")), "Claude reading the comment");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    writeFileSync(join(dir, "answer"), "");
    await ctx.listener.until("done (ok)");
    await settled(github, [99, 100]);
    assert.equal(replies(github).length, 1);
    assert.match(JSON.parse(replies(github)[0].body).body, /^Answered\./);
    // Both answers once each in the run's log, and the duration of both in the footer.
    const text = await onlyLog(dir);
    assert.equal(text.match(/"type":"result"/g).length, 2);
    assert.equal(text.match(/pull\/13/g).length, 1);
    // Its phases: setup right after its first line, then each once, the restart in between.
    const lines = text.trim().split("\n");
    assert.match(lines[1], /"event":"phase","at":\d+,"phase":"setup"/);
    const phases = lines.filter((l) => l.includes('"event":"phase"'));
    assert.deepEqual(
      phases.map((l) => JSON.parse(l).phase),
      ["setup", "work", "wrap-up"],
    );
    assert.match(JSON.parse(replies(github)[0].body).body, / · 1\.1 min/);
  });

  test("CI deliveries: the CI of the pull request at that commit read, not holding the deliveries after them, kept for the dashboard; nothing logged for check_suite and status", async (t) => {
    const statuses = JSON.stringify({
      statuses: [{ context: "ci/jenkins", state: "failure", target_url: "https://ci/1" }],
    });
    const { dir, github, send, listener } = await listen(t, { statuses });
    const ci = {
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      sender: { login: "ci-bot[bot]", type: "Bot" },
    };
    const head = { ref: "issue-30-fix", sha: "abc", repo: { full_name: "org/repo" } };
    const pull_request = {
      number: 31,
      html_url: "https://github.com/org/repo/pull/31",
      body: "Closes #30",
      state: "open",
      draft: false,
      head,
    };
    // Its CI read held back: the deliveries after it are handled meanwhile.
    const statusRead = (r) => r.path.startsWith("/repos/org/repo/commits/abc/status?");
    const release = github.hold(statusRead);
    t.after(release);
    const calls = github.requests.length;
    await send({ ...ci, action: "synchronize", pull_request }, "pull_request");
    await listener.until("org/repo#30: pull request #31 ready");
    await github.waitFor(statusRead);
    // Another commit's: nothing read. The same status twice: kept out of the memory of handled
    // deliveries, so not "already handled" either; while the first waits, edge passes on no
    // other for that commit.
    for (const [payload, event, id] of [
      [{ ...ci, state: "pending", context: "ci/jenkins", sha: "old" }, "status", "s-0"],
      [{ ...ci, state: "failure", context: "ci/jenkins", sha: "abc" }, "status", "s-1"],
      [{ ...ci, state: "failure", context: "ci/jenkins", sha: "abc" }, "status", "s-1"],
      [{ ...ci, action: "completed", check_suite: { head_sha: "abc" } }, "check_suite", "c-1"],
    ]) {
      assert.equal((await send(payload, event, id)).status, 202, event);
    }
    await send({ ...ci, action: "opened", issue: { number: 3, labels: [] } }, "issues");
    await listener.until("Delivery: issues opened");
    release();
    await listener.until("org/repo#30: CI of #31 failed");
    const kept = (await storedMap(dir, "pulls"))["org/repo#30"];
    assert.deepEqual(kept.ci, {
      sha: "abc",
      state: "failed",
      runs: [{ name: "ci/jenkins", state: "failed", url: "https://ci/1" }],
    });
    const read = github.requests.slice(calls).map((r) => r.path);
    assert.ok(
      read.some((p) => p.startsWith("/repos/org/repo/commits/abc/status?")),
      read.join("\n"),
    );
    assert.ok(!read.some((p) => p.includes("old")), read.join("\n"));
    // They came before the issue's delivery, and logged nothing.
    assert.doesNotMatch(
      listener.output(),
      /Delivery: (?:status|check_suite)|Passed on: (?:status|check_suite)|Delivery (?:s|c)-1 again/,
    );
    // An Actions run going on that head: its CI read again, Actions runs first among them.
    const since = github.requests.length;
    const workflow_run = { id: 9, name: "CI", head_sha: "abc", status: "in_progress" };
    await send({ ...ci, action: "in_progress", workflow_run }, "workflow_run", "w-1");
    await github.waitFor(
      (r) =>
        github.requests.indexOf(r) >= since &&
        r.path.startsWith("/repos/org/repo/actions/runs?head_sha=abc&"),
    );
  });

  // A comment on issue 12, labelled for the open questions in its body.
  function onAsking(id, body, labelled = true) {
    const payload = followUp(id, body);
    payload.issue = {
      number: 12,
      title: "An idea",
      state: "open",
      body: "Do it.\n\n## Open questions\n\n1. Which one?",
      labels: labelled ? [{ name: "needs-input" }] : [],
    };
    return payload;
  }

  const unlabelled = (github) =>
    github.requests.some(
      (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/12/labels/needs-input",
    );

  test("wait_for_answers: a trigger line alone starts nothing on an issue with open questions; an answer does", async (t) => {
    const { dir, github, send, listener } = await listen(t, {});
    await send(onAsking(99, "Deckhand\n/effort high"));
    await until(() => replies(github).length === 1, "the reply");
    const text = JSON.parse(replies(github)[0].body).body;
    assert.match(text, /^#12 has open questions: nothing starts until they are answered\./);
    assert.match(text, /\(https:\/\/hooks\.example\.com\/#\/org\/repo\?task=org%2Frepo%2312\)/);
    const reaction = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/comments/99/reactions",
    );
    assert.deepEqual(JSON.parse(reaction.body), { content: "confused" });
    await listener.until("org/repo#12: alice's comment answers nothing, the label stays");
    // A brainstorm still runs, and leaves the label on.
    await send(onAsking(100, "Deckhand /mode brainstorm"));
    await until(() => replies(github).length === 2, "the brainstorm's reply");
    assert.match(lastRun(dir), /^brainstorm/);
    assert.equal(unlabelled(github), false);
    rmSync(join(dir, "run-args"));
    // Text is the answer: the label comes off and work starts.
    await send(onAsking(101, "Deckhand\n1. The first one"));
    await until(() => exists(join(dir, "run-args")), "the work run");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MESSAGE=1\. The first one$/m);
    await until(() => unlabelled(github), "the label off");
    // Taken off twice: by the answer (questions.mjs), then by the work run's start (runs.mjs).
    await until(
      () =>
        github.requests.filter(
          (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/12/labels/needs-input",
        ).length === 2,
      "the answer's and the work run's label off",
    );
    // The bare trigger never reached Claude.
    assert.doesNotMatch(readFileSync(join(dir, "run-env"), "utf8"), /^SANDBOX_EFFORT=high$/m);
  });

  const tickedBody = (box) =>
    `## Open questions\n\n1. Which one?\n   - [${box}] This one\n   - [ ] That one`;

  test("wait_for_answers: ticking every box of the issue takes the label off and starts what waited", async (t) => {
    const asking = (box) =>
      JSON.stringify({
        number: 12,
        state: "open",
        body: tickedBody(box),
        labels: [{ name: "needs-input" }],
      });
    const files = { "issue:77": JSON.stringify({ state: "open" }), "issue:12": asking(" ") };
    const { dir, github, send, listener } = await listen(t, files);
    await send(onAsking(99, "Deckhand /after #77"));
    await until(() => replies(github).length === 1, "the waiting reply");
    files["issue:77"] = JSON.stringify({ state: "closed", state_reason: "completed" });
    await send(
      {
        action: "closed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: { number: 77, state: "closed", state_reason: "completed" },
        sender: { login: "bob" },
      },
      "issues",
    );
    await until(() => replies(github).length === 2, "the reply that it waits");
    // bob ticks the box in the issue: GitHub has it ticked, the label still on.
    files["issue:12"] = asking("x");
    const edited = {
      action: "edited",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      issue: {
        number: 12,
        title: "An idea",
        state: "open",
        body: tickedBody("x"),
        user: { login: "alice", type: "User" },
        labels: [{ name: "needs-input" }],
      },
      changes: { body: { from: tickedBody(" ") } },
      sender: { login: "bob", type: "User" },
    };
    await send(edited, "issues");
    await until(() => unlabelled(github), "the label off");
    await listener.until("org/repo#12: answered, label removed");
    await until(() => exists(join(dir, "run-args")), "the run");
    await until(() => replies(github).length >= 3, "the starting reply");
    assert.match(
      JSON.parse(replies(github)[2].body).body,
      /^The open questions are answered: starting\./,
    );
    await listener.until("done (ok)");
  });

  test("ticking every box of a run's reply that stopped to ask continues its session", async (t) => {
    const asked = (box) =>
      `<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?\n   - [${box}] A (recommended)\n   - [ ] B`;
    const issue = JSON.stringify({ number: 12, title: "An idea", state: "open" });
    const { dir, github, send, listener } = await listen(t, { "issue:12": issue }, (dir) => {
      writeFileSync(join(dir, "result"), asked(" "));
      return {};
    });
    await send(followUp(99, "Deckhand"));
    await until(() => replies(github).length === 1, "the run's questions");
    await listener.until("done (needs-input)");
    // Its comment's outcome comes once the run is over (runs.mjs cleanUp()): before, the task is
    // still busy, and ticking a box then can't continue it.
    await github.waitFor(
      (r) => r.path === "/repos/org/repo/issues/comments/99/reactions" && /confused/.test(r.body),
    );
    rmSync(join(dir, "result"));
    const posted = JSON.parse(replies(github)[0].body).body;
    // alice ticks A in the App's comment: GitHub's edit, by her, of the bot's comment.
    const edited = (sender) => ({
      action: "edited",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      issue: { number: 12, title: "An idea", state: "open", labels: [{ name: "needs-input" }] },
      comment: {
        id: 500,
        body: posted.replace("[ ] A", "[x] A"),
        user: { login: "deckhand-x[bot]", type: "Bot" },
      },
      changes: { body: { from: posted } },
      sender: { login: sender, type: "User" },
    });
    await send(edited("mallory"));
    await send(edited("alice"));
    await listener.until("org/repo#12: Answers sent: #12 continues.");
    await listener.until("done (ok)");
    const answers = JSON.parse(replies(github)[1].body).body;
    assert.match(
      answers,
      /^Answers from @alice, ticked in the run's questions:\n\n1\. \*\*Name\*\*\n {3}- \[x\] A/,
    );
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MESSAGE=Answers from @alice/m);
    // mallory's edit started nothing: one answer, one run going on.
    await until(() => replies(github).length === 3, "the run's reply");
  });

  test("a comment on the ideas inbox is a light run with the idea prompt, answered there", async (t) => {
    const { dir, github, send } = await listen(t, {
      ".deckhand.yaml": "inbox: { ideas: 12 }\nsetup: npm ci\n",
    });
    const payload = comment("alice", "A dark mode");
    payload.comment.html_url = "https://github.com/org/repo/issues/12#issuecomment-99";
    assert.equal((await send(payload)).status, 202);
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(JSON.parse(reply.body).body, /^All done\./);
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=idea$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    // No branch, no setup, and the entry comes with the prompt of a new session.
    assert.match(runEnv, /^TASK_ISSUE=$/m);
    assert.match(runEnv, /^SANDBOX_SETUP=$/m);
    assert.match(runEnv, /^TASK_MESSAGE=$/m);
    assert.match(runEnv, /^TASK_PROMPT=New on the ideas inbox of org\/repo \(issue #12\)/m);
    assert.match(runEnv, /--label idea/);
    assert.match(
      runEnv,
      /From @alice \(https:\/\/github\.com\/org\/repo\/issues\/12#issuecomment-99\):\n\nA dark mode/,
    );
  });

  // The prompts of the runs so far, in order (the fake sandbox's log).
  const prompts = (dir) => (exists(join(dir, "prompts")) ?? "").split("----\n").slice(0, -1);

  // An entry on the ideas inbox (issue 12): comment `id`, saying `body`.
  function entry(id, body) {
    const payload = followUp(id, body);
    payload.comment.html_url = `https://github.com/org/repo/issues/12#issuecomment-${id}`;
    return payload;
  }

  test(
    "inbox entries queued when the listener stops: a run each after it starts",
    { timeout: 120_000 },
    async (t) => {
      const ctx = await listen(
        t,
        { ".deckhand.yaml": "inbox: { ideas: 12 }\n" },
        // Their pause outlasts the restart, and its deadline holds after it.
        { BRAINSTORM_DEBOUNCE_MS: "8000" },
      );
      await ctx.send(entry(99, "A dark mode"));
      await ctx.send(entry(100, "Keyboard shortcuts"));
      await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/100/reactions");
      const { output } = await ctx.restart({ BRAINSTORM_DEBOUNCE_MS: "0" });
      assert.match(output, /1 task\(s\) with queued comments left to the next copy/);
      await settled(ctx.github, [99, 100]);
      await until(() => prompts(ctx.dir).length === 2, "two runs");
      // Each its own run, side by side: which sandbox starts first is the broker's answers' order.
      const all = prompts(ctx.dir);
      const first = all.find((p) => p.includes("A dark mode"));
      const second = all.find((p) => p.includes("Keyboard shortcuts"));
      assert.match(first, /A dark mode\n$/);
      assert.doesNotMatch(first, /Keyboard shortcuts/);
      assert.match(second, /Keyboard shortcuts\n$/);
      assert.doesNotMatch(second, /A dark mode/);
    },
  );

  function discussion(category, login = "alice") {
    return {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      discussion: {
        id: 5,
        node_id: "D_5",
        number: 8,
        title: "How do restarts work?",
        body: "Is the queue kept?",
        category: { name: category },
        user: { login, type: "User" },
      },
      sender: { login },
    };
  }

  test("a discussion in the repo's category is answered in it, with a discussions token", async (t) => {
    const { dir, github, listener, send } = await listen(t, {
      ".deckhand.yaml": "inbox:\n  discussions: Ask Claude\n",
      // Its author and labels, for the policies' allow_run (run-policy.mjs).
      "graphql:discussion(number: $number) { author": JSON.stringify({
        data: { repository: { discussion: { author: { login: "alice" }, labels: { nodes: [] } } } },
      }),
    });
    await send(discussion("General"), "discussion");
    await listener.until(`category "General" doesn't call Deckhand`);
    assert.equal((await send(discussion("Ask Claude"), "discussion")).status, 202);
    const graphql = (text) => (r) => r.path === "/graphql" && r.body.includes(text);
    const posted = await github.waitFor(graphql("addDiscussionComment"));
    const { variables } = JSON.parse(posted.body);
    assert.equal(variables.id, "D_5");
    // The discussion itself: a top-level comment.
    assert.equal(variables.thread, null);
    assert.match(variables.body, /^All done\.[\s\S]*reply in this discussion to continue/);
    const eyes = await github.waitFor(graphql("addReaction"));
    assert.deepEqual(JSON.parse(eyes.body).variables, { id: "D_5", content: "EYES" });
    // Nothing is posted to an issue of the same number.
    assert.equal(
      github.requests.some((r) => r.path.endsWith("/issues/8/comments")),
      false,
    );
    // Its sandbox's reads: discussions too, read-only, as everything but a write it checked
    // (github-gateway.mjs).
    const mint = github.requests.find((r) => r.body.includes("repositories"));
    assert.equal(JSON.parse(mint.body).permissions.discussions, "read");
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=discussion$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    assert.match(runEnv, /^TASK_PROMPT=New on discussion #8 of org\/repo/m);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(args.includes("deckhand.task=org/repo#discussion-8"));
  });

  // The repo's allow rule for its mode audit: without it, the mode doesn't run.
  const AUDIT_RUNS = 'package deckhand\n\nallow_run if input.mode == "audit"\n';

  const MODES = `setup: npm ci
model: opus
modes:
  audit:
    instructions: .deckhand/audit.md
    model: sonnet
    effort: high
`;
  // What the audit mode gets, as the repo's own modes need its allow rules (capabilities.mjs):
  // what a brainstorm gets, no branch nor setup; and that it runs.
  const AUDIT_POLICY = `${AUDIT_RUNS}
allow_capabilities contains "pull"
allow_capabilities contains "image:repo"
allow_capabilities contains "read:issues"
allow_capabilities contains "read:pulls"
`;

  test("review.on: a ready pull request gets one review run, posted as a GitHub review", async (t) => {
    // Deckhand's own pull request, which closes #12, turns ready.
    const ready = {
      action: "ready_for_review",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      pull_request: {
        number: 13,
        body: "Closes #12",
        state: "open",
        draft: false,
        user: { login: "deckhand-x[bot]", type: "Bot" },
        head: { sha: "head-1", ref: "issue-12-fix", repo: { full_name: "org/repo" } },
      },
      sender: { login: "deckhand-x[bot]", type: "Bot" },
    };
    const { dir, github, listener, send } = await listen(
      t,
      (dir) => ({
        ".deckhand.yaml":
          "brainstorm_model: sonnet\nwait_for_answers: false\nreview:\n  on: ready\n  effort: high\n",
        // A commit pushed while the review runs (its sandbox started: run-args): head-2.
        get "pull:13"() {
          const sha = existsSync(join(dir, "run-args")) ? "head-2" : "head-1";
          return JSON.stringify({
            ...ready.pull_request,
            head: { ...ready.pull_request.head, sha },
            base: { ref: "trunk" },
          });
        },
      }),
      (dir) => {
        writeFileSync(
          join(dir, "result"),
          "Fine overall.\n\n## Findings\n\n- **high** `a.mjs:3`: no test. Fix: add one.\n\nRating: 6/10\nVerdict: request-changes\n",
        );
        return {};
      },
    );
    await send(ready, "pull_request");
    const review = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/pulls/13/reviews",
    );
    const posted = JSON.parse(review.body);
    assert.equal(posted.event, "REQUEST_CHANGES");
    // Posted on the commit the run started from, not the one pushed meanwhile (#535).
    assert.equal(posted.commit_id, "head-1");
    // The model's 6/10, capped by its high finding.
    assert.match(
      posted.body,
      /^\*\*Verdict: request changes\*\* · Rating: 5\/10\n\nFine overall\./,
    );
    assert.match(posted.body, /### 🟠 High \(1\)\n\n- `a\.mjs:3`: no test\. Fix: add one\./);
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=review$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    assert.match(runEnv, /^SANDBOX_MODEL=sonnet$/m);
    assert.match(runEnv, /^SANDBOX_EFFORT=high$/m);
    assert.match(runEnv, /^TASK_PROMPT=Review pull request #13 of org\/repo\./m);
    // Pinned to the commit it is posted on, whatever the head is when the agent reads it.
    assert.match(runEnv, /Review commit `head-1`/);
    assert.match(runEnv, /git diff origin\/trunk\.\.\.head-1/);
    // No auto-merge to decide: medium findings request changes, as the prompt says.
    assert.match(
      runEnv,
      /when there is a\s+blocking comment or a critical, high or medium finding/,
    );
    assert.doesNotMatch(runEnv, /This review tolerates/);
    // Its thread from the listener (reviews.mjs reviewThread(), unit-tested there).
    const args = readFileSync(join(dir, "run-args"), "utf8");
    assert.match(args, /^TASK_DIGEST=http:\/\/[^/]+\/run\/digest$/m);
    for (const path of ["/issues/13/comments?", "/pulls/13/reviews?"]) {
      assert.ok(
        github.requests.some((r) => r.path.startsWith(`/repos/org/repo${path}`)),
        path,
      );
    }
    // Its token only reads: the listener posted the review.
    const mint = github.requests.find((r) => r.body.includes("repositories"));
    assert.equal(JSON.parse(mint.body).permissions.pull_requests, "read");
    // The issue's task, with no comment of its own on the pull request. It answers nothing:
    // the issue's needs-input label stays.
    await listener.until("org/repo#12: done (ok)");
    assert.equal(replies(github).length, 0);
    assert.ok(!github.requests.some((r) => r.method === "DELETE" && r.path.includes("/labels/")));
    // The same head again (a redelivery): no second review.
    await send(ready, "pull_request");
    await listener.until("was reviewed already");
    assert.equal(github.requests.filter((r) => r.path.endsWith("/pulls/13/reviews")).length, 1);
  });

  test("review.merge: a clean review of Deckhand's pull request merges it once its checks pass, with the listener's token", async (t) => {
    const pr = {
      number: 13,
      title: "Fix the thing",
      body: "Closes #12",
      state: "open",
      draft: false,
      labels: [],
      mergeable_state: "clean",
      changed_files: 0,
      html_url: "https://github.com/org/repo/pull/13",
      user: { login: "deckhand-x[bot]", type: "Bot" },
      head: { sha: "head-1", ref: "issue-12-fix", repo: { full_name: "org/repo" } },
      base: { ref: "trunk", repo: { full_name: "org/repo", default_branch: "trunk" } },
    };
    // Another task's pull request, clean when it opened: the merge makes it conflict, and no
    // delivery says so (#747).
    const other = {
      number: 20,
      body: "Closes #18",
      state: "open",
      draft: true,
      labels: [],
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: "head-9", ref: "issue-18-other", repo: { full_name: "org/repo" } },
    };
    // CI still going when the review ends: the merge waits for it. No review.fix: this review
    // decides the merge, and may have medium findings.
    const files = {
      ".deckhand.yaml": "review:\n  on: ready\n  merge: true\n  max_allowed_severity: medium\n",
      "pull:13": JSON.stringify(pr),
      "pull:20": JSON.stringify({ ...other, mergeable: false, mergeable_state: "dirty" }),
      runs: JSON.stringify({
        workflow_runs: [{ name: "CI", status: "in_progress", conclusion: null }],
      }),
    };
    const { dir, github, listener, send } = await listen(t, files, (dir) => {
      // The fake repository says nothing of its visibility: public, so `public`.
      writeGrants(dir, ["auto_merge_public"]);
      writeFileSync(join(dir, "result"), "Fine.\n\nRating: 9/10\nVerdict: approve\n");
      return { CONFLICT_MERGE_DELAY_MS: "0" };
    });
    await listener.until(/WARN policy\/grants\.rego in the grants folder grants auto-merge/);
    await send(
      {
        action: "opened",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        pull_request: other,
        sender: { login: "deckhand-x[bot]", type: "Bot" },
      },
      "pull_request",
    );
    await listener.until("org/repo#18: pull request #20 draft");
    assert.equal((await storedMap(dir, "pulls"))["org/repo#18"].conflict, false);
    await send(
      {
        action: "ready_for_review",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        pull_request: pr,
        sender: { login: "deckhand-x[bot]", type: "Bot" },
      },
      "pull_request",
    );
    await listener.until("org/repo#pr-13: waiting for its checks, 1 GitHub Actions run on head-1");
    assert.ok(!github.requests.some((r) => r.method === "PUT"));
    // The prompt was told the tolerance worked out for the run (reviews' tolerance()).
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /when there is a\s+blocking comment or a critical or high finding/);
    assert.match(runEnv, /This review tolerates medium findings/);
    // The run completes: its delivery decides again.
    files.runs = JSON.stringify({
      workflow_runs: [{ name: "CI", status: "completed", conclusion: "success" }],
    });
    await send(
      {
        action: "completed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        workflow_run: { id: 99, head_sha: "head-1", status: "completed", conclusion: "success" },
        sender: { login: "github-actions[bot]", type: "Bot" },
      },
      "workflow_run",
    );
    const merge = await github.waitFor(
      (r) => r.method === "PUT" && r.path === "/repos/org/repo/pulls/13/merge",
    );
    assert.deepEqual(JSON.parse(merge.body), { sha: "head-1", merge_method: "squash" });
    // The listener's own token, never a sandbox's.
    assert.equal(merge.auth, "Bearer app-token");
    const said = await github.waitFor(
      (r) =>
        r.method === "POST" &&
        r.path === "/repos/org/repo/issues/13/comments" &&
        r.body.includes("Merged by Deckhand"),
    );
    assert.match(JSON.parse(said.body).body, /No human reviewed this pull request/);
    await listener.until("org/repo#pr-13: merged at head-1 (squash), auto-merge");
    // Merged into the default branch: the other one's conflict read again.
    await until(
      async () => (await storedMap(dir, "pulls"))["org/repo#18"].conflict === true,
      "the other pull request's conflict read again",
    );
  });

  test("/mode audit: the repo's mode without `push`, its instructions and model, the repo's grants", async (t) => {
    const { dir, github, listener, send } = await listen(
      t,
      {
        ".deckhand.yaml": MODES,
        ".deckhand/audit.md": "Read the diff and list the risks.",
        // Its own mode runs once it allows it (allow_run, run-policy.mjs).
        "policy:modes.rego": AUDIT_POLICY,
      },
      (dir) => {
        writeGrant(dir, "hosts: [registry.npmjs.org, pypi.org]\n");
        return {};
      },
    );
    await send(comment("alice", "Deckhand\n/mode audit\nMind the tests."));
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(JSON.parse(reply.body).body, /audit mode: replies go on in it, `\/mode work`/);
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=audit$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    assert.match(runEnv, /^TASK_SESSION=$/m);
    assert.match(runEnv, /^SANDBOX_MODEL=sonnet$/m);
    assert.match(runEnv, /^SANDBOX_EFFORT=high$/m);
    // Like a brainstorm: no branch, no setup.
    assert.match(runEnv, /^TASK_ISSUE=$/m);
    assert.match(runEnv, /^SANDBOX_SETUP=$/m);
    assert.match(runEnv, /^TASK_PROMPT=You are in the "audit" mode of this repository/m);
    assert.match(runEnv, /You can't push, create a branch or open a pull request/);
    assert.match(runEnv, /Read the diff and list the risks\./);
    assert.match(runEnv, /^TASK_MESSAGE=Mind the tests\.$/m);
    // Comments only: its token reads, what its capabilities give (no `read:actions` here).
    const mint = github.requests.find((r) => r.body.includes("repositories"));
    assert.deepEqual(JSON.parse(mint.body).permissions, {
      contents: "read",
      issues: "read",
      pull_requests: "read",
      metadata: "read",
    });
    // The same hosts as any run of the repo: the mandatory ones and its grant's.
    assert.deepEqual(allowedHosts(egressAnswers(dir)), [
      "api.anthropic.com",
      "github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
      "registry.npmjs.org",
      "pypi.org",
    ]);
    // A run without `push`, `setup` or `docker` isn't checked for a fork's code
    // (github-forks.mjs): GitHub's file hosts stay
    // plain hosts for it, GitHub's own relayed as for any run.
    const answers = egressAnswers(dir);
    assert.equal(answers["raw.githubusercontent.com"].relay, false);
    assert.equal(answers["github.com"].relay, true);
    // The run's record names the mode.
    const meta = JSON.parse((await onlyLog(dir)).split("\n")[0]);
    assert.equal(meta.taskMode, "audit");
    assert.equal(meta.kind, "issue");
    await listener.until("done (ok)");

    // A comment without a trigger line goes on in the mode; "/mode work" moves to work.
    await send(followUp(100, "And the docs?"));
    await until(() => replies(github).length === 2, "the second reply");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MODE=audit$/m);
    await send(followUp(101, "/mode work\nFix them."));
    await until(() => replies(github).length === 3, "the third reply");
    const work = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(work, /^TASK_MODE=work$/m);
    assert.match(work, /^SANDBOX_LIGHT=$/m);
    assert.match(work, /^SANDBOX_SETUP=npm ci$/m);
    assert.match(work, /^SANDBOX_MODEL=opus$/m);
    assert.match(work, /^TASK_ISSUE=12$/m);
    const mints = github.requests.filter((r) => r.body.includes("repositories"));
    // A work run's reads get a token that only reads, its checked writes one that writes issues
    // (github-gateway.mjs); it pushes through the git gateway and has the listener change its
    // pull requests: its token only reads both.
    assert.equal(JSON.parse(mints.at(-1).body).permissions.issues, "read");
    assert.equal(JSON.parse(mints.at(-1).body).permissions.pull_requests, "read");
    assert.equal(JSON.parse(mints.at(-1).body).permissions.contents, "read");
    assert.deepEqual(await storedMap(dir, "modes"), {});
  });

  test("/mode research: the grant, any public host, no clone or token, the thread in, the reply out", async (t) => {
    const issue = {
      title: "Which queue?",
      body: "Compare BullMQ and pg-boss.",
      user: { login: "alice" },
    };
    const thread = [{ user: { login: "alice" }, body: "Mind the licences." }];
    const { dir, github, listener, send } = await listen(
      t,
      {
        ".deckhand.yaml": "setup: npm ci\ninstructions: AGENTS.md\n",
        "issue:12": JSON.stringify(issue),
        "comments:12": JSON.stringify(thread),
      },
      (dir) => {
        writeGrant(dir, "hosts: [registry.npmjs.org]\n");
        // Held, so its digest is read before the run ends and teardown removes its folder.
        writeFileSync(join(dir, "hold"), "");
        return {};
      },
    );
    // Without the grant: a reply naming it, and no sandbox.
    await send(comment("alice", "Deckhand\n/mode research\nWhich one?"));
    const refused = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(
      JSON.parse(refused.body).body,
      /^Research can't run here: .*don't grant `research`/,
    );
    assert.ok(!exists(join(dir, "run-args")));

    writeGrant(dir, "hosts: [registry.npmjs.org]\n");
    writeGrants(dir, ["research"]);
    await send(followUp(100, "Deckhand\n/mode research\nWhich one?"));
    const egress = join(dir, "egress");
    await until(() => exists(egress)?.trim().split("\n").length === 10, "the sandbox");
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=research$/m);
    assert.match(runEnv, /^SANDBOX_NO_CLONE=1$/m);
    assert.match(runEnv, /^SANDBOX_SETUP=$/m);
    assert.match(runEnv, /^SANDBOX_INSTRUCTIONS=$/m);
    assert.match(runEnv, /^TASK_PROMPT=Research what GitHub issue #12 of org\/repo asks/m);
    assert.match(runEnv, /^TASK_MESSAGE=Which one\?$/m);
    const args = readFileSync(join(dir, "run-args"), "utf8");
    assert.match(args, /-research-workspace:\/workspace/);
    assert.doesNotMatch(args, /screenshots/);
    assert.match(args, /^TASK_DIGEST=http:\/\/[^/]+\/run\/digest$/m);
    // Nothing from GitHub: the gateway refused the sandbox's call, and no token was minted.
    assert.equal(readFileSync(join(dir, "broker-answer"), "utf8"), "");
    assert.equal(github.requests.filter((r) => r.body.includes("repositories")).length, 0);
    // The listener reads the repository's visibility once for its capabilities' input, and once
    // for its author's access (policies.mjs access(), kept ACCESS_MS); the sandbox's call adds
    // none.
    assert.equal(github.requests.filter((r) => r.path === "/repos/org/repo").length, 2);
    // No CA either: GitHub's hosts aren't relayed for it (below).
    assert.doesNotMatch(args, /DECKHAND_CA/);
    // Any public host, the operator's named ones no longer private.
    const answers = egressAnswers(dir);
    assert.deepEqual(answers["evil.example"], {
      allowed: true,
      private: false,
      cache: false,
      decrypt: false,
      relay: false,
      source: "sandbox",
    });
    assert.equal(answers["registry.npmjs.org"].private, false);
    assert.equal(answers["github.com"].private, true);
    // Public GitHub, anonymously, through a tunnel: it has no token for the gateway to add.
    assert.equal(answers["github.com"].allowed, true);
    assert.equal(answers["github.com"].relay, false);
    assert.equal(answers["github.com"].decrypt, false);
    // The thread, in the run's inbox folder.
    const [folder] = readdirSync(join(dir, "runs")).filter((f) =>
      exists(join(dir, "runs", f, "digest.md")),
    );
    const digest = readFileSync(join(dir, "runs", folder, "digest.md"), "utf8");
    assert.match(digest, /^# Which queue\?\n/);
    // The sandbox fetched it from the broker, with its run's secret.
    assert.equal(readFileSync(join(dir, "digest-fetched"), "utf8"), digest);
    assert.match(digest, /Compare BullMQ and pg-boss\./);
    assert.match(digest, /### @alice, .*\n\nMind the licences\./);
    writeFileSync(join(dir, "go"), "");
    await until(() => replies(github).length === 2, "the research reply");
    assert.match(JSON.parse(replies(github)[1].body).body, /🔎 research: replies go on in it/);
    const meta = JSON.parse((await onlyLog(dir)).split("\n")[0]);
    assert.equal(meta.kind, "research");
    await listener.until("done (ok)");
  });

  // The run's mode and whether it is light, from the fake sandbox's last environment.
  function lastRun(dir) {
    const env = readFileSync(join(dir, "run-env"), "utf8");
    return `${/^TASK_MODE=(.*)$/m.exec(env)[1]} ${/^SANDBOX_LIGHT=(.*)$/m.exec(env)[1] || "full"}`;
  }

  test("/after #77: waits, through a restart, and runs the comment once #77 is done", async (t) => {
    const files = { "issue:77": JSON.stringify({ state: "open" }) };
    const { dir, github, send, restart } = await listen(t, files);
    await send(
      comment("alice", "Deckhand /after #77\n/effort high\nDo it on top of the new parser."),
    );
    await until(() => replies(github).length === 1, "the waiting reply");
    assert.match(
      JSON.parse(replies(github)[0].body).body,
      /^Waiting for #77: I'll start when it is done/,
    );
    // 👀 on the comment, and no run yet.
    assert.ok(
      github.requests.some((r) => r.path === "/repos/org/repo/issues/comments/99/reactions"),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(dir, "run-args")), null);
    assert.deepEqual((await storedMap(dir, "waits"))["org/repo#12"].blockers, [77]);

    // #77 is merged while the listener is down: the next one asks GitHub when it starts.
    files["issue:77"] = JSON.stringify({ state: "closed", pull_request: { merged_at: "2026" } });
    await restart();
    await until(() => exists(join(dir, "run-args")), "the run");
    const env = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(env, /^TASK_MESSAGE=Do it on top of the new parser\.$/m);
    assert.match(env, /^SANDBOX_EFFORT=high$/m);
    await until(() => replies(github).length === 3, "the starting reply and the run's");
    assert.match(JSON.parse(replies(github)[1].body).body, /^#77 is done: starting\./);
    assert.deepEqual(await storedMap(dir, "waits"), {});
  });

  // A pull request closed by a merge into `base`, saying "Closes #77", from the repo's branch.
  const mergedPull = (base = "trunk") => ({
    action: "closed",
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    pull_request: {
      number: 90,
      state: "closed",
      merged: true,
      merged_at: "2026-10-15T00:00:00Z",
      body: "Closes #77",
      base: { ref: base },
      head: { ref: "issue-77-parser", repo: { full_name: "org/repo" } },
      html_url: "https://github.com/org/repo/pull/90",
    },
    sender: { login: "bob" },
  });

  test("conflicts: a merge into the default branch checks the open task pull requests soon", async (t) => {
    const conflicted = {
      number: 13,
      state: "open",
      mergeable: false,
      mergeable_state: "dirty",
      labels: [],
      head: { sha: "head-1", ref: "issue-12-fix", repo: { full_name: "org/repo" } },
      base: { ref: "trunk", sha: "old" },
    };
    const files = {
      ".deckhand.yaml": "conflicts:\n  check_minutes: 60\n",
      "pull:13": JSON.stringify(conflicted),
      "ref:trunk": "base-2",
    };
    const { dir, github, send, listener } = await listen(t, files, {
      CONFLICT_MERGE_DELAY_MS: "0",
    });
    // Deckhand's pull request for #12, open.
    await send(
      {
        action: "opened",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        pull_request: { ...conflicted, body: "Closes #12", draft: true },
        sender: { login: "deckhand-x[bot]", type: "Bot" },
      },
      "pull_request",
    );
    await listener.until("org/repo#12: pull request #13 draft");
    // Another one merged into trunk: #13 is asked at once and rebased. Not by the first tick,
    // a minute after start, which would check the repo too: until() gives up after 10 s.
    await send(mergedPull(), "pull_request");
    await until(
      () =>
        github.requests.some((r) => r.method === "GET" && r.path === "/repos/org/repo/pulls/13"),
      "the conflict check",
    );
    await listener.until("org/repo#12: pull request #13 conflicts with trunk");
    await until(() => exists(join(dir, "run-env")), "the rebase run");
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /^TASK_MESSAGE=This pull request conflicts with `trunk`/m,
    );
    await listener.until("done (ok)");
  });

  function installed(sender = "alice", repos = ["org/repo"]) {
    return {
      action: "created",
      installation: { id: 7 },
      repositories: repos.map((full_name) => ({ full_name })),
      sender: { login: sender },
    };
  }

  const onIssue30 = (github) =>
    github.requests.filter(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/30/comments",
    );

  function onIssue30Comment(id, body) {
    const payload = followUp(id, body);
    payload.issue = { number: 30 };
    return payload;
  }

  test("installing the App on a repo without a config: an onboarding issue and conversation, then its pull request", async (t) => {
    const ctx = await listen(
      t,
      {
        // The work run's branch: a config with an error, and the Dockerfile it names is missing.
        "issue-30-deckhand-config:.deckhand.yaml":
          "effort: huge\ndockerfile: .deckhand/Dockerfile\n",
      },
      (dir) => {
        mkdirSync(join(dir, "grants"), { recursive: true });
        writeFileSync(join(dir, "grants", "default.yaml"), "hosts: [registry.npmjs.org]\n");
        return {};
      },
    );
    const { dir, github, listener, send, restart } = ctx;
    assert.equal((await send(installed(), "installation")).status, 202);
    const issue = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues",
    );
    const created = JSON.parse(issue.body);
    assert.equal(created.title, "Set up Deckhand for this repository");
    assert.deepEqual(created.labels, ["deckhand-onboarding"]);
    assert.match(created.body, /^@alice installed Deckhand/);
    assert.ok(github.requests.some((r) => r.path === "/repos/org/repo/labels"));

    // The onboarding run: light, read-only, its prompt with the operator's frame and the reference.
    await until(() => onIssue30(github).length === 1, "the proposal");
    const reply = JSON.parse(onIssue30(github)[0].body).body;
    assert.match(
      reply,
      /onboarding: reply to change the proposal, `Deckhand` opens the pull request/,
    );
    assert.equal(lastRun(dir), "onboarding 1");
    const env = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(env, /^TASK_ISSUE=$/m);
    assert.match(env, /^TASK_PROMPT=Onboard org\/repo with the maintainer, on GitHub issue #30/m);
    assert.match(
      env,
      /Hosts the operator grants this repository \([^)]*\): `registry\.npmjs\.org`/,
    );
    assert.match(env, /Host mount roots granted to this repository: none/);
    assert.match(env, /## Reference: `\.deckhand\.yaml`[\s\S]*# Per-repo config/);
    const mints = () => github.requests.filter((r) => r.body.includes("repositories"));
    assert.equal(JSON.parse(mints().at(-1).body).permissions.contents, "read");
    assert.equal(JSON.parse(mints().at(-1).body).permissions.issues, "read");
    assert.deepEqual((await storedMap(dir, "onboarding"))["org/repo"].issue, 30);
    await listener.until("done (ok)");

    // A comment without a trigger line: the same conversation, nothing pushed.
    await send(onIssue30Comment(100, "Looks good, but run the linter too."));
    await until(() => onIssue30(github).length === 2, "the updated proposal");
    assert.equal(lastRun(dir), "onboarding 1");
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /^TASK_MESSAGE=Looks good, but run the linter too\./m,
    );
    assert.equal(JSON.parse(mints().at(-1).body).permissions.contents, "read");

    // The trigger line: a work run with the onboarding prompt, and the branch's config checked.
    await send(onIssue30Comment(101, "Deckhand"));
    await until(() => onIssue30(github).length === 3, "the pull request reply");
    assert.equal(lastRun(dir), "work full");
    const work = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(work, /^TASK_ISSUE=30$/m);
    assert.match(work, /^TASK_PROMPT=The maintainer confirmed the onboarding proposal/m);
    // Its reads' token: a checked write's alone may write (github-gateway.mjs).
    assert.equal(JSON.parse(mints().at(-1).body).permissions.issues, "read");
    assert.equal(JSON.parse(mints().at(-1).body).permissions.pull_requests, "read");
    const done = JSON.parse(onIssue30(github)[2].body).body;
    assert.match(done, /^All done\./);
    assert.match(done, /`\.deckhand\.yaml` on `issue-30-deckhand-config` has errors/);
    assert.match(done, /- ❌ dockerfile: `\.deckhand\/Dockerfile` is not on the branch/);
    await listener.until("done (ok)");

    // A restart, then the App installed again: already onboarded, no second issue.
    await restart();
    await send(installed(), "installation");
    await ctx.listener.until("already onboarded (#30)");
    assert.equal(github.requests.filter((r) => r.path === "/repos/org/repo/issues").length, 1);
  });

  test("the dashboard shows a repo's tasks and logs to its own users, once they are known", async (t) => {
    const files = { ".deckhand.yaml": "users: [bob]\n" };
    const { dir, port, send, listener } = await listen(t, files, (dir, github) => {
      mkdirSync(join(dir, "logs"));
      const meta = { type: "listener", key: "org/repo#pr-3", repo: "org/repo", startedAt: 1000 };
      writeFileSync(join(dir, "logs", "org-repo-pr-3-1000.log"), `${JSON.stringify(meta)}\n`);
      return { GITHUB_URL: github.url };
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    // alice (the fake GitHub's browser) signs in: she is in ALLOWED_USERS.
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const keys = async () =>
      (await (await get("/api/state", session)).json()).tasks.map((task) => task.key);
    // The repo's users aren't known yet: ALLOWED_USERS decides.
    assert.deepEqual(await keys(), ["org/repo#pr-3"]);
    // Its summary, made from its log, in the store (#618): none left in logs/.
    assert.equal(summary(dir)?.id, "org-repo-pr-3-1000");
    assert.deepEqual(
      readdirSync(join(dir, "logs")).filter((f) => f.endsWith(".json")),
      [],
    );
    const open = await get("/api/runs/org-repo-pr-3-1000/stream", session);
    assert.equal(open.status, 200);
    await open.body.cancel();
    // bob's comment reads the repo's config, whose users leave alice out.
    await send(comment("bob"));
    await listener.until("done (ok)");
    assert.deepEqual(await keys(), []);
    assert.equal((await get("/api/runs/org-repo-pr-3-1000/stream", session)).status, 404);
  });

  test("a log left in logs/ whose run the store summarized isn't summarized again (#697)", async (t) => {
    const id = "org-repo-pr-4-1000";
    const { dir, port, listener } = await listen(t, {}, (dir, github) => {
      mkdirSync(join(dir, "logs"));
      const meta = { type: "listener", key: "org/repo#pr-4", repo: "org/repo", startedAt: 1000 };
      writeFileSync(join(dir, "logs", `${id}.log`), `${JSON.stringify(meta)}\n`);
      // Its summary in the store already, as a start before moved it there (file backend).
      mkdirSync(join(dir, "store", "keys"), { recursive: true });
      const saved = {
        id,
        key: "org/repo#pr-4",
        repo: "org/repo",
        // Recent: older than the history's 90 days, it would be removed.
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now(),
        status: "ok",
        summary: "Kept.",
      };
      writeFileSync(
        join(dir, "store", "keys", fileName(`summaries/${id}`)),
        JSON.stringify({ key: `summaries/${id}`, value: saved }),
      );
      return { GITHUB_URL: github.url };
    });
    await listener.until("Run logs: 1 of 1 sent to the runner");
    // Listed: the start moved logs/' summaries to the store before.
    const api = await dashboardApi(port);
    assert.deepEqual(
      (await api("/api/state")).tasks.map((task) => task.key),
      ["org/repo#pr-4"],
    );
    // Not read again: a summary made from it would be moved (and discarded by setIfAbsent()).
    assert.doesNotMatch(listener.own(), /Run summaries: \d+ moved/);
    assert.equal(summary(dir)?.summary, "Kept.");
    assert.deepEqual(readdirSync(join(dir, "logs")), []);
  });

  test("access (#731): a login with no action sees nothing, starts nothing, its routes 404 and 403", async (t) => {
    // The operator's access.rego replaces Deckhand's: decided by the policy service, whose opa
    // gives bob everything and alice nothing (not even server-wide).
    const opa = fakeOpa({ accessFor: (doc) => (doc.user.login === "bob" ? ["*"] : []) });
    const { dir, port, send, listener } = await listen(
      t,
      undefined,
      (dir, github) => {
        mkdirSync(join(dir, "grants", "policy"), { recursive: true });
        writeFileSync(
          join(dir, "grants", "policy", "access.rego"),
          'package deckhand\n\nbindings := [{"users": ["bob"], "repos": ["*/*"], "role": "operator"}]\n',
        );
        return { GITHUB_URL: github.url };
      },
      { opa },
    );
    // alice is in ALLOWED_USERS, but has no action here: no run, and nothing said.
    await send(comment("alice"));
    await listener.until("org/repo#12: alice has no action here");
    assert.equal(exists(join(dir, "run-env")), null);
    // bob's comment runs.
    await send(comment("bob"));
    await listener.until("done (ok)");
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie, init = {}) =>
      fetch(base + path, { redirect: "manual", ...init, headers: { cookie, ...init.headers } });
    // alice (the fake GitHub's browser) signs in.
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const seen = await (await get("/api/state", session)).json();
    assert.deepEqual(seen.tasks, []);
    assert.deepEqual(seen.inboxes, {});
    // Totals stay: numbers without names.
    assert.equal(typeof seen.maxParallel, "number");
    const run = summary(dir)?.id;
    assert.match(run, /-org-repo-12-/);
    assert.equal((await get(`/api/runs/${run}/stream`, session)).status, 404);
    assert.equal((await get("/api/repos/org/repo/issues", session)).status, 404);
    const listed = await (await get("/api/repos", session)).json();
    assert.deepEqual(listed.repos, []);
    for (const path of ["/api/server", "/api/health"]) {
      assert.equal((await get(path, session)).status, 403, path);
    }
    const sync = await get("/api/sync", session, {
      method: "POST",
      headers: { origin: "https://hooks.example.com" },
    });
    assert.equal(sync.status, 403);
    const status = await get("/status", session, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.doesNotMatch((await status.json()).reasons.join("\n"), /org\/repo/);
  });

  test("the permissions the App and its installations lack: warned at start, and on api/repos", async (t) => {
    const installation = {
      id: 7,
      account: { login: "org" },
      html_url: "https://github.com/organizations/org/settings/installations/7",
      permissions: { ...APP_PERMISSIONS, actions: undefined, discussions: undefined },
    };
    const { port, listener } = await listen(
      t,
      {
        app: JSON.stringify({
          slug: "deckhand",
          owner: { login: "org", type: "Organization" },
          events: APP_EVENTS,
          permissions: { ...APP_PERMISSIONS, discussions: undefined },
        }),
        installations: JSON.stringify([installation]),
      },
      (dir, github) => ({ GITHUB_URL: github.url }),
    );
    await listener.until("lacks the permission discussions: write");
    // Listed at start, before anyone opens the dashboard.
    const start = `installation on org lacks actions: write: an owner of the account accepts the new permissions on ${installation.html_url}`;
    await listener.until(start);
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const { app } = await (await get("/api/repos", session)).json();
    // Logged once: read again with the listing, neither warning is new.
    const out = listener.output();
    assert.equal(out.split("lacks the permission discussions: write").length, 2);
    assert.equal(out.split(start).length, 2);
    assert.deepEqual(app.missingEvents, []);
    assert.deepEqual(app.missingPermissions, ["discussions: write"]);
    // What the App lacks is said for the App alone.
    assert.deepEqual(app.installations, [
      { account: "org", url: installation.html_url, missing: ["actions: write"] },
    ]);
  });

  test("auto-pickup: an opted-in repo's labelled issue starts by itself, for whoever added the label", async (t) => {
    const repo = { full_name: "org/repo", html_url: "https://github.com/org/repo" };
    const labelled = {
      number: 12,
      title: "Left in the backlog",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
      labels: [{ name: "auto-pickup" }],
      issue_dependencies_summary: { total_blocked_by: 0 },
    };
    const { github, listener } = await listen(
      t,
      {
        ".deckhand.yaml": "auto_pickup: true\n",
        installed: JSON.stringify({ repositories: [{ ...repo, default_branch: "trunk" }] }),
        backlog: JSON.stringify([labelled]),
        "events:12": JSON.stringify([
          {
            event: "labeled",
            label: { name: "auto-pickup" },
            actor: { login: "bob", type: "User" },
          },
        ]),
        // Its description never edited since.
        "graphql:userContentEdits": JSON.stringify({
          data: {
            repository: {
              issue: { userContentEdits: { pageInfo: { hasPreviousPage: false }, nodes: [] } },
            },
          },
        }),
      },
      { MAX_PARALLEL: "2", AUTO_PICKUP_SLOTS: "1" },
    );
    // The App's comment, then the label off, then the run, as the dashboard's start queues it.
    const removed = await github.waitFor(
      (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/12/labels/auto-pickup",
    );
    const posted = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.ok(github.requests.indexOf(posted) < github.requests.indexOf(removed));
    assert.match(JSON.parse(posted.body).body, /^Picked automatically: .* added by @bob/);
    await listener.until("org/repo#12: queued (work, issue 12, reply on #12)");
    await listener.until("Auto-pickup: org/repo#12: started (label added by bob)");
  });

  test("Work area plan: a parent's sub-issues start or wait from their links, the parent last", async (t) => {
    const repository_url = "https://api.github.com/repos/org/repo";
    const subs = [11, 12].map((number) => ({
      number,
      title: `Sub ${number}`,
      state: "open",
      repository_url,
    }));
    const { dir, github, port } = await listen(
      t,
      {
        "issue:10": JSON.stringify({ number: 10, title: "Epic", state: "open" }),
        "subs:10": JSON.stringify(subs),
        "blocked:11": JSON.stringify([{ number: 12, state: "open", repository_url }]),
        "parent:10": JSON.stringify({ number: 3, title: "Roadmap", repository_url }),
      },
      (dir, github) => {
        writeFileSync(join(dir, "hold"), "");
        return { GITHUB_URL: github.url };
      },
    );
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const res = await fetch(`${base}/api/repos/org/repo/work`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://hooks.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "plan", number: 10 }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).message,
      "#10 laid out: #12 starts; #10 waits for #11 and #12; #11 waits for #12.",
    );
    const waits = await storedMap(dir, "waits");
    assert.deepEqual(waits["org/repo#10"].blockers, [11, 12]);
    assert.deepEqual(waits["org/repo#11"].blockers, [12]);
    const posted = github.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/comments"),
    );
    assert.deepEqual(
      posted.map((r) => r.path),
      [10, 11, 12].map((n) => `/repos/org/repo/issues/${n}/comments`),
    );
    await until(() => exists(join(dir, "run-env")), "#12's run");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_ISSUE=12$/m);
    // Their lane is the parent's, until a maintainer names it otherwise.
    const named = await fetch(`${base}/api/repos/org/repo/lane`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://hooks.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ keys: ["org/repo#11"], name: "Budgets" }),
    });
    assert.equal(named.status, 200);
    const lanes = async () => (await (await get("/api/state", session)).json()).lanes;
    // The parent's title comes with a later poll.
    let now = await lanes();
    for (let i = 0; i < 200 && now["org/repo#10"]?.name !== "Epic"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      now = await lanes();
    }
    assert.deepEqual(now["org/repo#10"], { name: "Epic", source: "parent" });
    assert.equal(now["org/repo#11"].name, "Budgets");
    assert.equal(now["org/repo#11"].source, "user");
    // GitHub's parents are asked for the board's issues too; the plan's wins.
    const read = () => storedMap(dir, "lanes");
    let kept = await read();
    for (let i = 0; i < 200 && !kept["org/repo#12"]?.parentAt; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      kept = await read();
    }
    assert.deepEqual(kept["org/repo#10"].parent, { key: "org/repo#3", title: "Roadmap" });
    assert.equal(kept["org/repo#12"].parent, undefined);
    writeFileSync(join(dir, "go"), "");
  });

  test("Analyze: a new issue, and a light run that reads a digest of the repo's runs only", async (t) => {
    const secret = "sk-ant-api03-0123456789abcdef";
    const { dir, github, port, listener } = await listen(t, {}, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      mkdirSync(join(dir, "logs"));
      const log = (id, repo, text) =>
        writeFileSync(
          join(dir, "logs", `${id}.log`),
          [
            { type: "listener", key: `${repo}#5`, repo, taskMode: "work", startedAt: 1000 },
            { type: "listener", event: "note", at: 1, message: "Image deckhand-private-note" },
            {
              type: "assistant",
              message: {
                content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }],
              },
            },
            {
              type: "user",
              message: {
                content: [{ type: "tool_result", content: "private output", is_error: true }],
              },
            },
            { type: "result", is_error: true, result: text, duration_ms: 6000 },
          ]
            .map((l) => JSON.stringify(l))
            .join("\n") + "\n",
        );
      log("org-repo-5-1000", "org/repo", `The tests fail with ${secret}.`);
      log("org-other-5-1000", "org/other", "Another repo's failure.");
      return { ANTHROPIC_API_KEY: secret, GITHUB_URL: github.url };
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const preview = await (
      await get("/api/repos/org/repo/analyze?count=10&kinds=work&outcomes=error", session)
    ).json();
    assert.deepEqual(preview.runs, ["org-repo-5-1000"]);
    const res = await fetch(`${base}/api/repos/org/repo/analyze`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://hooks.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ count: 10, kinds: ["work"], outcomes: ["error"] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).task, "org/repo#30");
    const created = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues",
    );
    assert.deepEqual(JSON.parse(created.body).labels, ["analysis"]);
    await until(() => exists(join(dir, "run-args")), "the run");
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=analyze$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    assert.match(runEnv, /^TASK_SESSION=fresh$/m);
    assert.match(
      runEnv,
      /^TASK_PROMPT=Analyze recent Deckhand runs of org\/repo, on GitHub issue #30/m,
    );
    assert.match(
      readFileSync(join(dir, "run-args"), "utf8"),
      /^TASK_DIGEST=http:\/\/[^/]+\/run\/digest$/m,
    );
    // In the run's inbox folder: this repo's run, redacted; not the other repo's.
    const [folder] = readdirSync(join(dir, "runs")).filter((f) =>
      exists(join(dir, "runs", f, "digest.md")),
    );
    const digest = readFileSync(join(dir, "runs", folder, "digest.md"), "utf8");
    assert.match(digest, /## Run org-repo-5-1000/);
    assert.match(digest, /The tests fail with \[redacted\]\./);
    assert.ok(!digest.includes(secret));
    assert.doesNotMatch(digest, /org-other|Another repo/);
    // A public repo (GitHub doesn't say it is private): what only the dashboard showed stays
    // out, the failed call itself stays.
    assert.doesNotMatch(digest, /private-note|private output|Listener notes/);
    assert.match(digest, /Bash: make\n→\n\(output left out: public repository\)/);
    writeFileSync(join(dir, "go"), "");
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/30/comments",
    );
    assert.match(JSON.parse(reply.body).body, /^All done\./);
    await listener.until("done (ok)");
  });

  test("api/state: a run's questions stop waiting once its issue closes, its pull request merges, or a pull request's label comes off", async (t) => {
    const asked =
      "<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?\n   - [ ] A";
    const { dir, port, send, listener } = await listen(t, {}, (dir, github) => {
      mkdirSync(join(dir, "logs"));
      for (const [id, key] of [
        ["org-repo-5-1000", "org/repo#5"],
        ["org-repo-pr-6-1000", "org/repo#pr-6"],
        ["org-repo-9-1000", "org/repo#9"],
        ["org-repo-12-1000", "org/repo#12"],
        ["org-repo-13-1000", "org/repo#13"],
      ]) {
        writeFileSync(
          join(dir, "logs", `${id}.log`),
          [
            // #5 and #9 auto-picked: their close ends the pick (picks.json).
            {
              type: "listener",
              key,
              repo: "org/repo",
              taskMode: "work",
              startedAt: 1000,
              ...(["org/repo#5", "org/repo#9"].includes(key) && { autoPickup: true }),
            },
            { type: "result", result: asked, duration_ms: 6000 },
          ]
            .map((l) => JSON.stringify(l))
            .join("\n") + "\n",
        );
      }
      return { GITHUB_URL: github.url };
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const states = async () =>
      Object.fromEntries(
        (await (await get("/api/state", session)).json()).tasks.map((x) => [x.key, x.state]),
      );
    assert.deepEqual(await states(), {
      "org/repo#5": "needs-input",
      "org/repo#pr-6": "needs-input",
      "org/repo#9": "needs-input",
      "org/repo#12": "needs-input",
      "org/repo#13": "needs-input",
    });
    const repository = { full_name: "org/repo", default_branch: "main" };
    const installation = { id: 7 };
    const sender = { login: "bob", type: "User" };
    // Issue #5 closed, the label taken off pull request #6, and pull request #19, which closes
    // #9, merged with #9 left open.
    const closed = { number: 5, title: "An idea", state: "closed", state_reason: "completed" };
    await send({ action: "closed", installation, repository, sender, issue: closed }, "issues");
    const merged = {
      number: 19,
      title: "Nine",
      state: "closed",
      merged: true,
      // After the runs asked (their logs' time): a close from before says nothing of them.
      merged_at: new Date(Date.now() + 60_000).toISOString(),
      body: "Closes #9",
      html_url: "https://github.com/org/repo/pull/19",
      head: { ref: "issue-9-nine", repo: { full_name: "org/repo" } },
    };
    await send(
      { action: "closed", installation, repository, sender, pull_request: merged },
      "pull_request",
    );
    await listener.until("org/repo#9: closed, its last run's questions set aside");
    assert.deepEqual(await storedMap(dir, "picks"), {
      "org/repo#5": "org-repo-5-1000",
      "org/repo#9": "org-repo-9-1000",
    });
    // Pull request #22, which would close #12, closed without merging: #12 still asks. Issue
    // #13's `closed`, redelivered from before its run asked: #13 still asks.
    await send(
      {
        action: "closed",
        installation,
        repository,
        sender,
        pull_request: {
          ...merged,
          number: 22,
          merged: false,
          merged_at: null,
          closed_at: new Date(Date.now() + 60_000).toISOString(),
          body: "Closes #12",
        },
      },
      "pull_request",
    );
    const stale = { number: 13, state: "closed", closed_at: "2000-01-01T00:00:00Z" };
    await send({ action: "closed", installation, repository, sender, issue: stale }, "issues");
    const pull = { number: 6, title: "A change", state: "open", labels: [] };
    const label = { name: "needs-input" };
    await send(
      { action: "unlabeled", installation, repository, sender, pull_request: pull, label },
      "pull_request",
    );
    await listener.until("org/repo#pr-6: label removed, its last run's questions set aside");
    assert.deepEqual(Object.keys(await storedMap(dir, "dismissed")).sort(), [
      "org/repo#5",
      "org/repo#9",
      "org/repo#pr-6",
    ]);
    assert.deepEqual(await states(), {
      "org/repo#5": "done",
      "org/repo#pr-6": "done",
      "org/repo#9": "done",
      "org/repo#12": "needs-input",
      "org/repo#13": "needs-input",
    });
    // The label put back on #6: its questions ask again.
    await send(
      { action: "labeled", installation, repository, sender, pull_request: pull, label },
      "pull_request",
    );
    await listener.until("org/repo#pr-6: label put back, its last run's questions wait again");
    assert.equal((await states())["org/repo#pr-6"], "needs-input");
  });

  test("at start: an issue closed, or unlabelled, while no listener heard it sets its run's questions aside", async (t) => {
    const asked =
      "<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?\n   - [ ] A";
    const files = {};
    const { dir, port, listener, send } = await listen(t, files, (dir, github) => {
      mkdirSync(join(dir, "logs"));
      for (const n of [5, 8, 11, 14]) {
        writeFileSync(
          join(dir, "logs", `org-repo-${n}-1000.log`),
          [
            {
              type: "listener",
              key: `org/repo#${n}`,
              repo: "org/repo",
              taskMode: "work",
              startedAt: 1000,
            },
            { type: "result", result: asked, duration_ms: 6000 },
          ]
            .map((l) => JSON.stringify(l))
            .join("\n") + "\n",
        );
      }
      // Both known closed. #5 closed after its run asked; #8 before (a comment on a closed issue
      // started its run), so its questions still wait.
      writeFileSync(
        join(dir, "closed.json"),
        JSON.stringify({ "org/repo#5": "completed", "org/repo#8": "completed" }),
      );
      const closedAt = (ms) => ({
        state: "closed",
        state_reason: "completed",
        closed_at: new Date(ms).toISOString(),
      });
      files["issue:5"] = JSON.stringify({
        number: 5,
        title: "Five",
        ...closedAt(Date.now() + 60_000),
      });
      files["issue:8"] = JSON.stringify({
        number: 8,
        title: "Eight",
        ...closedAt(Date.now() - 3_600_000),
      });
      // #11 was labelled when the listener last heard of it; the label's listing no longer has
      // it (inputs.mjs sync()).
      // #14 too, but GitHub still has it labelled: the listing missed it. #16 as well, with
      // questions in its body and no run.
      writeFileSync(
        join(dir, "inputs.json"),
        JSON.stringify({
          "org/repo#11": { since: 1000, questions: null, ignoredTicks: true },
          "org/repo#14": { since: 1000, questions: null },
          "org/repo#16": { since: 2000, questions: null },
        }),
      );
      const after = new Date(Date.now() + 60_000).toISOString();
      files["issue:11"] = JSON.stringify({
        number: 11,
        state: "open",
        labels: [],
        updated_at: after,
      });
      files["issue:14"] = JSON.stringify({
        number: 14,
        state: "open",
        labels: [{ name: "needs-input" }],
        body: "## Open questions\n\n1. **Name**: which one?\n   - [ ] A",
        updated_at: after,
      });
      files["issue:16"] = JSON.stringify({
        number: 16,
        state: "open",
        labels: [{ name: "needs-input" }],
        body: "## Open questions\n\n1. **Size**: how big?\n   - [ ] Small\n2. Why?",
        updated_at: after,
      });
      files.installed = JSON.stringify({
        repositories: [{ full_name: "org/repo", default_branch: "main" }],
      });
      files.labelled = "[]";
      return { GITHUB_URL: github.url };
    });
    await listener.until("Closed since their run asked: org/repo#5");
    await listener.until(
      "org/repo#11: label removed meanwhile, its last run's questions set aside",
    );
    await listener.until("org/repo#14: still labelled, though the label's listing missed it");
    await listener.until("org/repo#16: still labelled, though the label's listing missed it");
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const { tasks } = await (await get("/api/state", session)).json();
    assert.deepEqual(Object.fromEntries(tasks.map((x) => [x.key, x.state])), {
      "org/repo#5": "done",
      "org/repo#8": "needs-input",
      "org/repo#11": "done",
      "org/repo#14": "needs-input",
      "org/repo#16": "needs-input",
    });
    // #14 and #16 still wait for input, since when they did, with their questions as their
    // bodies have them.
    const inputs = await storedMap(dir, "inputs");
    assert.deepEqual(
      Object.entries(inputs).map(([key, i]) => [key, i.since, i.questions?.items?.length]),
      [
        ["org/repo#14", 1000, 1],
        ["org/repo#16", 2000, 2],
      ],
    );
    // #11's label put back later: a new entry, not the one dropped at start (its time, the
    // ticks it ignored).
    const before = Date.now();
    await send(
      {
        action: "labeled",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "main" },
        issue: { number: 11, title: "Eleven", state: "open", labels: [{ name: "needs-input" }] },
        label: { name: "needs-input" },
        sender: { login: "bob", type: "User" },
      },
      "issues",
    );
    const relabelled = await until(
      async () => (await storedMap(dir, "inputs"))["org/repo#11"],
      "#11 listed again",
    );
    assert.ok(relabelled.since >= before);
    assert.equal(relabelled.ignoredTicks, undefined);
  });

  test("the orchestrator's maps (#615): a release before's files moved to the store, read back the same after a handover", async (t) => {
    const url = "https://github.com/org/repo/pull/50";
    const dryRun = { dryRun: true, by: "someone", at: 950, denials: 1, url: "https://x/1" };
    // What a release before kept in its data volume, a file per map.
    const legacy = {
      titles: { "org/repo#5": "Five", "org/repo#6": "Six", "org/repo#9": "Nine" },
      closed: { "org/repo#5": "completed", "org/repo#6": "completed", "org/repo#9": "completed" },
      // #9's failed run, its last (logged below), dismissed: kept at start.
      dismissed: { "org/repo#9": { runId: "org-repo-9-1000", by: "alice", at: 1 } },
      // Merged: not asked about again at start, as an open one is.
      pulls: { "org/repo#5": { number: 50, url, state: "merged", readyAt: 1, additions: 1 } },
      lanes: { "org/repo#5": { key: "org/repo#5", name: "Budgets", namedAt: 1, at: Date.now() } },
      "dry-runs": { "org/repo#5": dryRun },
      modes: { "org/repo#7": "review" },
      onboarding: { "org/other": { issue: 3, at: 1 } },
      conflicts: { "org/repo#8": { pr: 9, head: "h", base: "b", at: 1 } },
      requested: { "org/repo#pr-9": { head: "h", at: Date.now() } },
    };
    const ctx = await listen(t, {}, (dir, github) => {
      for (const [name, value] of Object.entries(legacy)) {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
      }
      // An item the release before #691 kept in the store's state file: moved to a file of its
      // own once this copy holds the lease.
      mkdirSync(join(dir, "store"));
      writeFileSync(
        join(dir, "store", "state.json"),
        JSON.stringify({ keys: { "modes/org/repo#3": { value: "review", expiresAt: null } } }),
      );
      mkdirSync(join(dir, "logs"));
      writeFileSync(
        join(dir, "logs", "org-repo-9-1000.log"),
        [
          {
            type: "listener",
            key: "org/repo#9",
            repo: "org/repo",
            taskMode: "work",
            startedAt: 1000,
          },
          { type: "result", is_error: true, result: "It failed.", duration_ms: 6000 },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );
      return { DEBOUNCE_MS: "60000", GITHUB_URL: github.url };
    });
    const { dir, port, send } = ctx;
    for (const name of Object.keys(legacy)) {
      assert.equal(existsSync(join(dir, `${name}.json`)), false, name);
      const expected =
        name === "modes" ? { ...legacy.modes, "org/repo#3": "review" } : legacy[name];
      assert.deepEqual(await storedMap(dir, name), expected, name);
    }
    // Each item a file of its own, out of the state file every lease renewal writes (#691).
    const saved = JSON.parse(readFileSync(join(dir, "store", "state.json"), "utf8")).keys;
    for (const name of Object.keys(legacy)) {
      assert.deepEqual(
        Object.keys(saved).filter((key) => key.startsWith(`${name}/`)),
        [],
        name,
      );
    }
    assert.ok(existsSync(join(dir, "store", "keys", "titles%2Forg%2Frepo%235")));
    for (const [number, id] of [
      [5, 105],
      [6, 106],
    ]) {
      const c = comment("alice");
      await send({ ...c, issue: { number }, comment: { ...c.comment, id } });
      await ctx.listener.until(`org/repo#${number}: queued (work`);
    }
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const moved = await fetch(`${base}/api/repos/org/repo/order`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://hooks.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ key: "org/repo#6", first: true }),
    });
    assert.equal(moved.status, 200, await moved.clone().text());
    // What the dashboard shows of the maps: titles, closed states, pull requests, lanes, the
    // run order, dry runs.
    const shown = async () => {
      const body = await (await get("/api/state", session)).json();
      return {
        tasks: body.tasks
          .map(({ key, title, closed, pr, position, dryRun, dismissed }) => ({
            key,
            title,
            closed,
            pr: pr && { number: pr.number, state: pr.state },
            ...(position && { position }),
            ...(dryRun && { dryRun }),
            ...(dismissed && { dismissed: { by: dismissed.by, at: dismissed.at } }),
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        lane: body.lanes["org/repo#5"]?.name,
      };
    };
    const before = await shown();
    assert.deepEqual(before, {
      tasks: [
        {
          key: "org/repo#5",
          title: "Five",
          closed: "completed",
          pr: { number: 50, state: "merged" },
          position: 2,
          dryRun,
        },
        { key: "org/repo#6", title: "Six", closed: "completed", pr: null, position: 1 },
        {
          key: "org/repo#9",
          title: "Nine",
          closed: "completed",
          pr: null,
          dismissed: { by: "alice", at: 1 },
        },
      ],
      lane: "Budgets",
    });
    // Those the dashboard doesn't show (the others it fills as it is read: a lane's parent).
    const stored = {};
    for (const name of ["modes", "onboarding", "conflicts", "requested", "order", "dismissed"]) {
      stored[name] = await storedMap(dir, name);
    }

    await ctx.handOver();
    await ctx.listener.until("org/repo#5: 1 comment(s) queued before the restart");
    await ctx.listener.until("org/repo#6: 1 comment(s) queued before the restart");
    assert.deepEqual(await shown(), before);
    for (const [name, value] of Object.entries(stored)) {
      assert.deepEqual(await storedMap(dir, name), value, name);
    }
    // Nothing written back to the data volume.
    for (const name of Object.keys(legacy)) {
      assert.equal(existsSync(join(dir, `${name}.json`)), false, name);
    }
  });

  test("the maps behind timers and comments (#616): moved to the store, a wait across a handover started once, a deadline fired once", async (t) => {
    const files = {
      "issue:77": JSON.stringify({ state: "open" }),
      "issue:80": JSON.stringify({ state: "open" }),
    };
    // What a release before kept in its data volume, a file per map.
    const legacy = {
      // A comment waiting for #80 (still open), saved before queueIds: it gets one.
      waits: {
        "org/repo#13": {
          repo: "org/repo",
          blockers: [80],
          item: {
            repo: "org/repo",
            id: "13",
            kind: "issue",
            number: 13,
            trigger: "work",
            modeLine: null,
            text: "After #80.",
            replyTo: 13,
            comment: { id: 130 },
            author: "alice",
            base: "trunk",
            eyes: null,
          },
          since: 1,
        },
      },
      // An issue waiting for input: asked about again at start (inputs.mjs sync()).
      inputs: { "org/repo#21": { since: 1, questions: null } },
      brainstorms: {
        // Its deadline passed while no copy acted: idle at the first start, and only then.
        "org/repo#20": { repo: "org/repo", number: 20, status: "active", deadline: 1 },
      },
      decisions: {
        "org/repo#pr-3": [{ decision: "merge", rule: "deny_merge", denied: true, pr: 3, at: 9 }],
      },
      reviews: { "org/repo#pr-3": { head: "abc", at: Date.now(), fixes: 1 } },
      picks: { "org/repo#9": "org-repo-9-1000" },
    };
    const ctx = await listen(t, files, (dir, github) => {
      for (const [name, value] of Object.entries(legacy)) {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
      }
      return { GITHUB_URL: github.url };
    });
    const { dir, github, send } = ctx;
    for (const name of Object.keys(legacy)) {
      assert.equal(existsSync(join(dir, `${name}.json`)), false, name);
    }
    await ctx.listener.until("org/repo#20: brainstorm idle");
    assert.equal((await storedMap(dir, "brainstorms"))["org/repo#20"].status, "idle");
    assert.deepEqual(await storedMap(dir, "decisions"), legacy.decisions);
    assert.deepEqual(await storedMap(dir, "reviews"), legacy.reviews);
    const moved = (await storedMap(dir, "waits"))["org/repo#13"];
    assert.deepEqual([moved.blockers, moved.item.text], [[80], "After #80."]);
    assert.ok(moved.item.queueId);
    // A comment that waits, its text in the store without the token pasted in it by mistake.
    const token = `ghp_${"b".repeat(36)}`;
    await send(comment("alice", `Deckhand /after #77\nDo it, ${token}.`));
    await until(() => replies(github).length === 1, "the waiting reply");
    const wait = (await storedMap(dir, "waits"))["org/repo#12"];
    assert.deepEqual(wait.blockers, [77]);
    assert.equal(wait.item.text, "Do it, [redacted].");
    const stored = {};
    for (const name of ["waits", "inputs", "reviews", "brainstorms", "decisions", "picks"]) {
      stored[name] = await storedMap(dir, name);
    }

    const { output } = await ctx.handOver();
    for (const [name, value] of Object.entries(stored)) {
      assert.deepEqual(await storedMap(dir, name), value, name);
    }
    // #77 done: the next copy starts the comment, once, and the wait goes.
    files["issue:77"] = JSON.stringify({ state: "closed", state_reason: "completed" });
    await send(
      {
        action: "closed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: { number: 77, state: "closed", state_reason: "completed" },
        sender: { login: "alice" },
      },
      "issues",
    );
    await until(() => exists(join(dir, "run-args")), "the run");
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /^TASK_MESSAGE=Do it, \[redacted\]\.$/m,
    );
    await ctx.listener.until("done (ok)");
    const starting = replies(github).filter((r) => /#77 is done: starting/.test(r.body));
    assert.equal(starting.length, 1);
    assert.deepEqual(Object.keys(await storedMap(dir, "waits")), ["org/repo#13"]);
    const idle = (out) => out.split("\n").filter((l) => l.includes("org/repo#20: brainstorm idle"));
    assert.equal(idle(output).length + idle(ctx.listener.output()).length, 1);
    // Nothing written back to the data volume.
    for (const name of Object.keys(legacy)) {
      assert.equal(existsSync(join(dir, `${name}.json`)), false, name);
    }
  });

  test("the dashboard and its logs are for allowed users signed in with GitHub", async (t) => {
    // GitHub's sign-in pages are the fake GitHub too. A built dashboard, and an older log with
    // no title.
    const { github, port, send, listener } = await listen(t, {}, (dir, github) => {
      const dist = join(dir, "dist");
      mkdirSync(join(dist, "assets"), { recursive: true });
      writeFileSync(join(dist, "index.html"), "<title>Deckhand</title>");
      writeFileSync(join(dist, "assets", "app-1a2b.js"), "export {}");
      mkdirSync(join(dir, "logs"));
      const meta = { type: "listener", key: "org/repo#pr-3", repo: "org/repo", startedAt: 1000 };
      const result = { type: "result", result: "## Fixed\n\nThe typo.", duration_ms: 6000 };
      writeFileSync(
        join(dir, "logs", "org-repo-pr-3-1000.log"),
        `${JSON.stringify(meta)}\n${JSON.stringify(result)}\n`,
      );
      // A run that stopped to ask.
      const asked = {
        type: "result",
        result:
          "<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?\n   - [ ] A (recommended)\n   - [ ] B",
        duration_ms: 6000,
      };
      writeFileSync(
        join(dir, "logs", "org-repo-pr-4-500.log"),
        `${JSON.stringify({ ...meta, key: "org/repo#pr-4", startedAt: 500 })}\n${JSON.stringify(asked)}\n`,
      );
      // An operator policy: its text goes to the config endpoint only (repos.test.mjs), never
      // to api/state.
      mkdirSync(join(dir, "grants", "policy"), { recursive: true });
      writeFileSync(
        join(dir, "grants", "policy", "op.rego"),
        "package deckhand\n# op-policy-text\n",
      );
      // What the policies decided about #pr-3 (decisions.mjs).
      const refused = { decision: "merge", rule: "deny_merge", denied: true, pr: 3, at: 900 };
      writeFileSync(
        join(dir, "decisions.json"),
        JSON.stringify({ "org/repo#pr-3": [{ ...refused, messages: ["too big"] }] }),
      );
      // And its last `/mode policy` dry run.
      const dryRun = { dryRun: true, by: "someone", at: 950, denials: 1, url: "https://x/1" };
      writeFileSync(join(dir, "dry-runs.json"), JSON.stringify({ "org/repo#pr-3": dryRun }));
      return { GITHUB_URL: github.url, DASHBOARD_DIR: dist };
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    // Signed out: a sign-in page, and nothing from the API.
    const home = await get("/");
    assert.equal(home.status, 200);
    const signIn = await home.text();
    assert.match(signIn, /Sign in with GitHub/);
    // The listener's own pages: no script, their one style by its hash, never in a frame.
    const style = /<style>([^]*?)<\/style>/.exec(signIn)[1];
    const styleHash = createHash("sha256").update(style).digest("base64");
    assert.equal(
      home.headers.get("content-security-policy"),
      `default-src 'none'; img-src 'self'; style-src 'sha256-${styleHash}'; frame-ancestors 'none'`,
    );
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");
    const refused = await get("/api/state");
    assert.equal(refused.status, 401);
    assert.equal((await get("/api/server")).status, 401);
    assert.equal((await get("/api/health")).status, 401);
    assert.equal(refused.headers.get("x-content-type-options"), "nosniff");
    for (const path of ["/assets/app-1a2b.js", "/index.html", "/nope.js"]) {
      assert.equal((await get(path)).status, 401);
    }
    // A run, so there is a log to stream; its title comes with the webhook.
    const titled = comment("alice");
    titled.issue.title = "Fix the queue";
    await send(titled);
    await listener.until("done (ok)");

    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    assert.equal(to.pathname, "/login/oauth/authorize");
    assert.equal(to.searchParams.get("redirect_uri"), "https://hooks.example.com/auth/callback");
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    assert.equal(back.status, 302);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    assert.ok(github.requests.some((r) => r.path === "/user" && r.auth === "Bearer user-token"));

    const index = await get("/", session);
    assert.equal(index.headers.get("cache-control"), "no-store");
    // The dashboard, and everything else: its own files only, never in a frame, never sniffed.
    for (const answer of [index, await get("/auth/login")]) {
      assert.equal(
        answer.headers.get("content-security-policy"),
        "default-src 'self'; frame-ancestors 'none'",
      );
      assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    }
    assert.match(await index.text(), /<title>Deckhand<\/title>/);
    const asset = await get("/assets/app-1a2b.js", session);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /^text\/javascript/);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    await asset.text();
    // What is outside the build: static.test.mjs.
    assert.equal((await get("/assets/nope.js", session)).status, 404);
    const board = await (await get("/api/state", session)).json();
    assert.equal(board.user, "alice");
    assert.ok(!JSON.stringify(board).includes("op-policy-text"));
    assert.equal(board.githubUrl, github.url);
    // The shape dashboard/src/types.ts expects: change both together.
    assertShape(board, STATE_KEYS, "State");
    assertShape(board.server, SERVER_KEYS, "ServerInfo");
    // What alice may do (#732): Deckhand's default policies give every action.
    assertShape(board.access, ACCESS_KEYS, "Access");
    assert.deepEqual(board.access.server, ["server:read", "server:sync"]);
    for (const repo of Object.values(board.access.repos)) {
      assertShape(repo, REPO_ACCESS_KEYS, "RepoAccess");
      assert.deepEqual(repo.starts, ["*"]);
    }
    // Settings › Access: who has what.
    const report = await (await get("/api/access", session)).json();
    assertShape(report, ACCESS_REPORT_KEYS, "AccessReport");
    assert.deepEqual(
      report.users.map((u) => u.login),
      ["alice", "bob"],
    );
    for (const u of report.users) {
      assertShape(u, USER_ACCESS_KEYS, "UserAccess");
      for (const d of [u.server, ...u.repos])
        assertShape(d, ACCESS_DECISION_KEYS, "AccessDecision");
    }
    // Built from source: no version to link, and up since this listener started.
    assert.deepEqual([board.server.version, board.server.source], ["dev", ""]);
    assert.ok(board.server.startedAt <= board.now);
    // How it is set up, for Settings › Server (status.mjs serverSetup()).
    const setup = await (await get("/api/server", session)).json();
    assertShape(setup, SETUP_KEYS, "ServerSetup");
    assert.deepEqual(setup.allowedUsers, ["alice", "bob"]);
    // The services' health, which the orchestrator probes (health.mjs): never their URLs.
    const health = await (await get("/api/health", session)).json();
    assertShape(health, HEALTH_KEYS, "Health");
    for (const s of health.services) assertShape(s, SERVICE_HEALTH_KEYS, "ServiceHealth");
    const states = Object.fromEntries(health.services.map((s) => [s.name, s.state]));
    assert.equal(states.orchestrator, "starting");
    assert.equal(states.edge, "starting");
    assert.doesNotMatch(JSON.stringify(health), /127\.0\.0\.1|http:/);
    for (const t of board.tasks) {
      assertShape(t, TASK_KEYS, "Task");
      for (const r of t.runs) assertShape(r, RUN_KEYS, "Run");
    }
    const [task] = board.tasks;
    assert.deepEqual(
      [task.key, task.project, task.state, task.title],
      ["org/repo#12", "org", "done", "Fix the queue"],
    );
    assert.equal(task.runs[0].title, "Fix the queue");
    assert.equal(task.runs[0].summary, "All done.");
    // The older task's title is fetched once, then shows.
    await github.waitFor((r) => r.method === "GET" && r.path === "/repos/org/repo/issues/3");
    const older = async () =>
      (await (await get("/api/state", session)).json()).tasks.find(
        (x) => x.key === "org/repo#pr-3",
      );
    let fetched = await older();
    for (let i = 0; i < 100 && !fetched.title; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      fetched = await older();
    }
    assert.equal(fetched.title, "An older pull request");
    assert.equal(fetched.runs[0].summary, "The typo.");
    assert.deepEqual(fetched.decisions, [
      {
        decision: "merge",
        rule: "deny_merge",
        denied: true,
        pr: 3,
        at: 900,
        messages: ["too big"],
      },
    ]);
    assert.deepEqual(fetched.dryRun, {
      dryRun: true,
      by: "someone",
      at: 950,
      denials: 1,
      url: "https://x/1",
    });
    // Waiting for input: the questions of the run that stopped to ask, and of an issue's body.
    const tasks = async () => (await (await get("/api/state", session)).json()).tasks;
    const stopped = (await tasks()).find((x) => x.key === "org/repo#pr-4");
    assert.equal(stopped.state, "needs-input");
    assert.deepEqual(stopped.questions, {
      source: "run",
      runId: "org-repo-pr-4-500",
      items: [
        {
          title: "Name",
          text: "which one?",
          options: [
            { label: "A", recommended: true, checked: false },
            { label: "B", recommended: false, checked: false },
          ],
        },
      ],
      raw: "1. **Name**: which one?\n   - [ ] A (recommended)\n   - [ ] B",
    });
    await send(
      {
        action: "opened",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: {
          number: 20,
          title: "An idea",
          state: "open",
          body: "## Open questions\n\nWhich colour?",
          user: { login: "alice", type: "User" },
          labels: [],
        },
        sender: { login: "alice", type: "User" },
      },
      "issues",
    );
    await listener.until("org/repo#20: open questions, labelled");
    const filed = (await tasks()).find((x) => x.key === "org/repo#20");
    assert.deepEqual(filed.questions, { source: "issue", items: null, raw: "Which colour?" });
    for (const x of [stopped, filed]) assertShape(x.questions, QUESTIONS_KEYS, "Questions");
    // Its pull request too, without a readyAt: nothing to notify.
    for (let i = 0; i < 100 && !fetched.pr; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      fetched = await older();
    }
    assert.deepEqual(fetched.pr, {
      number: 3,
      url: "https://github.com/org/repo/pull/3",
      state: "ready",
      readyAt: null,
    });

    // A pull request that closes #12, from its webhooks: draft, then ready for review.
    const pr = (action, draft) => ({
      action,
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      pull_request: {
        number: 13,
        html_url: "https://github.com/org/repo/pull/13",
        body: "Closes #12",
        state: "open",
        draft,
        head: { ref: "issue-12-fix", repo: { full_name: "org/repo" } },
        additions: 86,
        deletions: 19,
        changed_files: 4,
        commits: draft ? 2 : 3,
      },
      sender: { login: "deckhand[bot]" },
    });
    await send(pr("opened", true), "pull_request");
    await listener.until("org/repo#12: pull request #13 draft");
    await send(pr("ready_for_review", false), "pull_request");
    await listener.until("org/repo#12: pull request #13 ready");
    const ready = (await (await get("/api/state", session)).json()).tasks.find(
      (x) => x.key === "org/repo#12",
    );
    assert.equal(ready.pr.number, 13);
    assert.equal(ready.pr.state, "ready");
    assert.ok(ready.pr.readyAt > 0);
    // Its size and commit count, as the last delivery had them.
    assert.deepEqual(
      [ready.pr.additions, ready.pr.deletions, ready.pr.changedFiles, ready.pr.commits],
      [86, 19, 4, 3],
    );
    assert.equal(ready.closed, null);
    // #12 closed as completed: the graph shows it implemented.
    await send(
      {
        action: "closed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: { number: 12, state: "closed", state_reason: "completed" },
        sender: { login: "alice" },
      },
      "issues",
    );
    let closed = null;
    for (let i = 0; i < 100 && !closed; i++) {
      const all = (await (await get("/api/state", session)).json()).tasks;
      closed = all.find((x) => x.key === "org/repo#12").closed;
      if (!closed) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(closed, "completed");
    const stream = await get(`/api/runs/${task.runs[0].id}/stream`, session);
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /event: end/);
    assert.equal((await get(`/api/runs/${task.runs[0].id}/stream`)).status, 401);
    // Sync: the deliveries and pull requests asked again, from this dashboard only, not twice
    // in a row.
    const sync = (headers) =>
      fetch(`${base}/api/sync`, { method: "POST", headers: { cookie: session, ...headers } });
    assert.equal((await sync({ origin: "https://evil.example" })).status, 403);
    // The listener's own, at start, is the last one until then.
    const lastSync = async () => (await (await get("/api/state", session)).json()).lastSync;
    let atStart = null;
    for (let i = 0; i < 100 && !atStart; i++) {
      atStart = await lastSync();
      if (!atStart) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(atStart, "the sync at start is recorded");
    assert.equal(atStart.by, null);
    assertShape(atStart, SYNC_KEYS, "SyncResult");
    const synced = await sync({ origin: "https://hooks.example.com" });
    assert.equal(synced.status, 200);
    const body = await synced.json();
    assert.deepEqual(
      { ...body, at: 0 },
      {
        at: 0,
        by: "alice",
        redelivered: 0,
        pulls: 0,
        conflicts: 0,
      },
    );
    assert.ok(body.at >= atStart.at);
    // Every browser sees it, not only the one that asked.
    assert.deepEqual(await lastSync(), body);
    assert.equal((await sync({ origin: "https://hooks.example.com" })).status, 429);
  });

  // dashboard/src/types.ts, key by key: [required, optional].
  const STATE_KEYS = [
    [
      "user",
      "tasks",
      "edges",
      "blockers",
      "states",
      "running",
      "queued",
      "maxParallel",
      "githubUrl",
      "server",
      "lastSync",
      "now",
    ],
    ["inboxes", "lanes", "plans", "access"],
  ];
  const ACCESS_KEYS = [["server", "repos"], []];
  const REPO_ACCESS_KEYS = [["actions", "starts", "startsDenied"], []];
  const ACCESS_REPORT_KEYS = [["users", "repos", "error"], []];
  const USER_ACCESS_KEYS = [["login", "server", "repos"], []];
  const ACCESS_DECISION_KEYS = [["actions", "denied", "error", "outside"], ["repo"]];
  const SERVER_KEYS = [["version", "startedAt", "node", "source"], []];
  const SYNC_KEYS = [["at", "by", "redelivered", "pulls", "conflicts"], ["error"]];
  const SETUP_KEYS = [["engine", "proxy", "grants", "allowedUsers", "allowedRepos"], ["claude"]];
  const HEALTH_KEYS = [["checkedAt", "services"], []];
  const SERVICE_HEALTH_KEYS = [["name", "state", "startedAt", "version", "checkedAt"], ["reason"]];
  const TASK_KEYS = [
    [
      "key",
      "repo",
      "project",
      "number",
      "title",
      "kind",
      "mode",
      "replyTo",
      "state",
      "since",
      "updatedAt",
      "closed",
      "pr",
      "rerunnable",
      "dismissed",
      "runs",
    ],
    [
      "deadline",
      "waitingFor",
      "questions",
      "waitForAnswers",
      "decisions",
      "dryRun",
      "position",
      "startsFirst",
      "canWait",
    ],
  ];
  const QUESTIONS_KEYS = [["source", "items", "raw"], ["runId"]];
  const RUN_KEYS = [
    [
      "id",
      "key",
      "kind",
      "title",
      "repo",
      "replyTo",
      "mode",
      "taskMode",
      "startedAt",
      "finishedAt",
      "status",
    ],
    [
      "reason",
      "round",
      "rounds",
      "agent",
      "provider",
      "credential",
      "auth",
      "fallback",
      "picked",
      "model",
      "effort",
      "speed",
      "speedNote",
      "phase",
      "summary",
      "delivered",
      "branch",
      "lastPushAt",
      "exitCode",
      "capabilities",
    ],
  ];

  function assertShape(value, [required, optional], name) {
    const keys = Object.keys(value);
    const unknown = keys.filter((k) => !required.includes(k) && !optional.includes(k));
    assert.deepEqual(unknown, [], `${name}: keys types.ts doesn't have`);
    const missing = required.filter((k) => !keys.includes(k));
    assert.deepEqual(missing, [], `${name}: keys types.ts requires`);
  }

  test("a delivery GitHub sends again is handled once", async (t) => {
    const { port, listener } = await listen(t, {}, { DEBOUNCE_MS: "60000" });
    const body = JSON.stringify(comment("alice"));
    const deliver = () =>
      fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          "x-github-event": "issue_comment",
          "x-github-delivery": "d-1",
          "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
        },
        body,
      });
    assert.equal((await deliver()).status, 202);
    await listener.until("queued (work");
    assert.equal((await deliver()).status, 202);
    await listener.until("Delivery d-1 again: already handled");
    assert.equal(listener.output().match(/queued \(work/g).length, 1);
  });

  // What the git gateway answers a push of `ref` with the run's secret: refused pushes are
  // answered by the gateway itself, the others reach the fake GitHub.
  // A commit over the empty tree, and a pack holding both: a push that carries what its branch
  // reaches, as a work run's must (git-mirror.mjs connect()).
  let carried = null;
  function commitPack() {
    if (carried) return carried;
    const repo = tempDir(null, "pack-");
    execFileSync("git", ["init", "-q", repo]);
    const git = (args, input) =>
      execFileSync("git", ["-C", repo, ...args], {
        input,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "a",
          GIT_AUTHOR_EMAIL: "a@a",
          GIT_COMMITTER_NAME: "a",
          GIT_COMMITTER_EMAIL: "a@a",
        },
      });
    const tree = git(["hash-object", "-t", "tree", "-w", "--stdin"], "").toString().trim();
    const sha = git(["commit-tree", tree, "-m", "c"]).toString().trim();
    return (carried = { sha, pack: git(["pack-objects", "--stdout"], `${sha}\n${tree}\n`) });
  }

  // A push of `ref` by hand: by default with a real commit and its pack; `carries: false`, to a
  // commit nobody has, without one.
  async function pushProbe(proxyPort, secret, ref, { carries = true } = {}) {
    const { sha, pack } = carries ? commitPack() : { sha: "a".repeat(40), pack: Buffer.alloc(0) };
    const line = `${"0".repeat(40)} ${sha} ${ref}\0report-status\n`;
    const body = Buffer.concat([
      Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`),
      pack,
    ]);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/git/org/repo.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`deckhand:${secret}`).toString("base64")}` },
      body,
    });
    return res.text();
  }

  // The branches a running run may push, from its saved state.
  async function savedBranches(dir) {
    const live = await until(() => liveStates(dir)[0], "the run's saved state");
    // Its tokens aren't in it (#617).
    assert.equal(live.agentToken, undefined);
    assert.equal(live.runTokens, undefined);
    return live.branches;
  }

  test("a run on an issue pushes issue-<n>-* only, before and after a restart", async (t) => {
    const ctx = await listen(t, {}, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      return { GITHUB_URL: github.url };
    });
    const { dir, github, proxyPort } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    assert.deepEqual(await savedBranches(dir), ["issue-12-*"]);
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const forwarded = () =>
      github.requests.filter((r) => r.path === "/org/repo.git/git-receive-pack").length;

    for (const round of ["before", "after"]) {
      for (const ref of ["refs/heads/issue-13-x", "refs/heads/gh-pages"]) {
        assert.match(
          await pushProbe(proxyPort, secret, ref),
          /ng refs\/heads\/[\w-]+ Deckhand: this run can only push issue-12-\*/,
          `${round}: ${ref}`,
        );
      }
      assert.equal(forwarded(), round === "before" ? 0 : 1);
      await pushProbe(proxyPort, secret, `refs/heads/issue-12-${round}`);
      assert.equal(forwarded(), round === "before" ? 1 : 2);
      // GitHub took it: the run's last push, on its saved record.
      const record = () => liveStates(dir)[0].record;
      await until(() => record().branch === `issue-12-${round}`, "the push");
      assert.ok(record().lastPushAt > 0);
      if (round === "before") {
        await ctx.restart();
        await ctx.listener.until("picked up");
      }
    }
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    // Kept in its summary once it ended: the dashboard's after it.
    const done = await until(() => summary(dir), "its summary");
    assert.equal(done.branch, "issue-12-after");
  });

  test("the `workflows` grant: pushes are checked against a mirror in the github service's data dir, until the grant goes", async (t) => {
    const ctx = await listen(t, {}, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      writeGrants(dir, ["workflows"]);
      return { GITHUB_URL: github.url };
    });
    const { dir, github, proxyPort } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    // The token each push reached GitHub with.
    const pushedWith = () =>
      github.requests
        .filter((r) => r.path === "/org/repo.git/git-receive-pack")
        .map((r) => Buffer.from(r.auth.split(" ")[1], "base64").toString().split(":")[1]);
    // Read first, against a mirror fetched from GitHub with a token that reads (this fake GitHub
    // serves no git: an empty one): a branch pointed at a commit the push doesn't carry and the
    // repository doesn't have is refused, never forwarded (a work run that isn't a fork's).
    assert.match(
      await pushProbe(proxyPort, secret, "refs/heads/issue-12-x", { carries: false }),
      /ng refs\/heads\/issue-12-x Deckhand: this push points refs\/heads\/issue-12-x at a{12}, which it doesn't carry and org\/repo doesn't have/,
    );
    // The github service's, a cache of its own.
    assert.ok(existsSync(join(dir, "github-service", "mirrors", "org/repo.git")));
    const fetched = github.requests.find((r) => r.path.startsWith("/org/repo.git/info/refs"));
    assert.match(fetched.path, /service=git-upload-pack/);
    assert.equal(
      Buffer.from(fetched.auth.split(" ")[1], "base64").toString(),
      "x-access-token:repo-token",
    );
    assert.deepEqual(pushedWith(), []);
    // Opening its pull request checks the same, merged with its base, against the mirror
    // fetched again. This fake GitHub has no branch there, which runs nothing: it opens.
    const mirrorFetches = () =>
      github.requests.filter((r) => r.path.startsWith("/org/repo.git/info/refs")).length;
    const before = mirrorFetches();
    const opened = await fetch(
      `http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo/pulls`,
      {
        method: "POST",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({ title: "t", head: "issue-12-x", base: "trunk" }),
      },
    );
    assert.equal(opened.status, 200);
    assert.equal(mirrorFetches(), before + 1);
    // The push's token writes workflows; the sandbox's own tokens never do. Opening a pull
    // request is the one call whose token writes pull requests.
    const minted = github.requests.filter((r) => r.path.endsWith("/access_tokens"));
    assert.equal(minted.filter((r) => r.body.includes("workflows")).length, 1);
    const pullWrite = (r) => r.body.includes('"pull_requests":"write"');
    assert.equal(minted.filter(pullWrite).length, 1);
    assert.ok(
      github.requests.some((r) => r.method === "POST" && r.path === "/repos/org/repo/pulls"),
    );
    // Taken back: the next push goes through without it, no restart, read for what it carries
    // alone.
    writeGrants(dir, []);
    await pushProbe(proxyPort, secret, "refs/heads/issue-12-x");
    assert.deepEqual(pushedWith(), ["repo-token"]);
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
  });

  test("a run on a pull request pushes its head branch, a maintainer's included, never a fork's", async (t) => {
    const ctx = await listen(t, {}, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    const { dir } = ctx;
    const onPull = (number) => {
      const payload = comment("alice");
      payload.issue = { number, pull_request: {} };
      return payload;
    };
    await ctx.send(onPull(40));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    assert.deepEqual(await savedBranches(dir), ["feature/maintainer"]);
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /push to its branch, `feature\/maintainer`: Deckhand refuses pushes to any other/,
    );
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    rmSync(join(dir, "egress"));
    rmSync(join(dir, "go"));

    await ctx.send(onPull(41));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    assert.deepEqual(await savedBranches(dir), []);
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /its branch is in a fork/);
    writeFileSync(join(dir, "go"), "");
  });

  test("a granted repo's work runs get a container engine, never for a fork's pull request", async (t) => {
    const ctx = await listen(t, { ".deckhand.yaml": "docker:\n  cache: true\n" }, (dir) => {
      writeGrant(dir, "limits: { cpus: 3 }\n");
      writeGrants(dir, ["docker"]);
      writeFileSync(join(dir, "hold"), "");
      return { SANDBOX_ENGINE: "podman" };
    });
    const { dir, github } = ctx;
    // The network its tokens are bound to, from its saved state: what the egress policy finds
    // its sandbox and its engine by (broker-http.mjs taskWhere()).
    const savedSandbox = async () => {
      const state = await until(
        () => liveStates(dir).find((saved) => saved?.sandbox) ?? null,
        "the run's saved state, after its start",
      );
      return state;
    };
    await ctx.send(comment("alice"));
    const saved = await savedSandbox();
    assert.equal(saved.sandbox, `id-${saved.id}`);
    writeFileSync(join(dir, "go"), "");
    await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    await ctx.listener.until("done (ok)");
    const joined = readFileSync(join(dir, "engine-args"), "utf8").split("\n").join(" ");
    assert.match(joined, /--network-alias engine /);
    assert.match(joined, /--cpus 3 --memory 4g --memory-swap 4g --pids-limit 2048 /);
    assert.match(joined, /src=deckhand-engine-cache-org-repo-[0-9a-f]+-podman,/);
    assert.match(joined, /--label deckhand\.task=org\/repo#12/);
    assert.doesNotMatch(joined, /--privileged|docker\.sock/);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(args.includes("DOCKER_HOST=tcp://engine:2375"));
    assert.ok(args.includes("DOCKER_BUILDKIT=0"));
    // The sandbox keeps its hardening.
    assert.match(
      args.join(" "),
      /--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges/,
    );
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^NO_PROXY=.*,engine$/m);
    assert.match(await onlyLog(dir), /Container engine: podman, the repository's cache/);

    // A fork's pull request: no engine.
    rmSync(join(dir, "engine-args"));
    rmSync(join(dir, "go"));
    await until(() => !liveStates(dir).length, "the first run's saved state removed");
    const payload = comment("alice");
    payload.issue = { number: 41, pull_request: {} };
    await ctx.send(payload);
    // Started: its saved state has its network.
    await savedSandbox();
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("org/repo#pr-41: done (ok)");
    assert.throws(() => readFileSync(join(dir, "engine-args")));
    assert.doesNotMatch(readFileSync(join(dir, "run-args"), "utf8"), /DOCKER_HOST/);
  });
});
