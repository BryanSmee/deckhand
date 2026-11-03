#!/usr/bin/env node
// The outside world of the end-to-end check on a cluster (run.sh): GitHub (`github`: its REST
// API, and a repository over git's smart HTTP) and Anthropic's Messages API (`anthropic`: a
// scripted model). Both listen on 443, over HTTPS with the certificate run.sh made (TLS_DIR:
// tls.crt, tls.key), as the egress proxy relays GitHub's host over HTTPS only and the services'
// NetworkPolicies let them out on 443 alone. GET /__requests, on 8080 in plain HTTP (run.sh's
// `kubectl exec`, from the pod itself), answers what each was asked, and GET /__problems what
// the model saw go wrong (a command that failed, a call made again) and how many turns' calls
// all answered, for run.sh's checks.
//
//   node fakes.mjs github|anthropic
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const role = process.argv[2];
const PORT = Number(process.env.PORT || 443);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8080);
const TLS_DIR = process.env.TLS_DIR || "/tls";
// The mid-run comment's marker (run.sh's, random): the model names it in its last answer once a
// message holds it, whatever its role or block (Claude Code passes a comment sent mid-run as a
// system message).
const MARKER = /MIDRUN-[A-Za-z0-9]+/;
const requests = [];
// Whether the model may finish (POST /__release, once run.sh's rollouts are done): until then it
// runs one more short command each turn, so the run's calls go on through the whole update.
let released = false;
const MAX_ROUNDS = 120;
// What went wrong in the run, as the model sees it: a held turn's command that failed (its calls
// through the egress proxy), or a call whose messages an earlier one had (Claude Code tries a
// failed API call again by itself, which would otherwise pass unseen).
const problems = [];
const asked = new Set(); // the messages of each call with tools
const failed = new Set(); // the tool results already counted
const answered = new Set(); // the held turns whose calls all answered

function handle(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    // run.sh's endpoints, on the control port alone: a service that reaches the fake can't
    // release the model or read what it saw.
    const control = req.socket.localPort === CONTROL_PORT;
    if (control && req.url === "/__requests") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(requests));
    }
    if (control && req.url === "/__problems") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ problems, turns: answered.size }));
    }
    if (control && req.url === "/__release" && req.method === "POST") {
      released = true;
      return res.end("released\n");
    }
    const entry = { at: new Date().toISOString(), method: req.method, path: req.url };
    if (!/git-(upload|receive)-pack/.test(req.url)) entry.body = body.toString("utf8");
    requests.push(entry);
    console.log(`${req.method} ${req.url}`);
    (role === "github" ? github : anthropic)(req, res, body, entry);
  });
}

// GitHub ---------------------------------------------------------------------------------------

const REPO = process.env.REPO || "org/repo";
const ISSUE = Number(process.env.ISSUE || 12);
const git = mkdtempSync(join(tmpdir(), "git-"));
let commentId = 1000;
// The installation's permissions: every one a run's token may ask for.
const PERMISSIONS = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
  actions: "write",
  checks: "read",
  statuses: "read",
  workflows: "write",
};

