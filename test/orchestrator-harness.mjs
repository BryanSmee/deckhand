// The orchestrator end to end, without Docker or GitHub: edge in front of it (edge/), which takes
// the webhooks, the runner service beside it (runner/), a fake `docker` on the runner's PATH
// plays the sandbox (asks the broker for a token, prints a result), a local server plays GitHub.
// The tests still say "listener" for the pair, edge and the orchestrator, that took its place.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
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
import { AGENT_SECRETS, agentFor } from "../listener/agents/index.mjs";
import { lastResult, outcome, questionsOf, summaryOf } from "../listener/runlog.mjs";
import { createBrokerService as createBrokerClient } from "../listener/broker-service.mjs";
import {
  ConfigError,
  loadConfig,
  readConfigFile,
  withCredentialFiles,
} from "../listener/config.mjs";
import { loginSeal } from "../models/logins.mjs";
import { createModels, credentialNames, runnerOf } from "../models/server.mjs";
import { gitBlob } from "../listener/images.mjs";
import { openStore, values } from "../lib/store.mjs";
import { fileName } from "../lib/store-file.mjs";
import { pathToFileURL } from "node:url";
import {
  evalResult,
  fakeOpa,
  forwarder,
  grantsPolicy,
  listening,
  servePolicies,
  needsBash,
  startService,
  tempDir,
  testKey,
  until as waitUntil,
} from "./helpers.mjs";

// The policy service's opa allowing a brainstorm's GitHub writes on its own issue only, as
// Deckhand's mode-brainstorm.rego does for an edit (github-writes.test.mjs evaluates the real
// file): what these tests check is the wiring, the gateway asking the policies.
export const brainstormOpa = () =>
  fakeOpa({
    answer: (_files, input) =>
      evalResult(
        [],
        !(input.mode === "brainstorm" && input.target && input.target.kind !== "own_issue"),
      ),
  });

export const SECRET = "webhook-secret";

// The App's key, one for every listener: making one takes a while.
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});

