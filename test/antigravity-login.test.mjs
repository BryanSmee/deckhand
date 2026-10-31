// The Antigravity CLI's plan login, held by the listener: refreshed by `agy` itself in a short
// container the runner starts (a fake docker here), once for concurrent calls, re-read when replaced, and a
// refused refresh says to sign in again. And its endpoint (google.mjs): the run's secret in,
// the plan's access token out, on the paths `agy` calls only.
import assert from "node:assert/strict";
import { chmodSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createAntigravityLogin } from "../listener/antigravity-login.mjs";
import { createDockerJobs } from "../listener/runner/jobs.mjs";
import { loginRefresh } from "../runner/service.mjs";
import { createBroker } from "../listener/broker.mjs";
import { createGoogleRelay } from "../listener/google.mjs";
import { sandboxAt, serve, tempDir } from "./helpers.mjs";

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

test("near its expiry: one refresh by `agy models` for concurrent calls, written back", async (t) => {
  const file = loginFile(t, tokenFile("ya29.old", "2026-10-17T12:04:00Z"));
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const { docker, calls } = fakeDocker(refreshed, gate);
  let installs = 0;
  const logs = [];
  const login = createAntigravityLogin({
    file,
    config,
    refresh: onDocker(docker, async () => installs++),
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
  // Written back for the next start, readable by the listener alone.
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token.access_token, "ya29.fresh");
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

test("a file the listener can't rewrite: refused before any refresh container", async (t) => {
  const file = loginFile(t, tokenFile("ya29.old", "2026-10-17T12:04:00Z"));
  chmodSync(dirname(file), 0o555);
  const { docker, calls } = fakeDocker(refreshed);
  let installs = 0;
  const login = createAntigravityLogin({
    file,
    config,
    refresh: onDocker(docker, async () => installs++),
    now: () => NOW,
  });
  await assert.rejects(login.headers(), (error) => {
    assert.match(
      error.message,
      /^AGY_AUTH_FILE \(.+\) must be in a folder the listener can write to \(EACCES\)/,
    );
    assert.match(error.message, /\/data\/credentials \(docs\/setup\.md#antigravity-cli\)/);
    assert.equal(error.status, 401);
    // Moving the file is the fix, not signing in again (upstream.mjs credentialFailure()).
    assert.equal(error.refused, false);
    return true;
  });
  assert.equal(calls.length, 0);
  assert.equal(installs, 0);
  chmodSync(dirname(file), 0o755); // for tempDir()'s cleanup
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
  const broker = createBroker({ sentFrom: sandboxAt() });
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
    broker,
    credential: options.credential ?? null,
    login: plan,
    upstream: () => options.upstream ?? google.url,
  });
  const { url } = await serve(t, (req, res) => endpoint.handle(req, res));
  // An Antigravity CLI run's secret, as runs.mjs registers it.
  const run = (provider = "google") => {
    const secret = broker.register("org/repo");
    broker.provide(secret, provider);
    return secret;
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

test("the run's secret is swapped for the plan's access token, the answer streamed back", async (t) => {
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
    "the operator's login for Google was refused, and must be signed in again: see the listener's log";
  assert.deepEqual(await refused.json(), {
    error: { status: "UNAVAILABLE", message: `Deckhand: ${message}` },
  });
  assert.equal(broken.google.requests.length, 0);
  assert.equal(broken.broker.runOf(brokenRun).apiError, message);
});

test("a login that can't be refreshed: its error stays in the listener's log, redacted", async (t) => {
  // What a failed refresh's message could quote: part of the token file (#242).
  const leak = new Error('can\'t be refreshed ({"token":{"access_token":"ya29.plan-access-tok');
  const logs = [];
  const google = await fakeGoogle(t);
  const broker = createBroker({ sentFrom: sandboxAt() });
  const endpoint = createGoogleRelay({
    broker,
    login: {
      headers: async () => Promise.reject(leak),
      refused: () => {},
      secrets: () => ["ya29.plan-access-token-0123456789", "1//refresh-token-0123456789"],
    },
    upstream: () => google.url,
    log: (line) => logs.push(line),
  });
  const { url } = await serve(t, (req, res) => endpoint.handle(req, res));
  const secret = broker.register("org/repo");
  broker.provide(secret, "google");
  const res = await call(
    url,
    "daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    secret,
  );
  assert.equal(res.status, 503);
  const message =
    "the operator's login for Google can't be refreshed right now: see the listener's log";
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
  // The runner has none (Kubernetes): no refresh, so nothing to install for one.
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
