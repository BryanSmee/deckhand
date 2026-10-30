// The Antigravity CLI behind the agent seam: its stream-json read through the sandbox's text.jq,
// its tiers and model names, its provider's errors, and its sandbox half (antigravity.sh, the
// release installer).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { antigravity } from "../listener/agents/antigravity.mjs";
import {
  AGENT_SECRETS,
  agentFor,
  effortOf,
  entryName,
  entryOf,
  modelOf,
  providerError,
} from "../listener/agents/index.mjs";
import { resolveEntry } from "../listener/agents/select.mjs";
import { loadConfig } from "../listener/config.mjs";
import { lastResult, outcome } from "../listener/runlog.mjs";
import { tempDir } from "./helpers.mjs";

const bin = new URL("../sandbox/", import.meta.url).pathname;

// `agy`'s stream-json, recorded from agy 1.4.0 on a Google AI Pro plan (#213's spike): a work
// turn (a command, an edit, a failing command, an answer in text deltas), an MCP call, and a
// refused login. Read as the listener gets it: through the sandbox's text.jq.
function recorded(name) {
  const raw = readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
  const joined = spawnSync("jq", ["-nRr", "-f", `${bin}agents/antigravity/text.jq`], {
    input: raw,
    encoding: "utf8",
  });
  assert.equal(joined.status, 0, joined.stderr);
  return joined.stdout.trim().split("\n");
}

const LS = [
  "total 20",
  "drwxr-xr-x 4 dev dev 4096 Oct 17 16:17 .",
  "drwxr-xr-x 4 dev dev 4096 Oct 17 16:17 ..",
  "drwxr-xr-x 2 dev dev 4096 Oct 17 16:17 .agents",
  "drwxr-xr-x 7 dev dev 4096 Oct 17 16:17 .git",
  "-rw-r--r-- 1 dev dev 677 Oct 17 16:17 mcp_server.py",
];

test("text.jq: an answer's deltas become one line, the rest passes as it is", () => {
  const raw = readFileSync(new URL("fixtures/antigravity-work.jsonl", import.meta.url), "utf8");
  const lines = recorded("antigravity-work.jsonl");
  const deltas = raw.split("\n").filter((l) => l.includes('"text_delta"'));
  assert.equal(deltas.length, 18);
  // Every other line, unchanged and in order, with one deckhand.text before the result.
  const kept = raw
    .trim()
    .split("\n")
    .filter((l) => !l.includes('"text_delta"'));
  assert.deepEqual(
    lines.filter((l) => !l.includes('"deckhand.text"')),
    kept,
  );
  const text = lines.map((l) => JSON.parse(l)).filter((e) => e.event === "deckhand.text");
  assert.equal(text.length, 1);
  assert.equal(text[0].step_index, 7);
  assert.equal(text[0].text, deltas.map((l) => JSON.parse(l).step_update.text_delta).join(""));
  assert.equal(JSON.parse(lines.at(-2)).event, "deckhand.text");

  // Two answers, each its own line, and text that isn't JSON passes through.
  const delta = (step, text) =>
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: step,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: text,
      },
    });
  const out = spawnSync("jq", ["-nRr", "-f", `${bin}agents/antigravity/text.jq`], {
    input: [delta(1, "One, "), delta(1, "two."), delta(3, "Three."), "plain"].join("\n"),
    encoding: "utf8",
  }).stdout;
  assert.deepEqual(out.trim().split("\n"), [
    '{"event":"deckhand.text","step_index":1,"text":"One, two."}',
    '{"event":"deckhand.text","step_index":3,"text":"Three."}',
    "plain",
  ]);
});