// org/repo.git, with one commit on main.
function makeRepo() {
  const bare = join(git, `${REPO}.git`);
  mkdirSync(bare, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "work-"));
  const run = (args, cwd) => execFileSync("git", args, { cwd, stdio: "inherit" });
  run(["init", "-q", "--bare", "-b", "main", bare]);
  run(["config", "http.receivepack", "true"], bare);
  run(["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), "# A repository for Deckhand's end-to-end check\n");
  run(["add", "."], work);
  run(["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "First"], work);
  run(["push", "-q", bare, "main"], work);
}

// git's smart HTTP through git-http-backend, as CGI.
function gitBackend(req, res, body) {
  const url = new URL(req.url, "http://x");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: git,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname.replace(/^\/([^/]+\/[^/]+?)(\.git)?\//, "/$1.git/"),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] || "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: "x-access-token",
      HTTP_GIT_PROTOCOL: req.headers["git-protocol"] || "",
    },
  });
  child.stdin.end(body);
  const out = [];
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.pipe(process.stderr);
  child.on("close", () => {
    const all = Buffer.concat(out);
    const split = all.indexOf("\r\n\r\n");
    const head = all.subarray(0, split).toString();
    let status = 200;
    for (const line of head.split("\r\n")) {
      const [name, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else res.setHeader(name, value);
    }
    res.writeHead(status).end(all.subarray(split + 4));
  });
}

const json = (res, value, status = 200) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

function github(req, res, body) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/api\/v3/, "");
  if (/\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) {
    return gitBackend(req, res, body);
  }
  const repo = `/repos/${REPO}`;
  const owner = { login: REPO.split("/")[0], type: "Organization" };
  const issue = {
    id: 1,
    node_id: "I_1",
    number: ISSUE,
    title: "End-to-end check",
    body: "An issue Deckhand's end-to-end check comments on.",
    state: "open",
    user: { login: "alice", type: "User" },
    labels: [],
    assignees: [],
    html_url: `http://github/${REPO}/issues/${ISSUE}`,
  };
  const routes = [
    ["GET", /^\/app$/, () => ({ id: 1, slug: "deckhand-e2e", name: "deckhand-e2e", owner })],
    ["GET", /^\/app\/installations$/, () => [{ id: 7, account: owner }]],
    [
      "GET",
      /^\/app\/installations\/7$/,
      () => ({ id: 7, account: owner, permissions: PERMISSIONS }),
    ],
    ["GET", new RegExp(`^${repo}/installation$`), () => ({ id: 7, account: owner })],
    [
      "POST",
      /^\/app\/installations\/7\/access_tokens$/,
      () => ({
        token: "ghs_e2e",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: PERMISSIONS,
      }),
    ],
    [
      "GET",
      /^\/installation\/repositories$/,
      () => ({ total_count: 1, repositories: [repository()] }),
    ],
    ["GET", new RegExp(`^${repo}$`), () => repository()],
    ["GET", new RegExp(`^${repo}/issues/${ISSUE}$`), () => issue],
    ["GET", new RegExp(`^/users/[^/]+$`), () => ({ login: "alice", type: "User" })],
    [
      "POST",
      new RegExp(`^${repo}/issues/\\d+/comments$`),
      () => {
        const id = ++commentId;
        const html_url = `http://github/${REPO}/issues/${ISSUE}#issuecomment-${id}`;
        return { id, html_url, body: JSON.parse(body).body, user: { login: "deckhand[bot]" } };
      },
    ],
    [
      "PATCH",
      new RegExp(`^${repo}/issues/comments/\\d+$`),
      () => ({ id: Number(path.split("/").pop()), body: JSON.parse(body).body }),
    ],
    ["POST", /\/reactions$/, () => ({ id: ++commentId, content: JSON.parse(body).content })],
    ["POST", /^\/graphql$/, () => ({ data: {} })],
  ];
  for (const [method, pattern, answer] of routes) {
    if (req.method === method && pattern.test(path)) return json(res, answer());
  }
  // Lists GitHub would page: empty. Anything else: not found, as GitHub answers for what isn't
  // there (a .deckhand.yaml, a branch, a pull request).
  if (
    req.method === "GET" &&
    (url.searchParams.has("per_page") || /\/(comments|events|labels)$/.test(path))
  ) {
    return json(res, []);
  }
  if (req.method === "GET") return json(res, { message: "Not Found" }, 404);
  json(res, { id: ++commentId });
}

const repository = () => ({
  id: 1,
  node_id: "R_1",
  name: REPO.split("/")[1],
  full_name: REPO,
  owner: { login: REPO.split("/")[0], type: "Organization" },
  private: false,
  default_branch: "main",
  has_issues: true,
  html_url: `http://github/${REPO}`,
  clone_url: `http://github/${REPO}.git`,
  permissions: { admin: false, push: true, pull: true },
});

// Anthropic --------------------------------------------------------------------------------------

