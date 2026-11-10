// The orchestrator end to end, its runs (orchestrator-harness.mjs has the harness): deliveries,
// the agents' credentials and providers, a repo's config and hosts, /cancel.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openStore } from "../lib/store.mjs";
import { until as waitUntil } from "./helpers.mjs";
import {
  RW_MOUNT,
  SECRET,
  agentTokenIn,
  allowedHosts,
  comment,
  egressAnswers,
  exists,
  followUp,
  holding,
  listen,
  liveStates,
  onlyLog,
  options,
  replies,
  runLogs,
  settled,
  storedMap,
  summaries,
  until,
  writeGrant,
  writeGrants,
} from "./orchestrator-harness.mjs";

describe("listener", options, () => {
  // #680: GitHub's short hiccups are tried again by the github service; one that lasts fails
  // the run saying so, its comment back in the queue.
  test("GitHub failing the repo's config: a hiccup or two, the run starts; for good, the run says why", async (t) => {
    const files = { down: { ".deckhand.yaml": [500, 503] } };
    const { listener, send } = await listen(t, files);
    await send(comment("alice"));
    await listener.until("done (ok)");
    // The comment's admission reads it (a status 0: answered), the run's start finds it down.
    files.down[".deckhand.yaml"] = [0, ...Array(20).fill(500)];
    await send({ ...comment("alice"), comment: { ...comment("alice").comment, id: 100 } });
    const output = await listener.until("done (error, GitHub unavailable)");
    assert.match(
      output,
      /GitHub returned 500 reading \.deckhand\.yaml of org\/repo \(GET \/repos\/org\/repo\/contents\/\.deckhand\.yaml\?ref=trunk\), tried again in 1 min/,
    );
  });

  // #939: GitHub failing the read a comment's admission needs, after the github service's tries:
  // the comment is held rather than dropped, and the next comment admits it first.
  test("GitHub failing the repo's config at a comment's admission: held, then admitted before the next one", async (t) => {
    const files = { down: { ".deckhand.yaml": Array(4).fill(500) } };
    const { dir, github, listener, send } = await listen(t, files);
    await send(comment("alice", "Deckhand\nfirst"));
    await listener.until(
      /org\/repo#12: not queued yet, GitHub returned 500 reading \.deckhand\.yaml of org\/repo \(GET [^)]+\): admitted again in 1 min/,
    );
    const second = comment("alice", "Deckhand\nsecond");
    await send({ ...second, comment: { ...second.comment, id: 100 } });
    // Both handled, the held one first.
    await settled(github, [99, 100]);
    assert.match(messages(dir).join(""), /first[\s\S]*second/);
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
    const keys = join(dir, "store", "keys");
    const kept = readdirSync(keys, { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => readFileSync(join(f.parentPath, f.name), "utf8"));
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
    // The fake's resumed session reports the same running total: the follow-up added nothing.
    const recorded = await until(() => {
      const all = summaries(dir);
      return all.length === 2 && all.sort((a, b) => a.startedAt - b.startedAt);
    }, "Codex's saved runs");
    assert.equal(recorded[0].user, "alice");
    assert.deepEqual(
      recorded.map((r) => r.usage),
      [
        { thread: "t1", base: 0, total: 90, tokens: 90 },
        { thread: "t1", base: 90, total: 90, tokens: 0 },
      ],
    );
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
    // The one kept before, moved to the broker at start, its folder removed, then shots/ itself
    // (#619): its link still works.
    await until(() => !existsSync(join(dir, "shots")), "the screenshots moved");
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

  // The reactions a comment got, by content.
  const reactions = (github, id) =>
    github.requests
      .filter(
        (r) => r.method === "POST" && r.path === `/repos/org/repo/issues/comments/${id}/reactions`,
      )
      .map((r) => JSON.parse(r.body).content);

  test("/cancel stops a working run: a short reply, no fallback, and nothing more until a trigger (#1003)", async (t) => {
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
    // What was queued behind it waits for a trigger, and a comment without one, which the kept
    // session would take, starts nothing: no 👀, no reply.
    await ctx.listener.until("1 comment(s) held until a trigger, its run stopped");
    await send(followUp(102, "Still there?"));
    await ctx.listener.until("#12: its run was stopped, and no trigger line");
    assert.deepEqual(reactions(github, 102), []);
    assert.equal(replies(github).length, 1);
    // Kept in the store: the next orchestrator still holds them.
    assert.deepEqual(Object.keys(await storedMap(dir, "stopped")), ["org/repo#12"]);
    await ctx.restart();
    await send(followUp(104, "Hello?"));
    await ctx.listener.until("#12: its run was stopped, and no trigger line");
    assert.deepEqual(reactions(github, 104), []);
    // A trigger lifts the stop: the comment held goes with it, in one run.
    await send(followUp(103, "Deckhand\n/mode brainstorm\nGo on."));
    await ctx.listener.until("1 comment(s) held since its stop go with it");
    await ctx.listener.until("done (ok)");
    await settled(github, [100, 103]);
    assert.equal(replies(github).length, 2);
    assert.deepEqual(await storedMap(dir, "stopped"), {});
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
});