test("normalize: a work turn, from its recorded stream-json", () => {
  const events = recorded("antigravity-work.jsonl").flatMap((l) => antigravity.normalize(l));
  const answer = [
    "1. Ran `ls -la` in `/home/dev/work`:",
    " ```text",
    ...LS.map((l) => ` ${l}`),
    " ```",
    "2. Created [notes.txt](file:///home/dev/work/notes.txt) containing `hello`.",
    "3. Ran `false`, which exited with exit code **1**.",
    "",
  ].join("\n");
  assert.deepEqual(events, [
    { type: "started" },
    { type: "tool", name: "command", detail: "ls -la" },
    { type: "toolOutput", error: false, text: LS.map((l) => `${l}\r\n`).join("") },
    // An edit has no output; a failed command says nothing of failing (agy 1.4.0).
    { type: "tool", name: "edit", detail: "/home/dev/work/notes.txt" },
    { type: "tool", name: "command", detail: "false" },
    { type: "text", text: answer },
    { type: "result", ok: true, text: answer, durationMs: 25134 },
  ]);
  assert.equal(outcome(lastResult(recorded("antigravity-work.jsonl"), antigravity)), "ok");
});

test("normalize: an MCP call, as Claude Code names it", () => {
  const events = recorded("antigravity-mcp.jsonl").flatMap((l) => antigravity.normalize(l));
  assert.deepEqual(events.slice(1, 5), [
    {
      type: "tool",
      name: "view_file",
      detail: "/home/dev/.gemini/antigravity-cli/mcp/probe/secret_word.json",
    },
    { type: "toolOutput", error: false, text: "1 lines, 109 bytes" },
    { type: "tool", name: "mcp__probe__secret_word", detail: "{}" },
    { type: "toolOutput", error: false, text: "PAPAYA" },
  ]);
  assert.deepEqual(events.at(-1), {
    type: "result",
    ok: true,
    text: "PAPAYA\n",
    durationMs: 13089,
  });
});

test("normalize: a failure is a failed result with its error, a provider's for a fallback", () => {
  const lines = recorded("antigravity-failed.jsonl");
  const [result] = lines.flatMap((l) => antigravity.normalize(l));
  assert.equal(result.ok, false);
  assert.match(result.text, /^Eligibility check failed: UNAUTHENTICATED \(code 401\)/);
  assert.equal(outcome(lastResult(lines, antigravity)), "error");
  assert.equal(providerError(result), "invalid credentials");
  const failed = (text) => ({ type: "result", ok: false, text, durationMs: 0 });
  assert.equal(
    providerError(failed("RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity")),
    "quota reached",
  );
  assert.equal(providerError(failed("PERMISSION_DENIED (code 403)")), "invalid credentials");
  assert.equal(providerError(failed("The tests still fail.")), null);

  // A tool step that didn't end as DONE is an error; init's model, when it says one.
  const step = (s) => JSON.stringify({ event: "step_update", step_update: s });
  assert.deepEqual(
    antigravity.normalize(
      step({ step_type: "tool", state: "ERROR", tool_info: { name: "run_command", output: "no" } }),
    ),
    [{ type: "toolOutput", error: true, text: "no" }],
  );
  assert.deepEqual(
    antigravity.normalize(JSON.stringify({ event: "init", init: { model: "gemini-4-argon" } })),
    [{ type: "started", model: "gemini-4-argon" }],
  );
  // Other tools: their first text parameter. Deltas, user input and what isn't JSON: nothing.
  assert.deepEqual(
    antigravity.normalize(
      step({
        step_type: "tool",
        state: "ACTIVE",
        tool_info: { name: "grep_search", parameters: { Query: "TODO", SearchPath: "/w" } },
      }),
    ),
    [{ type: "tool", name: "grep_search", detail: "TODO" }],
  );
  for (const raw of [
    step({ step_type: "agent_response", state: "ACTIVE", text_delta: "Hi" }),
    step({ step_type: "user_input", state: "DONE" }),
    "Cloning into 'x'...",
    "null",
    '{"type":"result"}',
  ]) {
    assert.deepEqual(antigravity.normalize(raw), [], raw);
  }
});