// The model's script, from the request: a command each turn that calls GitHub through the egress
// proxy (git's, and gh's through the GitHub gateway) and waits 20 s (time for run.sh's mid-run
// comment, then its rollouts, each turn a call through the models service), then, once released,
// an answer naming the marker if a message holds it. Calls without tools (a title, a summary)
// get a short text.
function anthropic(req, res, body) {
  const url = new URL(req.url, "http://x");
  if (req.method !== "POST" || !url.pathname.endsWith("/v1/messages")) {
    if (url.pathname.endsWith("/count_tokens")) return json(res, { input_tokens: 10 });
    return json(res, { type: "error", error: { type: "not_found_error", message: "no" } }, 404);
  }
  const request = JSON.parse(body.toString("utf8"));
  const users = request.messages.filter((m) => m.role === "user");
  const toolResults = users.flatMap((m) =>
    typeof m.content === "string" ? [] : m.content.filter((c) => c.type === "tool_result"),
  );
  const tools = (request.tools ?? []).map((t) => t.name);
  if (tools.includes("Bash")) noteProblems(request.messages, toolResults);
  const marker = JSON.stringify(request.messages).match(MARKER)?.[0];
  let answer;
  if (!tools.includes("Bash")) answer = { text: "E2E check" };
  else if (marker && released) {
    answer = { text: `All done. The comment sent mid-run reached me: ${marker}.` };
  } else if (toolResults.length < MAX_ROUNDS) {
    answer = {
      tool: {
        name: "Bash",
        input: {
          command: HELD,
          description: "Call GitHub for 20 seconds",
          timeout: 300000,
        },
      },
    };
  } else answer = { text: "Waited 40 minutes, and no comment came meanwhile." };
  return request.stream
    ? stream(res, answer, request.model)
    : json(res, message(answer, request.model));
}

// A held turn's command: for 20 s, git's call and gh's every 2 s, each through the egress proxy,
// so that the calls go on through the update; the first that fails ends it in error. gh is the
// real one with the run's token, as the sandbox's wrapper gives it, for the fake's host
// (GH_HOST), which the wrapper's GH_TOKEN doesn't cover.
const HELD = [
  "host=$(git remote get-url origin | sed 's|^https://||; s|/.*||')",
  "for i in $(seq 10); do",
  "  git ls-remote origin HEAD > /dev/null || exit 1;",
  `  GH_HOST=$host GH_ENTERPRISE_TOKEN=$(deckhand-token) /usr/bin/gh api repos/${REPO} --jq .full_name > /dev/null || exit 1;`,
  "  sleep 2;",
  'done; echo "GitHub answered $i times"',
].join("\n");

function noteProblems(messages, toolResults) {
  const key = JSON.stringify(messages);
  if (asked.has(key)) problems.push(`a call made again, after ${toolResults.length} turns`);
  asked.add(key);
  for (const result of toolResults) {
    const text =
      typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    // Claude Code says a command's exit code in its result, an error or not.
    const error = result.is_error || /Exit code [1-9]/.test(text);
    if (!error && text.includes("GitHub answered 10 times")) answered.add(result.tool_use_id);
    if (!error || failed.has(result.tool_use_id)) continue;
    failed.add(result.tool_use_id);
    problems.push(`a command failed: ${text.slice(0, 500)}`);
  }
}

let ids = 0;
const content = ({ text, tool }) =>
  tool
    ? { type: "tool_use", id: `toolu_e2e${++ids}`, name: tool.name, input: tool.input }
    : { type: "text", text };

const message = (answer, model) => ({
  id: `msg_e2e${++ids}`,
  type: "message",
  role: "assistant",
  model,
  content: [content(answer)],
  stop_reason: answer.tool ? "tool_use" : "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

function stream(res, answer, model) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const whole = message(answer, model);
  send("message_start", {
    message: {
      ...whole,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  const block = whole.content[0];
  if (block.type === "text") {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
  } else {
    send("content_block_start", { index: 0, content_block: { ...block, input: {} } });
    const partial_json = JSON.stringify(block.input);
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json } });
  }
  send("content_block_stop", { index: 0 });
  send("message_delta", {
    delta: { stop_reason: whole.stop_reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send("message_stop", {});
  res.end();
}

if (role === "github") makeRepo();
else if (role !== "anthropic") throw new Error(`expected github or anthropic, got ${role}`);
const tls = {
  cert: readFileSync(join(TLS_DIR, "tls.crt")),
  key: readFileSync(join(TLS_DIR, "tls.key")),
};
createTlsServer(tls, handle).listen(PORT, () => console.log(`fake ${role} on ${PORT} (HTTPS)`));
createServer(handle).listen(CONTROL_PORT, "127.0.0.1");
