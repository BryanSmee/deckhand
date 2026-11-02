// The Antigravity CLI's plan login, held by the models service: refreshed by `agy` itself in a
// short container the runner starts (a fake docker here), once for concurrent calls and every
// copy of the service, kept sealed in its store, re-read when replaced, and a refused refresh
// says to sign in again. And its endpoint (google.mjs): the run's agent token in,
// the plan's access token out, on the paths `agy` calls only.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../lib/store.mjs";
import { createAntigravityLogin } from "../models/antigravity-login.mjs";
import { loginSeal, REFRESH_MS } from "../models/logins.mjs";
import { createDockerJobs } from "../listener/runner/jobs.mjs";
import { LOGIN_REFRESH_MARGIN_MS, LOGIN_REFRESH_MS, MIN_REFRESH_MS } from "../lib/services.mjs";
import { createRunnerClient } from "../runner/client.mjs";
import { loginRefresh, REFRESH_BUDGET_MS } from "../runner/service.mjs";
import { createGoogleRelay } from "../models/google.mjs";
import { serve, tempDir, tokenBroker } from "./helpers.mjs";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const config = {
  image: "deckhand-sandbox",
  installNetwork: "bridge",
  agyVersion: "1.4.0",
  agyVolume: "deckhand-antigravity",
  agyLoginVolume: "deckhand-antigravity-login",
};

const tokenFile = (access, expiry, refresh = "1//refresh") => ({
  auth_method: "consumer",
  token: { access_token: access, token_type: "Bearer", refresh_token: refresh, expiry },
});

function loginFile(t, json) {
  const file = join(tempDir(t, "deckhand-agy-login-"), "antigravity-oauth-token");
  writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json));
  return file;
}

// A docker that plays `agy models`: it reads the file it is given and answers `answer(json)`
// ({ code, out, err }) once `gate` lets it.
function fakeDocker(answer, gate = Promise.resolve()) {
  const calls = [];
  const docker = async (args, { input } = {}) => {
    calls.push({ args, input: JSON.parse(input) });
    await gate;
    return answer(JSON.parse(input));
  };
  return { docker, calls };
}

// The runner's refresh (runner/service.mjs), with the Docker runner's jobs, on the fake.
const onDocker = (docker, install = async () => {}) =>
  loginRefresh({
    config,
    images: { installAgent: install },
    jobs: createDockerJobs({ config, docker }),
  });

const refreshed = (json) => ({
  code: 0,
  out: JSON.stringify({
    ...json,
    token: { ...json.token, access_token: "ya29.fresh", expiry: "2026-10-17T13:00:00.123456789Z" },
  }),
  err: "",
});

test("a token far from its expiry is used as it is: no container", async (t) => {
  const file = loginFile(t, tokenFile("ya29.current", "2026-10-17T12:30:00Z"));
  const { docker, calls } = fakeDocker(refreshed);
  const login = createAntigravityLogin({ file, config, refresh: onDocker(docker), now: () => NOW });
  assert.deepEqual(await login.headers(), { authorization: "Bearer ya29.current" });
  assert.equal(calls.length, 0);
  assert.deepEqual(login.secrets(), ["ya29.current", "1//refresh"]);
});