// A read-write mount needs every directory from / to its parent out of the sandbox's user's
// reach (uid 1000, maybe the tests' own), which a temp dir isn't: /usr is root's everywhere.
// The fake docker mounts nothing.
export const RW_MOUNT = "/usr";

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
// tarball; none: no .deckhand.yaml (404). `files.down`: path → the statuses its reads get
// first, one each (an array, 0 for an answer), or every time (a number), GitHub failing them.
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
      for (const w of [...waiters]) {
        if (!w.match(entry)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(entry);
      }
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
      // Another repository's default branch's files are keyed "<owner>/<repo>:<path>".
      const other = /^\/repos\/([^/]+\/[^/]+)\/contents\/([^?]+)(?:\?ref=trunk)?$/.exec(req.url);
      if (other && other[1] !== "org/repo") {
        const text = files[`${other[1]}:${decodeURIComponent(other[2])}`];
        if (text === undefined) return res.writeHead(404).end("{}");
        return res.end(
          JSON.stringify({
            type: "file",
            sha: gitBlob(Buffer.from(text)),
            content: Buffer.from(text).toString("base64"),
          }),
        );
      }
      // Other branches' files are keyed "<branch>:<path>".
      // Without a ref, the default branch's (the runner's blob lookups).
      const file = /^\/repos\/org\/repo\/contents\/([^?]+)(?:\?ref=(.+))?$/.exec(req.url);
      if (file) {
        const path = decodeURIComponent(file[1]);
        const down = files.down?.[path];
        const status = Array.isArray(down) ? down.shift() : down;
        if (status) return res.writeHead(status).end('{"message":"Server Error"}');
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
      // Dashboard sign-in: the browser comes back as alice, or `files.login` when the test sets it.
      if (req.url === "/login/oauth/access_token") {
        return res.end(JSON.stringify({ access_token: "user-token" }));
      }
      if (req.url === "/user") return res.end(JSON.stringify({ login: files.login ?? "alice" }));
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
      // A head compared with its base (an auto-merge's gate): up to date.
      if (req.method === "GET" && req.url.startsWith("/repos/org/repo/compare/")) {
        return res.end(JSON.stringify({ status: "ahead", behind_by: 0 }));
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
  // `what`: what a test that hangs says it waited for (waiting()); the matcher's code if none.
  const waitFor = (match, what = String(match)) =>
    new Promise((resolve) => {
      const found = requests.find(match);
      if (found) return resolve(found);
      waiters.push({ match, resolve, what });
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
    waiting: () => waiters.map((w) => w.what),
    hold,
    server,
  };
}

// The runs' summaries, in the orchestrator's store (runlog.mjs: its file backend keeps them a
// file each, in keys/'s folder of summaries): the first one's, or null.
export function summary(dir) {
  try {
    const folder = join(dir, "store", "keys", "summaries%2F");
    const file = readdirSync(folder)[0];
    return file ? JSON.parse(readFileSync(join(folder, file), "utf8")).value : null;
  } catch {
    return null;
  }
}

// Every saved run's summary.
export function summaries(dir) {
  const folder = join(dir, "store", "keys", "summaries%2F");
  try {
    return readdirSync(folder).map((f) => JSON.parse(readFileSync(join(folder, f), "utf8")).value);
  } catch {
    return [];
  }
}

// What a run's summary has from its log's first line (runlog.mjs newRecord()).
const RUN_FIELDS = [
  ...["provider", "credential", "auth", "fallback", "picked", "light", "kind", "title", "repo"],
  ...["replyTo", "mode", "capabilities", "taskMode", "reason", "round", "rounds", "items"],
  ...["model", "effort", "speed", "speedNote"],
];

// A run that ended before the test's orchestrator starts: its log at the runner (`lines`, the
// first the listener's: one blob of the runner's store, as a log from before segments reads),
// its summary in the orchestrator's store, a file of its own (the file store's `keys/`, in the
// folder of summaries; right in `keys/` with `flat`, as a release before #773 kept it).
export function pastRun(dir, id, lines, { flat = false } = {}) {
  const text = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
  const blobs = join(dir, "runner-store", "blobs");
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, fileName(`logs/${id}`)), text);
  const [meta] = lines;
  const result = lastResult(text.split("\n"), agentFor(meta.agent));
  const record = {
    id,
    agent: agentFor(meta.agent).name,
    ...Object.fromEntries(RUN_FIELDS.map((name) => [name, meta[name] ?? null])),
    key: meta.key,
    ...(meta.autoPickup && { autoPickup: true }),
    startedAt: meta.startedAt,
    // Now: retention keeps it.
    finishedAt: Date.now(),
    status: result ? outcome(result) : "interrupted",
    summary: summaryOf(result),
    questions: questionsOf(result),
  };
  const keys = join(dir, "store", "keys", ...(flat ? [] : ["summaries%2F"]));
  mkdirSync(keys, { recursive: true });
  const key = `summaries/${id}`;
  writeFileSync(join(keys, fileName(key)), JSON.stringify({ key, value: record }));
}

// The dashboard's API at edge's `port`, as alice (in ALLOWED_USERS), signed in: path → its JSON.
export async function dashboardApi(port) {
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
export function runLogs(dir) {
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
export function liveStates(dir) {
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
export async function onlyLog(dir) {
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
export async function storedMap(dir, name) {
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
export const start = (env, { script = "orchestrator/server.mjs", also } = {}) =>
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
  // GitHub's hiccups tried again at once: the tries are github-app.test.mjs's.
  const app = createAppHolder({ dir: own, api: config.githubApi, sleep: async () => {} });
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

// Each test runs its own listener, fake GitHub and fake Docker in its own temp dir, on ports
// the OS picks, and mostly waits on them: they run side by side, two per core (eight at most).
// Not on Windows: the fake docker is a shell script, and its sandboxes are process groups.
export const options = { concurrency: Math.min(8, 2 * availableParallelism()), skip: needsBash };

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
export function writeGrant(dir, text) {
  mkdirSync(join(dir, "grants", "org"), { recursive: true });
  writeFileSync(join(dir, "grants", "org", "repo.yaml"), text);
}

// What the operator's policies grant org/repo (grants.mjs GRANTS, #498): its policy/grants.rego,
// which the policy service's fake opa reads back (helpers.mjs grantDecision()).
export function writeGrants(dir, names) {
  mkdirSync(join(dir, "grants", "policy"), { recursive: true });
  writeFileSync(join(dir, "grants", "policy", "grants.rego"), grantsPolicy(names));
}

// `opa`: the policy service's (fakeOpa()'s, allowing everything by default).
// `appRefused`: how many of the orchestrator's first asks for the App edge answers 500, as an
// edge not up yet: the orchestrator then starts without it, and learns it a few seconds later.
export async function listen(t, files, extra = {}, { opa, appRefused = 0 } = {}) {
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
  // The App's credentials: its key the github service's, the rest edge's.
  const credentials = {
    id: 5,
    client_id: "Iv1.x",
    client_secret: "cs",
    slug: "deckhand-x",
    bot_id: 77,
    webhook_secret: SECRET,
    pem: PEM,
  };
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
  const runnerPort = await forwarder(t, () => portOf(runner, /Deckhand runner \(\w+\) on :(\d+)/g));
  const edgeInternalPort = await forwarder(t, () => portOf(edge, /Internal port on :(\d+)\n/g));
  // The orchestrator reaches it through `appRefused`'s refusals, when there are some.
  let edgeUrlPort = edgeInternalPort;
  if (appRefused) {
    let left = appRefused;
    const front = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/app" && left > 0) {
        left -= 1;
        return res
          .writeHead(500, { "content-type": "application/json" })
          .end('{"message":"not yet"}');
      }
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: edgeInternalPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (answer) => {
          res.writeHead(answer.statusCode, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    edgeUrlPort = await listening(front);
    front.unref();
    t.after(() => (front.closeAllConnections(), front.close()));
  }
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
    EDGE_URL: `http://127.0.0.1:${edgeUrlPort}`,
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
  // ORCHESTRATOR_DATA_DIR: its data folder, apart from the others' (the test's folder);
  // ORCHESTRATOR_STORE_URL: its store, the orchestrator's alone (edge keeps its own).
  const listenerEnv = ({ ORCHESTRATOR_DATA_DIR: own, ORCHESTRATOR_STORE_URL: store, ...env }) => ({
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !AGENT_SECRETS.includes(name))),
    ...(own && { DATA_DIR: own }),
    ...(store && { STORE_URL: store }),
  });
  // The runner: the same settings (those it reads), its own port and store, the broker
  // service's keys, the listener's services port as its orchestrator and github service.
  // Started once the listener's is known.
  let runnerSettings = null;
  const runnerOut = () => (runner?.own() ?? "") + modelsOut;
  // Every copy started, for the report of a test that fails (failed()).
  const copies = { orchestrator: [], runner: [] };
  const startRunner = (more = {}) => {
    runner = start({ ...runnerSettings, ...more, PORT: "0" }, { script: "runner/server.mjs" });
    copies.runner.push(runner);
    return runner.until(/Deckhand runner \(\w+\) on :\d+/);
  };
  // The orchestrator's next copy, with `env`.
  const startListener = (env) => {
    const copy = start(listenerEnv(env), { also: others });
    copies.orchestrator.push(copy);
    return copy;
  };
  // What the harness itself waits for (an exit, an answer), named for that report.
  const steps = new Set();
  const step = async (what, promise) => {
    steps.add(what);
    try {
      return await promise;
    } finally {
      steps.delete(what);
    }
  };
  // Edge, in front: its own data folder (the App but its key) and store, the orchestrator's
  // services port to pass the dashboard's API on to, its internal port for the orchestrator.
  const edgeEnv = ({ ORCHESTRATOR_STORE_URL: _store, ...env }) => ({
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
  listener = startListener(settings);
  // Before they are killed: what the test waited for, and what each service said: CI keeps
  // nothing else (#1107, #1109).
  t.after(() => {
    if (t.passed) return;
    const waits = [
      ...steps,
      ...github.waiting().map((what) => `GitHub's request ${what}`),
      ...[...copies.orchestrator, edge, ...copies.runner].flatMap((copy) => copy.waiting()),
    ];
    // Each copy's output, and how it ended if it did: a copy that lost its lease exits.
    const named = (copy, name) => {
      const { exitCode, signalCode } = copy.child;
      const ended = exitCode !== null ? `exit ${exitCode}` : signalCode && `killed (${signalCode})`;
      return [ended ? `${name}, ${ended}` : name, copy.own()];
    };
    const outputs = Object.fromEntries([
      ...copies.orchestrator.map((copy, i) => named(copy, `orchestrator #${i + 1}`)),
      named(edge, "edge"),
      ...copies.runner.map((copy, i) => named(copy, `runner #${i + 1}`)),
      ["models", modelsOut],
    ]);
    t.diagnostic(failed(t, dir, waits, outputs));
  });
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
    return step(
      `edge's answer to a ${event} webhook`,
      fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          ...(id && { "x-github-delivery": id }),
          "x-github-event": event,
          "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
        },
        body,
      }),
    );
  };
  // Stops the listener (SIGTERM unless `signal` says otherwise) and starts another one on the
  // same data and ports, with `more` settings.
  const restart = async ({ signal = "SIGTERM", ...more } = {}) => {
    const old = listener;
    const { child } = old;
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const code =
      child.exitCode ??
      (child.signalCode ||
        (child.kill(signal), await step(`the orchestrator's exit on ${signal}`, exited)));
    listener = startListener({ ...settings, ...more });
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
    const next = startListener({ ...settings, ...more });
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
    await step(`the old orchestrator's exit on ${signal}`, exited);
    return { output: old.output(), epoch: epochOf(old.own()), next: epochOf(next.own()), took };
  };
  // A service token the broker would sign `sub` for `aud`: the old copy's calls, after it.
  const serviceToken = (sub, aud) => `Bearer ${signServiceToken({ sub, aud }, brokerKey)}`;
  // The runner stopped (SIGTERM unless said otherwise) and another started on the same store,
  // with `more` settings: the listener carries on with it.
  const stopRunner = async (signal = "SIGTERM") => {
    const { child } = runner;
    if (child.exitCode !== null || child.signalCode) return;
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill(signal);
    await step(`the runner's exit on ${signal}`, exited);
  };
  const restartRunner = async ({ signal = "SIGTERM", ...more } = {}) => {
    await stopRunner(signal);
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
    // The runner stopped, then started again apart: for a while with none at all.
    stopRunner,
    startRunner,
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

// The report of a test that failed or timed out (`t.error`): what it was waiting for, then the
// services' output and the fake sandboxes', each to its last lines.
function failed(t, dir, waits, outputs) {
  const tail = (text, lines = 300) => (text ?? "").split("\n").slice(-lines).join("\n");
  const sandboxes = (() => {
    try {
      return readdirSync(join(dir, "containers"));
    } catch {
      return [];
    }
  })();
  const parts = [
    `${t.fullName} failed (${t.error?.message ?? t.error}), in ${dir}`,
    `Waiting for:\n${waits.map((w) => `  ${w}`).join("\n") || "  nothing the harness knows of"}`,
    ...Object.entries(outputs).map(([name, text]) => `--- ${name}:\n${tail(text)}`),
    `--- docker calls:\n${tail(exists(join(dir, "docker-calls")), 100)}`,
    ...sandboxes.map(
      (name) => `--- sandbox ${name}:\n${tail(exists(join(dir, "containers", name, "out")), 100)}`,
    ),
  ];
  return parts.join("\n");
}

export function comment(login, body = "Deckhand") {
  return {
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    issue: { number: 12 },
    comment: { id: 99, body, user: { login, type: "User" } },
    sender: { login },
  };
}

// The agent's token in `name` of the sandbox's environment (sandbox-spec.mjs tokenEnv()),
// checked: for the agents' endpoints, of the same run as the run token.
export function agentTokenIn(runEnv, name, runToken) {
  const value = new RegExp(`^${name}=(.*)$`, "m").exec(runEnv)?.[1];
  assert.ok(value, `${name} in the sandbox's environment`);
  const claims = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  assert.equal(claims(value).aud, "deckhand:agents");
  assert.equal(claims(runToken).aud, "deckhand:broker");
  assert.equal(claims(value).jti, claims(runToken).jti);
  return value;
}

// "host {json}" lines the fake sandbox wrote → { host: answer }.
export function egressAnswers(dir) {
  const lines = readFileSync(join(dir, "egress"), "utf8").trim().split("\n");
  return Object.fromEntries(lines.map((l) => [l.split(" ")[0], JSON.parse(l.split(" ")[1])]));
}

export function allowedHosts(answers) {
  return Object.keys(answers).filter((h) => answers[h].allowed);
}

// Polls until `check()` is truthy (or resolves to it).
export async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function exists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export const replies = (github) =>
  github.requests.filter(
    (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
  );

// A follow-up comment on issue 12 (no trigger line), with its own id.
export function followUp(id, body) {
  const payload = comment("alice", body);
  payload.comment = { ...payload.comment, id };
  return payload;
}

// A listener whose sandbox waits (`hold`) before Claude's first answer, with a run started by
// a comment saying `body`; `files`: what its fake GitHub serves.
export async function holding(t, body, extra = () => ({}), files = {}) {
  const ctx = await listen(t, files, (dir, github) => {
    writeFileSync(join(dir, "hold"), "");
    return extra(dir, github);
  });
  await ctx.send(comment("alice", body));
  const egress = join(ctx.dir, "egress");
  await until(() => exists(egress)?.trim().split("\n").length === 10, "the sandbox");
  return ctx;
}

// The comments' outcome reactions: the last thing a finished run does, its reply posted.
export async function settled(github, ids) {
  for (const id of ids) {
    await github.waitFor(
      (r) => r.path === `/repos/org/repo/issues/comments/${id}/reactions` && /rocket/.test(r.body),
      `comment ${id}'s 🚀 (its run's end)`,
    );
  }
}

// The prompts of the runs so far, in order (the fake sandbox's log).
export const prompts = (dir) => (exists(join(dir, "prompts")) ?? "").split("----\n").slice(0, -1);