test("the agent: installed like Codex, its login out of the sandbox, no mid-run messages", () => {
  const config = { agyVolume: "deckhand-antigravity", agyVersion: "1.4.0", agySha256: "x64:ab" };
  assert.equal(agentFor("antigravity"), antigravity);
  assert.equal(antigravity.displayName, "Antigravity CLI");
  assert.deepEqual(antigravity.install(config), {
    volume: "deckhand-antigravity",
    mount: "/opt/antigravity",
    version: "1.4.0",
    versionVar: "AGY_VERSION",
    command: "deckhand-install-antigravity",
    hosts: ["github.com", "*.githubusercontent.com"],
    env: { AGY_SHA256: "x64:ab" },
  });
  // With a plan login: nothing in its environment, the sandbox writes the run's secret in its
  // token file. With GEMINI_API_KEY: the run's secret as GEMINI_API_KEY and the listener's URL.
  assert.deepEqual(antigravity.env(config, "run-secret"), {});
  assert.deepEqual(
    antigravity.env(
      { ...config, agyCredential: "GEMINI_API_KEY", brokerUrl: "http://b:8081" },
      "s",
    ),
    { GEMINI_API_KEY: "s", GOOGLE_GEMINI_BASE_URL: "http://b:8081/google" },
  );
  assert.deepEqual(antigravity.secrets, ["GEMINI_API_KEY", "AGY_AUTH_FILE"]);
  assert.ok(AGENT_SECRETS.includes("GEMINI_API_KEY"));
  assert.ok(AGENT_SECRETS.includes("AGY_AUTH_FILE"));
  assert.deepEqual(antigravity.relayed, [
    "daily-cloudcode-pa.googleapis.com",
    "www.googleapis.com",
  ]);
  assert.deepEqual(antigravity.hosts, [
    ...antigravity.relayed,
    "antigravity-unleash.goog",
    "lh3.googleusercontent.com",
  ]);
  assert.deepEqual(antigravity.blocked, ["play.googleapis.com"]);
  assert.deepEqual(antigravity.session, { volume: "antigravity", path: "/home/node/.gemini" });
  assert.equal(antigravity.takesMessages, false);
  // antigravity@google, in FALLBACKS and `/agent`.
  assert.deepEqual(entryOf("antigravity"), { agent: "antigravity", provider: "google" });
  assert.deepEqual(entryOf("antigravity@google"), { agent: "antigravity", provider: "google" });
  assert.equal(entryOf("antigravity@openai"), null);
  assert.equal(entryName("antigravity"), "antigravity@google");
});