test("near its expiry: one refresh by `agy models` for concurrent calls, kept sealed in the store", async (t) => {
  const file = loginFile(t, tokenFile("ya29.old", "2026-10-17T12:04:00Z"));
  const store = openStore("memory:");
  const seal = loginSeal(randomBytes(32));
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const { docker, calls } = fakeDocker(refreshed, gate);
  let installs = 0;
  const logs = [];
  const login = createAntigravityLogin({
    file,
    config,
    refresh: onDocker(docker, async () => installs++),
    store,
    seal,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  const pending = [login.headers(), login.headers(), login.headers()];
  open();
  for (const headers of await Promise.all(pending)) {
    assert.deepEqual(headers, { authorization: "Bearer ya29.fresh" });
  }
  assert.equal(calls.length, 1);
  assert.equal(installs, 1);
  // A container of the sandbox image, on the login's volume, with the CLI read-only, outside
  // the runs' networks, as the sandbox's user with no capabilities.
  const [{ args, input }] = calls;
  assert.deepEqual(args.slice(0, 3), ["run", "--rm", "-i"]);
  for (const [flag, value] of [
    ["--network", "bridge"],
    ["--user", "1000:1000"],
    ["--cap-drop", "ALL"],
    ["--security-opt", "no-new-privileges"],
    ["-e", "AGY_VERSION=1.4.0"],
    ["-v", "deckhand-antigravity:/opt/antigravity:ro"],
    ["-v", "deckhand-antigravity-login:/home/node/.gemini"],
    ["--entrypoint", "deckhand-antigravity-refresh"],
  ]) {
    assert.ok(
      args.some((a, i) => a === flag && args[i + 1] === value),
      `${flag} ${value}`,
    );
  }
  assert.equal(args.at(-1), "deckhand-sandbox");
  // The file `agy` gets says its token expired, so that it refreshes it.
  assert.equal(input.token.expiry, "2000-01-01T00:00:00Z");
  assert.equal(input.token.refresh_token, "1//refresh");
  // Kept for the next start, sealed in the store; the file left as it was.
  const raw = await store.get("login:antigravity");
  assert.equal(raw.kid, seal.kid);
  assert.ok(!raw.sealed.includes("ya29.fresh"));
  assert.equal(JSON.parse(seal.open(raw.sealed)).login.token.access_token, "ya29.fresh");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token.access_token, "ya29.old");
  assert.match(logs.join("\n"), /refreshed the Google AI plan's login/);
  // Fresh now: no second refresh.
  await login.headers();
  assert.equal(calls.length, 1);
});

test("a token Google refused is refreshed on the next call, once", async (t) => {
  const file = loginFile(t, tokenFile("ya29.current", "2026-10-17T12:30:00Z"));
  const { docker, calls } = fakeDocker(refreshed);
  const login = createAntigravityLogin({ file, config, refresh: onDocker(docker), now: () => NOW });
  await login.headers();
  login.refused("Bearer someone-else");
  await login.headers();
  assert.equal(calls.length, 0);
  login.refused("Bearer ya29.current");
  assert.deepEqual(await login.headers(), { authorization: "Bearer ya29.fresh" });
  assert.equal(calls.length, 1);
});

test("a read-only file: refreshed all the same, never written", async (t) => {
  const file = loginFile(t, tokenFile("ya29.old", "2026-10-17T12:04:00Z"));
  chmodSync(file, 0o444);
  const { docker, calls } = fakeDocker(refreshed);
  const login = createAntigravityLogin({ file, config, refresh: onDocker(docker), now: () => NOW });
  assert.deepEqual(await login.headers(), { authorization: "Bearer ya29.fresh" });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token.access_token, "ya29.old");
});

// What the refresh container prints on stderr when it fails: `agy`'s error, then the line of
// its log that says why (sandbox/agents/antigravity/refresh), as agy 1.4.0 writes them.
const failedRefresh = (why) =>
  "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n" +
  `W1017 16:56:24.057221     341 browser.go:258] token refresh failed: ${why}`;

test("a refused refresh says to sign in again, until the file is replaced", async (t) => {
  const file = loginFile(t, tokenFile("ya29.old", "2026-10-17T11:00:00Z"));
  const spent = (json) => ({
    code: 1,
    out: JSON.stringify(json),
    err: failedRefresh('oauth2: "invalid_grant" "Token has been expired or revoked."'),
  });
  const { docker, calls } = fakeDocker(spent);
  const login = createAntigravityLogin({ file, config, refresh: onDocker(docker), now: () => NOW });
  await assert.rejects(login.headers(), (error) => {
    assert.match(error.message, /can't be refreshed \(W1017 [^]*oauth2: "invalid_grant"/);
    assert.match(error.message, /sign in with `agy` again for AGY_AUTH_FILE/);
    assert.equal(error.status, 401);
    assert.equal(error.refused, true);
    return true;
  });
  // Spent for good: no container again for the next calls.
  await assert.rejects(login.headers(), /sign in with `agy` again/);
  assert.equal(calls.length, 1);

  // A new sign-in replaces the file: read again, used as it is.
  writeFileSync(file, JSON.stringify(tokenFile("ya29.new", "2026-10-17T13:00:00Z")));
  utimesSync(file, new Date(NOW), new Date(NOW + 1000));
  assert.deepEqual(await login.headers(), { authorization: "Bearer ya29.new" });
});

test("a refresh that failed otherwise is retried by the next call", async (t) => {
  const file = loginFile(t, tokenFile("ya29.old", "2026-10-17T11:00:00Z"));
  let answer = () => ({
    code: 125,
    out: "",
    err: "docker: Error response from daemon: no such image",
  });
  const { docker, calls } = fakeDocker((json) => answer(json));
  const login = createAntigravityLogin({ file, config, refresh: onDocker(docker), now: () => NOW });
  await assert.rejects(login.headers(), (error) => {
    assert.match(error.message, /can't be refreshed \(docker: Error response from daemon/);
    assert.doesNotMatch(error.message, /sign in/);
    return true;
  });
  // Google out of reach: `agy` says to sign in, but the login isn't spent.
  answer = (json) => ({
    code: 1,
    out: JSON.stringify(json),
    err: failedRefresh('Post "https://oauth2.googleapis.com/token": Forbidden'),
  });
  await assert.rejects(login.headers(), (error) => {
    assert.match(error.message, /can't be refreshed \(.*Forbidden\)$/);
    assert.doesNotMatch(error.message, /again/);
    return true;
  });
  // `agy` exited fine but left the token as it was: not refreshed either.
  answer = (json) => ({ code: 0, out: JSON.stringify(json), err: "" });
  await assert.rejects(login.headers(), /can't be refreshed/);
  answer = refreshed;
  assert.deepEqual(await login.headers(), { authorization: "Bearer ya29.fresh" });
  assert.equal(calls.length, 4);
});

test("a refresh that fails with nothing on stderr: no part of the token file in its message", async (t) => {
  const file = loginFile(t, tokenFile("ya29.old-access-token-0123456789", "2026-10-17T11:00:00Z"));
  // An older refresh script printed the file whatever happened: never quoted, even so (#242).
  const { docker } = fakeDocker((json) => ({ code: 1, out: JSON.stringify(json), err: "" }));
  const login = createAntigravityLogin({ file, config, refresh: onDocker(docker), now: () => NOW });
  await assert.rejects(login.headers(), (error) => {
    assert.equal(
      error.message,
      "the Antigravity CLI's login can't be refreshed (exit 1, nothing on stderr)",
    );
    return true;
  });
});

test("a file without a login is refused, naming it", async (t) => {
  for (const json of ["not json", { token: { access_token: "x" } }]) {
    const file = loginFile(t, json);
    const login = createAntigravityLogin({
      file,
      config,
      refresh: onDocker(fakeDocker(refreshed).docker),
    });
    await assert.rejects(login.headers(), (error) => {
      assert.equal(
        error.message,
        `${file} holds no Antigravity CLI login (sign in with \`agy\` for one, docs/setup.md)`,
      );
      return true;
    });
  }
});

// --- The endpoint ------------------------------------------------------------------------------

// A fake Google that records each request and streams its answer; `status` answers instead.
async function fakeGoogle(t, status = 200) {
  const requests = [];
  const { url } = await serve(t, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { "content-type": "text/event-stream" });
      res.write('data: {"candidates":[]}\n\n');
      res.end('data: {"done":true}\n\n');
    });
  });
  return { url, requests };
}

async function relay(t, options = {}) {
  const google = await fakeGoogle(t, options.status);
  const broker = tokenBroker();
  const refusedTokens = [];
  // `login: null`: the operator set none.
  const plan =
    "login" in options
      ? options.login
      : {
          headers: async () => ({ authorization: "Bearer ya29.plan" }),
          refused: (authorization) => refusedTokens.push(authorization),
          secrets: () => ["ya29.plan", "1//refresh"],
        };
  const endpoint = createGoogleRelay({
    runs: broker,
    credential: options.credential ?? null,
    login: plan,
    upstream: () => options.upstream ?? google.url,
  });
  const { url } = await serve(t, (req, res) => endpoint.handle(req, res));
  // An Antigravity CLI run's agent token, as runs.mjs registers it.
  const run = (provider = "google") => {
    const id = broker.register("org/repo");
    broker.provide(id, provider);
    return broker.agentToken(id);
  };
  return { url, google, run, endpoint, refusedTokens, broker };
}

const call = (url, path, secret, init = {}) =>
  fetch(`${url}/relay/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: '{"model":"gemini-4-argon-high"}',
    ...init,
  });

test("the run's agent token is swapped for the plan's access token, the answer streamed back", async (t) => {
  const { url, google, run, endpoint } = await relay(t);
  const secret = run();
  const res = await call(
    url,
    "daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    secret,
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'data: {"candidates":[]}\n\ndata: {"done":true}\n\n');
  const [sent] = google.requests;
  assert.equal(sent.url, "/v1internal:streamGenerateContent?alt=sse");
  assert.equal(sent.headers.authorization, "Bearer ya29.plan");
  assert.equal(sent.body, '{"model":"gemini-4-argon-high"}');
  assert.ok(!JSON.stringify(sent).includes(secret));
  // userinfo too, on its own host.
  const me = await call(url, "www.googleapis.com/oauth2/v2/userinfo", secret, {
    method: "GET",
    body: undefined,
  });
  assert.equal(me.status, 200);
  await me.text();
  assert.equal(google.requests[1].url, "/oauth2/v2/userinfo");
  assert.deepEqual(endpoint.secrets(), ["ya29.plan", "1//refresh"]);
});

test("a wrong secret, another agent's run or another path is refused, Google not called", async (t) => {
  const { url, google, run } = await relay(t);
  const generate = "daily-cloudcode-pa.googleapis.com/v1internal:generateContent";
  const wrong = await call(url, generate, "not-a-run");
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), {
    error: { status: "UNAUTHENTICATED", message: "Deckhand: unknown or finished run" },
  });
  const codex = await call(url, generate, run("openai"));
  assert.equal(codex.status, 503);
  assert.match((await codex.json()).error.message, /not a run of the Antigravity CLI/);
  const secret = run();
  for (const path of [
    "www.googleapis.com/drive/v3/files",
    "www.googleapis.com/oauth2/v2/userinfo/../../drive/v3/files",
    "daily-cloudcode-pa.googleapis.com/v1/projects",
    "play.googleapis.com/log",
    "evil.example/v1internal:generateContent",
  ]) {
    const res = await call(url, path, secret);
    assert.equal(res.status, 404, path);
    await res.text();
  }
  // Another method on agy's own paths.
  for (const [method, path] of [
    ["GET", generate],
    ["DELETE", generate],
    ["POST", "www.googleapis.com/oauth2/v2/userinfo"],
  ]) {
    const res = await call(
      url,
      path,
      secret,
      method === "GET" ? { method, body: undefined } : { method },
    );
    assert.equal(res.status, 404, `${method} ${path}`);
    await res.text();
  }
  assert.equal(google.requests.length, 0);
});

test("Google's 401 marks the plan's token for a refresh; a spent login refuses the call", async (t) => {
  const { url, run, refusedTokens, broker } = await relay(t, { status: 401 });
  const secret = run();
  const res = await call(
    url,
    "daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    secret,
  );
  assert.equal(res.status, 401);
  await res.text();
  assert.deepEqual(refusedTokens, ["Bearer ya29.plan"]);
  // What the run's reply says, whatever agy makes of it (#224).
  assert.equal(broker.runOf(secret).apiError, "Google answered 401");

  const spent = Object.assign(new Error("sign in with `agy` again for AGY_AUTH_FILE"), {
    status: 401,
    refused: true,
  });
  const broken = await relay(t, {
    login: { headers: async () => Promise.reject(spent), refused: () => {}, secrets: () => [] },
  });
  const brokenRun = broken.run();
  const refused = await call(
    broken.url,
    "daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    brokenRun,
  );
  assert.equal(refused.status, 503);
  const message =
    "the operator's login for Google was refused, and must be signed in again: see the models service's log";
  assert.deepEqual(await refused.json(), {
    error: { status: "UNAVAILABLE", message: `Deckhand: ${message}` },
  });
  assert.equal(broken.google.requests.length, 0);
  assert.equal(broken.broker.runOf(brokenRun).apiError, message);
});

test("a login that can't be refreshed: its error stays in the models service's log, redacted", async (t) => {
  // What a failed refresh's message could quote: part of the token file (#242).
  const leak = new Error('can\'t be refreshed ({"token":{"access_token":"ya29.plan-access-tok');
  const logs = [];
  const google = await fakeGoogle(t);
  const broker = tokenBroker();
  const endpoint = createGoogleRelay({
    runs: broker,
    login: {
      headers: async () => Promise.reject(leak),
      refused: () => {},
      secrets: () => ["ya29.plan-access-token-0123456789", "1//refresh-token-0123456789"],
    },
    upstream: () => google.url,
    log: (line) => logs.push(line),
  });
  const { url } = await serve(t, (req, res) => endpoint.handle(req, res));
  const secret = broker.agentToken(broker.register("org/repo"));
  broker.provide(secret, "google");
  const res = await call(
    url,
    "daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    secret,
  );
  assert.equal(res.status, 503);
  const message =
    "the operator's login for Google can't be refreshed right now: see the models service's log";
  assert.equal((await res.json()).error.message, `Deckhand: ${message}`);
  assert.equal(broker.runOf(secret).apiError, message);
  assert.equal(broker.runOf(secret).apiStatus, 502);
  assert.deepEqual(logs, ['Google: can\'t be refreshed ({"token":{"access_token":"[redacted]']);
});

test("no plan's login: the model list is refused, the run told why", async (t) => {
  const { url, google, run, broker } = await relay(t, { login: null });
  const secret = run();
  const res = await call(
    url,
    "daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    secret,
  );
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /the operator set no AGY_AUTH_FILE/);
  assert.equal(broker.runOf(secret).apiError, "the operator set no AGY_AUTH_FILE");
  assert.equal(google.requests.length, 0);
});

test("with GEMINI_API_KEY: /google/ swaps x-goog-api-key for the operator's key, under GEMINI_BASE_URL", async (t) => {
  const google = await fakeGoogle(t);
  const { url, run, endpoint } = await relay(t, {
    credential: "AIza-operator-key",
    login: null,
    upstream: `${google.url}/gemini`,
  });
  const secret = run();
  const res = await fetch(
    `${url}/google/v1beta/models/gemini-3.8-flash-medium:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "x-goog-api-key": secret, "content-type": "application/json" },
      body: '{"contents":[]}',
    },
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'data: {"candidates":[]}\n\ndata: {"done":true}\n\n');
  const [sent] = google.requests;
  assert.equal(
    sent.url,
    "/gemini/v1beta/models/gemini-3.8-flash-medium:streamGenerateContent?alt=sse",
  );
  assert.equal(sent.headers["x-goog-api-key"], "AIza-operator-key");
  assert.ok(!JSON.stringify(sent).includes(secret));
  assert.deepEqual(endpoint.secrets(), ["AIza-operator-key"]);

  // Wrong secret, wrong provider, or a path outside /v1(beta)/ is refused; /relay/ is off when
  // GEMINI_API_KEY is set.
  const wrong = await fetch(`${url}/google/v1beta/models/gemini-3.8-flash-medium:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": "not-a-run" },
  });
  assert.equal(wrong.status, 401);
  await wrong.text();
  for (const bad of [
    "/google/v1beta/models/../../other",
    "/google//evil.example/v1beta/models/x",
    "/google/other/path",
  ]) {
    const r = await fetch(`${url}${bad}`, { headers: { "x-goog-api-key": secret } });
    assert.equal(r.status, 404, bad);
    await r.text();
  }
  const relayed = await call(
    url,
    "daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    secret,
  );
  assert.equal(relayed.status, 503);
  await relayed.text();
  assert.equal(google.requests.length, 1);
});

test("with GEMINI_API_KEY: only agy's calls go on, not files, cached contents or another method", async (t) => {
  const { url, run, google } = await relay(t, { credential: "AIza-operator-key", login: null });
  const secret = run();
  const send = (method, path) =>
    fetch(`${url}/google/${path}`, {
      method,
      headers: { "x-goog-api-key": secret },
      body: method === "POST" ? "{}" : undefined,
    }).then(async (r) => (await r.text(), r.status));
  for (const [method, path] of [
    ["GET", "v1beta/files"],
    ["POST", "v1beta/files"],
    ["POST", "v1beta/cachedContents"],
    ["POST", "v1beta/tunedModels"],
    ["POST", "v1beta/models/gemini-3.8-flash:batchGenerateContent"],
    ["DELETE", "v1beta/models/gemini-3.8-flash"],
    ["GET", "v1beta/models/gemini-3.8-flash:generateContent"],
  ]) {
    assert.equal(await send(method, path), 404, `${method} ${path}`);
  }
  assert.equal(google.requests.length, 0);
  for (const [method, path] of [
    ["POST", "v1beta/models/gemini-3.8-flash:generateContent"],
    ["POST", "v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"],
    ["POST", "v1/models/gemini-3.8-flash:countTokens"],
    ["GET", "v1beta/models?pageSize=50"],
    ["GET", "v1beta/models/gemini-3.8-flash"],
  ]) {
    assert.equal(await send(method, path), 200, `${method} ${path}`);
  }
  assert.equal(google.requests.length, 5);
});

test("a runner without short containers refuses the refresh, naming itself: nothing installed", async (t) => {
  const file = loginFile(t, tokenFile("ya29.old", "2026-10-17T12:04:00Z"));
  let installs = 0;
  // The runner has none: no refresh, so nothing to install for one.
  const refresh = loginRefresh({ config, images: { installAgent: () => installs++ }, jobs: {} });
  assert.equal(refresh, null);
  const login = createAntigravityLogin({
    file,
    config: { ...config, runner: "other" },
    refresh,
    now: () => NOW,
  });
  await assert.rejects(login.headers(), /the other runner runs no login refresh/);
  assert.equal(installs, 0);
});

test("the refresh's job ends within the models service's lease, its agent's install counted", async () => {
  let at = 0;
  const jobs = [];
  const refresh = loginRefresh({
    config,
    // A first install takes a minute.
    images: { installAgent: async () => (at += 60_000) },
    jobs: { run: async (job) => (jobs.push(job), { code: 0, out: "{}", err: "" }) },
    now: () => at,
  });
  await refresh("{}");
  assert.equal(jobs[0].timeoutMs, REFRESH_BUDGET_MS - 60_000);
  assert.ok(REFRESH_BUDGET_MS < LOGIN_REFRESH_MS);
  assert.equal(REFRESH_MS, LOGIN_REFRESH_MS);
  // What it may reach: Google's OAuth and the CLI's own hosts, never its telemetry.
  assert.ok(jobs[0].hosts.includes("oauth2.googleapis.com"));
  assert.ok(!jobs[0].hosts.includes("play.googleapis.com"));
});

test("a refresh that reaches the runner late gets what is left of the lease, none with too little", async () => {
  let at = 0;
  const jobs = [];
  let installs = 0;
  let installMs = 0;
  const refresh = loginRefresh({
    config,
    images: { installAgent: async () => (installs++, (at += installMs)) },
    jobs: { run: async (job) => (jobs.push(job), { code: 0, out: "{}", err: "" }) },
    now: () => at,
  });
  // Half the lease spent on a runner handover's 503s: the rest, less the margin.
  await refresh("{}", { timeoutMs: 150_000 });
  assert.equal(jobs.at(-1).timeoutMs, 150_000 - LOGIN_REFRESH_MARGIN_MS);
  // More than the runner's own budget: its budget.
  await refresh("{}", { timeoutMs: 10 * 60_000 });
  assert.equal(jobs.at(-1).timeoutMs, REFRESH_BUDGET_MS);
  // Too little left: nothing installed, no job, a failure the models service retries later.
  const late = await refresh("{}", {
    timeoutMs: LOGIN_REFRESH_MARGIN_MS + MIN_REFRESH_MS - 1000,
  });
  assert.equal(late.code, -1);
  assert.match(late.err, /too little of the models service's hold on the login is left/);
  assert.equal(jobs.length, 2);
  assert.equal(installs, 2);
  // Enough at first, but the agent's install takes it: no job either.
  installMs = 40_000;
  const installed = await refresh("{}", {
    timeoutMs: LOGIN_REFRESH_MARGIN_MS + MIN_REFRESH_MS + 20_000,
  });
  assert.equal(installed.code, -1);
  assert.equal(jobs.length, 2);
});

test("the models service tells the runner what is left of its lease, and asks again only within it", async (t) => {
  // The lease taken at NOW: the refresh is asked with all of it left.
  const file = loginFile(t, tokenFile("ya29.old", "2026-10-17T12:04:00Z"));
  const asked = [];
  const login = createAntigravityLogin({
    file,
    config,
    refresh: async (input, options) => {
      asked.push(options);
      return refreshed(JSON.parse(input));
    },
    now: () => NOW,
  });
  await login.headers();
  assert.deepEqual(asked, [{ timeoutMs: REFRESH_MS }]);

  // The runner answers 503 (a handover): asked again only while the job could still start,
  // each try saying what is left of the lease then.
  let at = 0;
  const tries = [];
  const runner = createRunnerClient({
    urls: "http://runner.test",
    token: async () => "Bearer t",
    epoch: () => null,
    now: () => at,
    sleep: async (ms) => (at += ms),
    fetch: async (url, init) => {
      tries.push({ at, body: JSON.parse(init.body) });
      return new Response("draining", { status: 503 });
    },
  });
  await assert.rejects(runner.refreshLogin("{}", { timeoutMs: REFRESH_MS }), /didn't answer/);
  assert.ok(tries.length > 3, `${tries.length} tries`);
  for (const { at: sent, body } of tries) {
    // What is left at that try, never the lease's whole length again.
    assert.equal(body.timeoutMs, REFRESH_MS - sent);
    assert.ok(body.timeoutMs >= LOGIN_REFRESH_MARGIN_MS + MIN_REFRESH_MS, `${body.timeoutMs} ms`);
  }
  // No try once too little is left for the job.
  assert.ok(at <= REFRESH_MS - LOGIN_REFRESH_MARGIN_MS - MIN_REFRESH_MS, `${at} ms`);
});

test("a refresh that waits on a runner handover still ends within the models service's lease", async () => {
  // The models service takes the lease at 0; the runner answers 503 for 3 minutes, then
  // takes the call: the job it starts must end before the lease does, its margin kept.
  let at = 0;
  const handover = 180_000;
  const jobs = [];
  const refresh = loginRefresh({
    config,
    images: { installAgent: async () => {} },
    jobs: { run: async (job) => (jobs.push({ at, ...job }), { code: 0, out: "{}", err: "" }) },
    now: () => at,
  });
  const runner = createRunnerClient({
    urls: "http://runner.test",
    token: async () => "Bearer t",
    epoch: () => null,
    now: () => at,
    sleep: async (ms) => (at += ms),
    fetch: async (url, init) => {
      if (at < handover) return new Response("draining", { status: 503 });
      const { input, timeoutMs } = JSON.parse(init.body);
      return Response.json(await refresh(input, { timeoutMs }));
    },
  });
  const result = await runner.refreshLogin("{}", { timeoutMs: REFRESH_MS });
  assert.equal(result.code, 0);
  const [job] = jobs;
  assert.ok(job.at >= handover);
  assert.ok(
    job.at + job.timeoutMs <= REFRESH_MS - LOGIN_REFRESH_MARGIN_MS,
    `ends at ${job.at + job.timeoutMs} ms`,
  );
});

test("the refresh moves on to the runner's next copy when the first doesn't answer", async () => {
  let at = 0;
  const tries = [];
  const runner = createRunnerClient({
    // Two copies: the first passive (or gone after a handover), the second acting.
    urls: "http://a.test:8080,http://b.test:8080",
    token: async () => "Bearer t",
    epoch: () => null,
    now: () => at,
    sleep: async (ms) => (at += ms),
    fetch: async (url, init) => {
      tries.push({ host: new URL(url).host, body: JSON.parse(init.body) });
      if (url.startsWith("http://a.test")) return new Response("passive", { status: 503 });
      return Response.json({ code: 0, out: "{}", err: "" });
    },
  });
  assert.deepEqual(await runner.refreshLogin("{}", { timeoutMs: REFRESH_MS }), {
    code: 0,
    out: "{}",
    err: "",
  });
  assert.deepEqual(
    tries.map((t) => t.host),
    ["a.test:8080", "b.test:8080"],
  );
  // The second try says what is left then, less than at the first.
  assert.equal(tries[0].body.timeoutMs, REFRESH_MS);
  assert.equal(tries[1].body.timeoutMs, REFRESH_MS - at);
  assert.ok(tries[1].body.timeoutMs < REFRESH_MS);
});