test("its tiers: the plan's models, or the operator's; Claude Code's and Codex's names refused", () => {
  assert.equal(modelOf(antigravity, "best"), "gemini-4-argon-high");
  assert.equal(modelOf(antigravity, "balanced"), "gemini-4-argon-medium");
  assert.equal(modelOf(antigravity, "fast"), "gemini-3.8-flash-medium");
  const agyModels = { fast: "gemini-3.8-flash-low" };
  assert.equal(modelOf(antigravity, "fast", { agyModels }), "gemini-3.8-flash-low");
  assert.equal(modelOf(antigravity, "gemini-4-argon"), "gemini-4-argon");
  assert.equal(effortOf(antigravity, "max"), "high");
  assert.equal(effortOf(antigravity, "low"), "low");
  for (const model of ["opus", "sonnet[1m]", "gpt-6-astra", "o3", "anthropic/claude-opus-5.5"]) {
    assert.match(antigravity.modelProblem(model), /not one of the Antigravity CLI's models/, model);
  }
  for (const model of [
    "gemini-4-argon-high",
    "gemini-4-argon",
    "claude-opus-5-5-medium",
    "gpt-oss-120b-medium",
  ]) {
    assert.equal(antigravity.modelProblem(model), null, model);
  }
  // A fall back from Claude Code with `/model opus`: the Antigravity CLI's best instead.
  const config = { agents: ["claude", "antigravity"], fallbacks: ["antigravity@google"] };
  const resolved = resolveEntry({
    config,
    settings: { agent: "claude", model: "best", effort: "medium" },
    own: null,
    light: false,
    previous: null,
    options: { model: "opus" },
    marker: {
      entry: "antigravity@google",
      from: "claude@anthropic",
      reason: "overloaded",
      tried: [],
    },
  });
  assert.equal(resolved.entry.agent, "antigravity");
  assert.equal(resolved.model, "gemini-4-argon-high");
});

// agents/antigravity.sh, sourced as entrypoint.sh does, with an `agy` that prints what it got,
// then a turn's stream-json, and a `sandbox-draft-pr` that notes it was called.
function agyScript(t, script, env = {}) {
  const dir = tempDir(t, "deckhand-agy-");
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(
    join(dir, "agy"),
    `#!/bin/bash
printf 'arg %s\\n' "$@" >&2
[ -t 0 ] || [ -z "$(cat)" ] || echo "stdin not empty" >&2
echo '{"event":"init","conversation_id":"conv-1","init":{"cwd":"/workspace"}}'
echo '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Done "}}'
echo '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"it."}}'
if [ "\${TURN:-ok}" = ok ]; then
  echo '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"Done it.","duration_seconds":30}}'
else
  echo '{"event":"result","result":{"conversation_id":"conv-1","status":"ERROR","error":"RESOURCE_EXHAUSTED","duration_seconds":1}}'
  exit 1
fi
`,
  );
  writeFileSync(
    join(dir, "sandbox-draft-pr"),
    `#!/bin/bash\necho "$*" >> "${home}/draft-pr.log"\n`,
  );
  for (const name of ["agy", "sandbox-draft-pr"]) chmodSync(join(dir, name), 0o755);
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail; source "${bin}agents/antigravity.sh"; ${script}`],
    {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: home,
        AGY_VERSION: "9.9.9",
        AGENT_FILES: `${bin}agents/antigravity`,
        ...env,
      },
      input: "",
      encoding: "utf8",
    },
  );
  const args = result.stderr
    .split("\n")
    .filter((l) => l.startsWith("arg "))
    .map((l) => l.slice(4));
  return { ...result, dir, home, args };
}

test("its run: print mode with the model and its effort, then the conversation to resume", (t) => {
  const env = { TASK_OUTPUT: "json", SANDBOX_MODEL: "gemini-4-argon", SANDBOX_EFFORT: "high" };
  const flags = (model) => [
    ...["-p", "Do it", "--output-format", "stream-json", "--dangerously-skip-permissions"],
    ...["--model", model],
  ];
  const first = agyScript(
    t,
    `agent_has_session && echo yes >&2 || echo no >&2; agent_run new "Do it"`,
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.args, flags("gemini-4-argon-high"));
  assert.match(first.stderr, /^no$/m);
  assert.doesNotMatch(first.stderr, /stdin not empty/);
  // Its stream-json, the answer's deltas joined.
  const lines = first.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.event),
    ["init", "deckhand.text", "result"],
  );
  assert.equal(lines[1].text, "Done it.");
  // The draft pull request once it exits, and the conversation kept for the next run.
  assert.equal(readFileSync(join(first.home, "draft-pr.log"), "utf8"), "hook Stop\n");
  assert.equal(readFileSync(join(first.home, ".gemini/deckhand-conversation"), "utf8"), "conv-1\n");

  // A tier's model keeps its effort; the next run resumes that conversation, a fresh one
  // (an inbox entry) doesn't replace it.
  const again = (session, extra = {}) =>
    agyScript(
      t,
      `mkdir -p "$HOME/.gemini"; echo conv-0 > "$HOME/.gemini/deckhand-conversation"
       agent_has_session && echo yes >&2; agent_run ${session} "Do it"`,
      { ...env, SANDBOX_MODEL: "gemini-3.8-flash-low", ...extra },
    );
  const resumed = again("continue");
  assert.match(resumed.stderr, /^yes$/m);
  assert.deepEqual(resumed.args, [...flags("gemini-3.8-flash-low"), "--conversation", "conv-0"]);
  assert.equal(
    readFileSync(join(resumed.home, ".gemini/deckhand-conversation"), "utf8"),
    "conv-1\n",
  );
  const fresh = again("fresh");
  assert.deepEqual(fresh.args, flags("gemini-3.8-flash-low"));
  assert.equal(readFileSync(join(fresh.home, ".gemini/deckhand-conversation"), "utf8"), "conv-0\n");

  // A failed turn: its exit status, after the draft pull request's check.
  const failed = again("continue", { TURN: "failed" });
  assert.equal(failed.status, 1);
  assert.match(readFileSync(join(failed.home, "draft-pr.log"), "utf8"), /^hook /);
  assert.equal(JSON.parse(failed.stdout.trim().split("\n").at(-1)).result.status, "ERROR");

  // On a Gemini API key, Argon is agy_home's custom model: its suffix becomes --effort. The
  // catalog's models keep theirs.
  const key = { GEMINI_API_KEY: "run-secret" };
  assert.deepEqual(again("fresh", key).args, flags("gemini-3.8-flash-low"));
  assert.deepEqual(again("fresh", { ...key, SANDBOX_MODEL: "gemini-4-argon-high" }).args, [
    ...flags("gemini-4-argon"),
    ...["--effort", "high"],
  ]);
  assert.deepEqual(
    agyScript(t, `agent_run new "Do it"`, { ...env, ...key, SANDBOX_EFFORT: "low" }).args,
    [...flags("gemini-4-argon"), "--effort", "low"],
  );

  // By hand, progress lines rather than the raw events.
  const human = agyScript(t, `agent_run new "Do it"`);
  assert.equal(human.stdout, "\nDone it.\n\nDone in 0.5 min\n");
});

test("its home: the run's secret as its token, the clone trusted, MCP, hooks and rules", (t) => {
  const { stdout, home } = agyScript(
    t,
    `mkdir -p "$HOME/.gemini/antigravity-cli"
     echo '{"theme":"dark","trustedWorkspaces":["/workspace","/x"]}' > "$HOME/.gemini/antigravity-cli/settings.json"
     agy_home; agy_home
     agent_mcp playwright playwright-mcp --headless --proxy-server "http://egress:3128"
     echo "# Rules" > "$HOME/rules.md"; agent_instructions "$HOME/rules.md"
     stat -c %a "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"`,
    { DECKHAND_RUN_SECRET: "run-secret" },
  );
  const read = (path) => JSON.parse(readFileSync(join(home, ".gemini", path), "utf8"));
  assert.deepEqual(read("antigravity-cli/antigravity-oauth-token"), {
    auth_method: "consumer",
    token: {
      access_token: "run-secret",
      token_type: "Bearer",
      refresh_token: "deckhand-placeholder",
      expiry: "2099-01-01T00:00:00Z",
    },
  });
  assert.equal(stdout, "600\n");
  // Its other settings stay; the clone is trusted once.
  assert.deepEqual(read("antigravity-cli/settings.json"), {
    theme: "dark",
    trustedWorkspaces: ["/x", "/workspace"],
  });
  assert.deepEqual(read("config/mcp_config.json"), {
    mcpServers: {
      playwright: {
        command: "playwright-mcp",
        args: ["--headless", "--proxy-server", "http://egress:3128"],
        env: {},
      },
    },
  });
  // Its user-level hooks (not the workspace's, which would land in the repo) open the draft.
  assert.deepEqual(read("config/hooks.json"), {
    deckhand: {
      Stop: [
        {
          type: "command",
          command: "sandbox-draft-pr hook Stop",
        },
      ],
    },
  });
  assert.equal(readFileSync(join(home, ".gemini/AGENTS.md"), "utf8"), "# Rules\n");

  // With GEMINI_API_KEY: modelProvider is "gemini", Argon a custom model (#1228 upstream) and
  // any plan token file is removed; switching back to a plan login clears both, the operator's
  // own custom models kept, and writes the token file again.
  const withKey = agyScript(
    t,
    `mkdir -p "$HOME/.gemini/antigravity-cli"
     echo '{"token":"old"}' > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
     GEMINI_API_KEY=run-secret agy_home
     jq -c . "$HOME/.gemini/antigravity-cli/settings.json"
     [ ! -e "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] && echo "no-token"
     jq '.customModelsConfig.customModels.mine = {}' "$HOME/.gemini/antigravity-cli/settings.json" > "$HOME/s"
     mv "$HOME/s" "$HOME/.gemini/antigravity-cli/settings.json"
     DECKHAND_RUN_SECRET=run-secret agy_home
     jq -c . "$HOME/.gemini/antigravity-cli/settings.json"
     rm "$HOME/.gemini/antigravity-cli/settings.json"; GEMINI_API_KEY=run-secret agy_home
     DECKHAND_RUN_SECRET=run-secret agy_home
     jq -c . "$HOME/.gemini/antigravity-cli/settings.json"`,
  );
  const [geminiSettings, tokenGone, mineKept, planSettings] = withKey.stdout.trim().split("\n");
  assert.deepEqual(JSON.parse(geminiSettings), {
    trustedWorkspaces: ["/workspace"],
    modelProvider: "gemini",
    customModelsConfig: {
      customModels: {
        "gemini-4-argon": {
          modelId: "gemini-4-argon",
          modelName: "gemini-api://gemini-4-argon",
          label: "Gemini 4 Argon",
          apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
          maxTokens: 1048576,
          modelFeatures: {
            supportsImages: true,
            supportsPdf: true,
            supportsToolCalls: true,
            supportsThinking: true,
            zeroShotCapable: true,
          },
        },
      },
    },
  });
  assert.deepEqual(JSON.parse(mineKept), {
    trustedWorkspaces: ["/workspace"],
    customModelsConfig: { customModels: { mine: {} } },
  });
  assert.equal(tokenGone, "no-token");
  assert.deepEqual(JSON.parse(planSettings), {
    trustedWorkspaces: ["/workspace"],
  });

  // Without the listener (by hand), the token file is the user's own.
  const plain = agyScript(t, 'agy_home; ls -A "$HOME/.gemini/antigravity-cli"');
  assert.doesNotMatch(plain.stdout, /antigravity-oauth-token/);
});

test("a sandbox without its Antigravity CLI says how to install it", (t) => {
  const result = agyScript(t, 'agent_missing() { echo "missing $*" >&2; exit 1; }; agent_check');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /missing Antigravity CLI AGY_VERSION \/opt\/antigravity deckhand-install-antigravity/,
  );
});

// release-install with a `curl` that serves a fake release's tarball, checked against
// `pinned` (by default the real tarball's sha256: what AGY_SHA256 says).
function install(t, { pinned, tarball } = {}) {
  const dir = tempDir(t, "deckhand-release-");
  const files = join(dir, "files");
  mkdirSync(join(files, "pkg"), { recursive: true });
  writeFileSync(join(files, "pkg/antigravity"), "#!/bin/sh\necho agy 1.4.0\n");
  chmodSync(join(files, "pkg/antigravity"), 0o755);
  spawnSync("tar", ["-czf", join(files, "agy.tgz"), "-C", join(files, "pkg"), "antigravity"]);
  const sha = createHash("sha256")
    .update(readFileSync(join(files, "agy.tgz")))
    .digest("hex");
  // A re-published asset: another tarball where the release's was.
  if (tarball) writeFileSync(join(files, "agy.tgz"), tarball);
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/bash
out=; url=
while [ $# -gt 0 ]; do case $1 in -fsSLo) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
echo "curl $url" >&2
case $url in
  https://github.com/google-antigravity/antigravity-cli/releases/download/1.4.0/agy_cli_linux_x64.tar.gz) cp "${files}/agy.tgz" "$out" ;;
  *) exit 22 ;;
esac
`,
  );
  chmodSync(join(dir, "curl"), 0o755);
  const root = join(dir, "opt");
  mkdirSync(root);
  const run = () =>
    spawnSync(
      `${bin}agents/release-install`,
      [
        root,
        "1.4.0",
        "google-antigravity/antigravity-cli",
        "agy_cli_linux_x64.tar.gz",
        "antigravity",
        "agy",
        "Antigravity CLI",
        ...(pinned === null ? [] : [pinned ?? sha]),
      ],
      { env: { PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" },
    );
  return { root, run };
}

test("installing a release: checked against its pinned sha256, linked as agy, once", (t) => {
  const { root, run } = install(t);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /Antigravity CLI 1\.4\.0 installed/);
  const agy = spawnSync(join(root, "1.4.0/bin/agy"), { encoding: "utf8" });
  assert.equal(agy.stdout, "agy 1.4.0\n");
  // Already there: no download.
  const second = run();
  assert.equal(second.status, 0);
  assert.doesNotMatch(second.stderr, /curl/);
});

test("installing a release: a tarball that isn't the pinned one, or no pin, is refused", (t) => {
  const tampered = install(t, { tarball: "not the release" });
  const refused = tampered.run();
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /agy_cli_linux_x64\.tar\.gz is sha256:[0-9a-f]{64}, but sha256:[0-9a-f]{64} is pinned: not installed/,
  );
  assert.deepEqual(spawnSync("ls", ["-A", tampered.root], { encoding: "utf8" }).stdout, "");

  for (const pinned of [null, "", "sha256:abc"]) {
    const none = install(t, { pinned });
    const missing = none.run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no sha256 pinned for agy_cli_linux_x64\.tar\.gz/);
    assert.doesNotMatch(missing.stderr, /curl/);
  }
});

test("the pinned sha256: the default version's by default, the operator's otherwise", () => {
  const pinned = loadConfig({ ALLOWED_USERS: "a" });
  assert.match(pinned.agySha256, /^x64:fd96967583c1[0-9a-f]{52},arm64:cf953adcc69f[0-9a-f]{52}$/);
  assert.deepEqual(antigravity.install(pinned).env, { AGY_SHA256: pinned.agySha256 });
  // Another version: none unless the operator pins it.
  const other = loadConfig({ ALLOWED_USERS: "a", AGY_VERSION: "1.5.0" });
  assert.equal(other.agySha256, null);
  assert.deepEqual(antigravity.install(other).env, { AGY_SHA256: "" });
  const sha = "a".repeat(64);
  const own = loadConfig({ ALLOWED_USERS: "a", AGY_VERSION: "1.5.0", AGY_SHA256: ` X64:${sha} ` });
  assert.equal(own.agySha256, `x64:${sha}`);
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", AGY_SHA256: sha }),
    /AGY_SHA256: expected x64:<sha256>,arm64:<sha256>/,
  );
});

test("installing the Antigravity CLI refuses to run as the sandbox's user", (t) => {
  // An `id -u` that says 1000, whoever runs the tests.
  const dir = tempDir(t);
  writeFileSync(join(dir, "id"), "#!/bin/sh\necho 1000\n", { mode: 0o755 });
  const result = spawnSync(`${bin}agents/antigravity/install`, [], {
    env: { PATH: `${dir}:${process.env.PATH}`, AGY_VERSION: "9.9.9" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not as the sandbox's user/);
});
