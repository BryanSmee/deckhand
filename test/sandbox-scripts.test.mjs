// The sandbox's scripts: git's credential helper and the gh wrapper hand out the run's secret
// (the listener's GitHub gateway swaps it for a token), the entrypoint, the agents' scripts.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { liveMessage } from "../listener/prompts.mjs";
import { sandboxAt, serve, tempDir } from "./helpers.mjs";

const bin = new URL("../sandbox/", import.meta.url).pathname;

// Async: a broker the tests serve may answer from this same process.
function helper(env, input) {
  return new Promise((resolve) => {
    const child = execFile(
      `${bin}git-credential-deckhand`,
      ["get"],
      { env: { PATH: `${bin}:${process.env.PATH}`, ...env }, timeout: 10000 },
      (error, stdout) => resolve({ status: error ? (error.code ?? 1) : 0, stdout }),
    );
    child.stdin.end(input);
  });
}

test("git gets the run's secret for the repo's host, which the GitHub gateway takes", async () => {
  const env = {
    DECKHAND_BROKER_URL: "http://listener:8081",
    DECKHAND_RUN_SECRET: "the-secret",
    REPO_URL: "https://github.com/org/repo.git",
  };
  const ask = "protocol=https\nhost=github.com\n\n";
  assert.equal((await helper(env, ask)).stdout, "username=x-access-token\npassword=the-secret\n");
  // Another host never sees it.
  assert.equal((await helper(env, "protocol=https\nhost=evil.example\n\n")).stdout, "");
  // Outside a run, or without a secret: nothing, and git asks elsewhere.
  const { DECKHAND_RUN_SECRET, ...noSecret } = env;
  for (const without of [{ ...env, DECKHAND_BROKER_URL: "" }, noSecret]) {
    const res = await helper(without, ask);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  }
  assert.ok(DECKHAND_RUN_SECRET);
});

// The Claude Code volume is read-only in a sandbox: a missing version is the listener's to
// install, and the entrypoint says so instead of trying.
test("a sandbox without its Claude Code version stops with a clear message", () => {
  const result = spawnSync(`${bin}entrypoint.sh`, [], {
    env: {
      PATH: process.env.PATH,
      REPO_URL: "https://github.com/org/repo.git",
      CLAUDE_CODE_VERSION: "0.0.0-missing",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Claude Code 0\.0\.0-missing is not installed in \/opt\/claude-code/);
});

test("a sandbox without its Codex version says how to install it", () => {
  const result = spawnSync(`${bin}entrypoint.sh`, [], {
    env: {
      PATH: process.env.PATH,
      REPO_URL: "https://github.com/org/repo.git",
      SANDBOX_AGENT: "codex",
      CODEX_VERSION: "0.0.0-missing",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "Codex 0.0.0-missing is not installed in /opt/codex. The listener installs it before a" +
      " run; by hand, run deckhand-install-codex as root (docker run --user 0 --entrypoint" +
      " deckhand-install-codex -e CODEX_VERSION=0.0.0-missing -v <volume>:/opt/codex <image>).\n",
  );
});

// The Kubernetes runner's pod log has both streams in one: the entrypoint runs under
// deckhand-tagged there, everything on stdout, stderr's lines tagged.
test("SANDBOX_TAG_STDERR: the entrypoint's stderr comes tagged on stdout, its status kept", () => {
  const env = { PATH: `${bin}:${process.env.PATH}`, REPO_URL: "https://x/o/r.git" };
  const tagged = spawnSync(`${bin}entrypoint.sh`, [], {
    env: { ...env, SANDBOX_AGENT: "gemini", SANDBOX_TAG_STDERR: "1" },
    encoding: "utf8",
  });
  assert.equal(tagged.status, 1);
  assert.equal(tagged.stderr, "");
  assert.match(tagged.stdout, /^\x1eUnknown agent gemini \(SANDBOX_AGENT\)[^\n]*\n$/);
  const plain = spawnSync(`${bin}entrypoint.sh`, [], {
    env: { ...env, SANDBOX_AGENT: "gemini" },
    encoding: "utf8",
  });
  assert.match(plain.stderr, /^Unknown agent gemini/);
});

// A line over the runtime's 16 KiB parts, written while the other stream writes: whole, and
// never spliced with a stderr line, as two writers into one log would.
test("deckhand-tagged: one writer, whole lines; a long stdout line and stderr lines apart", () => {
  const script = `
    const long = JSON.stringify({ type: "result", result: "x".repeat(200000) });
    let i = 0;
    const tick = () => {
      if (i < 20) process.stderr.write("setup " + i + "\\n");
      if (i < 20) process.stdout.write(long.slice(i * 10000, (i + 1) * 10000));
      if (++i < 21) return setImmediate(tick);
      process.stdout.write(long.slice(200000) + "\\n");
      process.stderr.write("no newline at the end");
    };
    tick();`;
  const result = spawnSync(`${bin}deckhand-tagged`, [process.execPath, "-e", script], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.split("\n");
  assert.equal(lines.pop(), "");
  const out = lines.filter((l) => !l.startsWith("\x1e"));
  const err = lines.filter((l) => l.startsWith("\x1e")).map((l) => l.slice(1));
  assert.deepEqual(out, [JSON.stringify({ type: "result", result: "x".repeat(200000) })]);
  assert.deepEqual(err, [
    ...Array.from({ length: 20 }, (_, i) => `setup ${i}`),
    "no newline at the end",
  ]);
});

// A reader slower than the command (the runtime's, a slow disk): the command waits, as on a
// full pipe, rather than its output piling up in the wrapper, inside the sandbox's memory.
test("deckhand-tagged: a slow reader holds the command back, the wrapper's memory bounded", async () => {
  const { spawn } = await import("node:child_process");
  const script = `
    const line = "x".repeat(1023) + "\\n";
    let n = 0;
    const go = () => {
      while (n < 200000) {
        n++;
        if (!process.stdout.write(line)) return process.stdout.once("drain", go);
      }
    };
    go();`;
  const wrapper = spawn(`${bin}deckhand-tagged`, [process.execPath, "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  wrapper.stdout.pause();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const rss = Number(
    readFileSync(`/proc/${wrapper.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1],
  );
  // Failing, it would wait on its reader for good: it goes first.
  if (rss >= 150 * 1024) wrapper.kill("SIGKILL");
  assert.ok(rss < 150 * 1024, `wrapper RSS ${Math.round(rss / 1024)} MB`);
  let bytes = 0;
  wrapper.stdout.on("data", (d) => (bytes += d.length));
  wrapper.stdout.resume();
  assert.equal(await new Promise((resolve) => wrapper.on("close", resolve)), 0);
  assert.equal(bytes, 200000 * 1024);
});

test("deckhand-tagged: SIGTERM reaches the command, whose status comes back", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    `${bin}deckhand-tagged`,
    [
      "bash",
      "-c",
      'trap "echo bye >&2; exit 7" TERM; echo ready; sleep 30 > /dev/null 2>&1 & wait',
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  await new Promise((resolve) =>
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("ready\n")) resolve();
    }),
  );
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 7);
  assert.equal(out, "ready\n\x1ebye\n");
});

test("an unknown agent stops the sandbox before anything runs", () => {
  for (const agent of ["gemini", "../claude", "Claude"]) {
    const result = spawnSync(`${bin}entrypoint.sh`, [], {
      env: { PATH: process.env.PATH, REPO_URL: "https://x/o/r.git", SANDBOX_AGENT: agent },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, agent);
    assert.match(result.stderr, /^Unknown agent .* \(SANDBOX_AGENT\)/, agent);
  }
});

// A comment on a brainstorm that has a session gets the entrypoint's note, one delivered
// mid-run liveMessage()'s: the same rules, kept alike (follow-up issues are allowed).
test("the entrypoint's brainstorm note matches the mid-run one", () => {
  const code = readFileSync(`${bin}entrypoint.sh`, "utf8");
  const note = code.match(/\(Still a brainstorm: [^)]*\)/)?.[0];
  assert.equal(
    note,
    "(Still a brainstorm: no code, branch, commit or pull request, and new issues only for kept follow-ups.)",
  );
  assert.ok(liveMessage("brainstorm", "Hi").includes(note.slice(0, -1)));
});

// Claude Code's commands live in its agent script only: the entrypoint is the same for every
// agent.
test("the entrypoint runs no claude command itself", () => {
  const code = readFileSync(`${bin}entrypoint.sh`, "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l));
  assert.deepEqual(
    code.filter((l) => /(^|[\s;(|&])claude(\s|$)/.test(l)),
    [],
  );
});

// agents/claude.sh, sourced as entrypoint.sh does, with a `claude` that prints what it got.
function claudeScript(t, script, env = {}) {
  const dir = tempDir(t, "deckhand-claude-");
  writeFileSync(
    join(dir, "claude"),
    '#!/bin/bash\nprintf "%s\\n" "$@"\n[ -t 0 ] || { echo "stdin:"; cat; }\n',
  );
  chmodSync(join(dir, "claude"), 0o755);
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail; source "${bin}agents/claude.sh"; ${script}`],
    {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CLAUDE_CODE_VERSION: "9.9.9",
        CLAUDE_CONFIG_DIR: dir,
        AGENT_FILES: `${bin}agents/claude`,
        ...env,
      },
      input: "",
      encoding: "utf8",
    },
  );
  return { ...result, dir };
}

test("Claude Code's run: a new, continued or fresh session, with the model and effort", (t) => {
  const env = { TASK_OUTPUT: "json", SANDBOX_MODEL: "sonnet", SANDBOX_EFFORT: "high" };
  const args = (session) =>
    claudeScript(t, `agent_run ${session} "Do it"`, env).stdout.split("\nstdin:")[0].split("\n");
  const common = ["--dangerously-skip-permissions", "--model", "sonnet", "--effort", "high"];
  const out = ["Do it", "--output-format", "stream-json", "--verbose"];
  assert.deepEqual(args("new"), [...common, "-p", ...out]);
  assert.deepEqual(args("continue"), [...common, "--continue", "-p", ...out]);
  assert.deepEqual(args("fresh"), [...common, "--no-session-persistence", "-p", ...out]);
});

test("Claude Code's run: fast mode for this session only, its organization check skipped", (t) => {
  const env = { TASK_OUTPUT: "json", SANDBOX_MODEL: "opus", SANDBOX_EFFORT: "high" };
  const args = (more) =>
    claudeScript(t, 'agent_run new "Do it"', { ...env, ...more }).stdout.split("\nstdin:")[0];
  assert.match(
    args({ SANDBOX_SPEED: "fast" }),
    /^--effort\nhigh\n--settings\n\{"fastMode": true\}\n-p$/m,
  );
  assert.doesNotMatch(args({ SANDBOX_SPEED: "normal" }), /--settings/);
  assert.doesNotMatch(args({}), /--settings/);
  const script = `printf '#!/bin/bash\\necho "skip=$%s"\\n' "{CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK:-}" \\
       > "$CLAUDE_CONFIG_DIR/claude"; agent_run new "Do it"`;
  assert.equal(claudeScript(t, script, { ...env, SANDBOX_SPEED: "fast" }).stdout, "skip=1\n");
  assert.equal(claudeScript(t, script, env).stdout, "skip=\n");
});

test("Claude Code's run: no background tasks headless, so it ends with its answer", (t) => {
  // claudeScript()'s `claude`, in CLAUDE_CONFIG_DIR, printing the setting instead.
  const script = (call) =>
    `printf '#!/bin/bash\\necho "bg=$%s"\\n' "{CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" \\
       > "$CLAUDE_CONFIG_DIR/claude"; ${call}`;
  const env = { TASK_OUTPUT: "json" };
  assert.equal(claudeScript(t, script('agent_run new "Do it"'), env).stdout, "bg=1\n");
  assert.equal(claudeScript(t, script("agent_interactive new"), env).stdout, "bg=\n");
});

test("Claude Code's own fallback model: headless only, and never the run's model", (t) => {
  const env = { TASK_OUTPUT: "json", SANDBOX_MODEL: "opus", SANDBOX_FALLBACK_MODEL: "sonnet" };
  const run = claudeScript(t, 'agent_run new "Do it"', env).stdout.split("\nstdin:")[0];
  assert.match(run, /^--fallback-model\nsonnet$/m);
  const same = { ...env, SANDBOX_FALLBACK_MODEL: "opus" };
  assert.doesNotMatch(claudeScript(t, 'agent_run new "Do it"', same).stdout, /--fallback-model/);
  const none = { TASK_OUTPUT: "json", SANDBOX_MODEL: "opus" };
  assert.doesNotMatch(claudeScript(t, 'agent_run new "Do it"', none).stdout, /--fallback-model/);
  // By hand, Claude Code would refuse it.
  assert.doesNotMatch(claudeScript(t, "agent_interactive new", env).stdout, /--fallback-model/);
});

test("Claude Code's run with messages: the prompt, then the inbox, as stream-json", (t) => {
  const { stdout } = claudeScript(
    t,
    `deckhand_messages() { echo '{"type":"user","message":{"role":"user","content":"Later"}}'; }
     agent_run continue "First"`,
    { TASK_OUTPUT: "json", TASK_INPUT: "stream" },
  );
  const [args, input] = stdout.split("stdin:\n");
  assert.match(args, /--continue\n-p\n--input-format\nstream-json\n--output-format\nstream-json/);
  assert.deepEqual(
    input
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).message.content),
    ["First", "Later"],
  );
});

test("Claude Code's session: its transcripts in the issue's volume, instructions beside", (t) => {
  const none = claudeScript(t, "agent_has_session && echo yes || echo no");
  assert.equal(none.stdout, "no\n");
  const some = claudeScript(
    t,
    `mkdir -p "$CLAUDE_CONFIG_DIR/projects/-workspace"
     touch "$CLAUDE_CONFIG_DIR/projects/-workspace/a.jsonl"
     agent_has_session && echo yes || echo no
     echo "# Rules" > "$CLAUDE_CONFIG_DIR/rules.md"
     agent_instructions "$CLAUDE_CONFIG_DIR/rules.md"
     cat "$CLAUDE_CONFIG_DIR/CLAUDE.md"; echo "$AGENT_STATE"`,
  );
  assert.equal(some.stdout, `yes\n# Rules\n${some.dir}\n`);
});

// The entrypoint takes an image's agents over the checkout's: in a sandbox of an image from
// before Codex (Deckhand working on itself), there is no codex.sh to find.
const imageAgents = "/usr/local/share/deckhand-agents";
const olderImage = existsSync(imageAgents) && !existsSync(`${imageAgents}/codex.sh`);

test(
  "a sandbox without its Codex version stops with a clear message",
  { skip: olderImage && "this sandbox's image has no codex.sh" },
  () => {
    const result = spawnSync(`${bin}entrypoint.sh`, [], {
      env: {
        PATH: process.env.PATH,
        REPO_URL: "https://github.com/org/repo.git",
        SANDBOX_AGENT: "codex",
        CODEX_VERSION: "0.0.0-missing",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Codex 0\.0\.0-missing is not installed in \/opt\/codex/);
  },
);

// agents/codex.sh, sourced as entrypoint.sh does, with a `codex` that prints what it got,
// then the JSONL of a turn (`turn`: completed or failed) and exits as Codex would.
function codexScript(t, script, env = {}) {
  const dir = tempDir(t, "deckhand-codex-");
  writeFileSync(
    join(dir, "codex"),
    `#!/bin/bash
printf 'arg %s\\n' "$@" >&2
[ -t 0 ] || [ -z "$(cat)" ] || echo "stdin not empty" >&2
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Done it."}}'
if [ "\${TURN:-completed}" = completed ]; then
  echo '{"type":"turn.completed","usage":{}}'
else
  echo '{"type":"turn.failed","error":{"message":"rate limit exceeded"}}'
  exit 1
fi
`,
  );
  chmodSync(join(dir, "codex"), 0o755);
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail; source "${bin}agents/codex.sh"; ${script}`],
    {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CODEX_VERSION: "9.9.9",
        CODEX_HOME: join(dir, "home"),
        AGENT_FILES: `${bin}agents/codex`,
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
  return { ...result, dir, args };
}

test("Codex's run: exec, resume --last or ephemeral, with the model and effort, no prompts", (t) => {
  const env = { TASK_OUTPUT: "json", SANDBOX_MODEL: "gpt-6.1-sol", SANDBOX_EFFORT: "high" };
  const args = (session) => codexScript(t, `agent_run ${session} "Do it"`, env).args;
  const flags = [
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    ...["-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"'],
    "Do it",
  ];
  assert.deepEqual(args("new"), ["exec", ...flags]);
  assert.deepEqual(args("continue"), ["exec", "resume", "--last", ...flags]);
  assert.deepEqual(args("fresh"), ["exec", "--ephemeral", ...flags]);
});

test("Codex's run: its JSONL, then Deckhand's result line, and its exit status", (t) => {
  const ok = codexScript(t, `agent_run new "Do it"`, { TASK_OUTPUT: "json" });
  assert.equal(ok.status, 0);
  assert.doesNotMatch(ok.stderr, /stdin not empty/);
  const lines = ok.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.type),
    ["thread.started", "item.completed", "turn.completed", "deckhand.result"],
  );
  const result = lines.at(-1);
  assert.deepEqual(
    { ...result, duration_ms: 0 },
    {
      type: "deckhand.result",
      ok: true,
      text: "Done it.",
      duration_ms: 0,
    },
  );
  assert.ok(Number.isInteger(result.duration_ms));

  const failed = codexScript(t, `agent_run continue "Again"`, {
    TASK_OUTPUT: "json",
    TURN: "failed",
  });
  assert.equal(failed.status, 1);
  const last = JSON.parse(failed.stdout.trim().split("\n").at(-1));
  assert.equal(last.ok, false);
  assert.equal(last.text, "rate limit exceeded");

  // By hand, progress lines rather than the raw events.
  const human = codexScript(t, `agent_run new "Do it"`);
  assert.match(human.stdout, /^\nDone it\.\n\nDone in 0 min\n$/);
});

test("Codex's home: its provider the listener, no analytics or plugins, hooks and MCP", (t) => {
  const { stdout, dir } = codexScript(
    t,
    `codex_home
     codex_home
     agent_mcp playwright playwright-mcp --headless --proxy-server "http://egress:3128"
     cat "$CODEX_HOME/config.toml"; echo ---; cat "$CODEX_HOME/hooks.json"`,
    { OPENAI_BASE_URL: "http://listener:8081/openai" },
  );
  const [config, hooks] = stdout.split("---\n");
  // Written again on every start: one provider, one MCP server.
  assert.equal(config.match(/\[model_providers\.deckhand\]/g).length, 1);
  assert.match(config, /^model_provider = "deckhand"$/m);
  assert.match(config, /^base_url = "http:\/\/listener:8081\/openai"$/m);
  assert.match(config, /^env_key = "OPENAI_API_KEY"$/m);
  assert.match(config, /^check_for_update_on_startup = false$/m);
  assert.match(config, /\[analytics\]\nenabled = false/);
  assert.match(config, /^plugins = false\napps = false\nremote_plugin = false$/m);
  assert.match(
    config,
    /\[mcp_servers\.playwright\]\ncommand = "playwright-mcp"\nargs = \["--headless","--proxy-server","http:\/\/egress:3128"\]\n$/,
  );
  // Its hooks open the draft pull request, as Claude Code's do.
  const commands = JSON.stringify(JSON.parse(hooks));
  assert.match(
    commands,
    /"PostToolUse":\[\{"matcher":"Bash","hooks":\[\{"type":"command","command":"sandbox-draft-pr hook"/,
  );
  assert.match(
    commands,
    /"Stop":\[\{"hooks":\[\{"type":"command","command":"sandbox-draft-pr hook"/,
  );
  // Without the listener (by hand): OpenAI's own provider.
  const plain = codexScript(t, `codex_home; cat "$CODEX_HOME/config.toml"`).stdout;
  assert.doesNotMatch(plain, /model_provider/);
  assert.ok(dir);
});

test("Codex's session: its rollouts in the issue's volume, instructions beside", (t) => {
  const none = codexScript(t, "agent_has_session && echo yes || echo no");
  assert.equal(none.stdout, "no\n");
  const some = codexScript(
    t,
    `mkdir -p "$CODEX_HOME/sessions/2026/10/15"
     touch "$CODEX_HOME/sessions/2026/10/15/rollout-2026-10-15T18-20-35-01a1.jsonl"
     agent_has_session && echo yes || echo no
     echo "# Rules" > "$CODEX_HOME/rules.md"
     agent_instructions "$CODEX_HOME/rules.md"
     cat "$CODEX_HOME/AGENTS.md"; echo "$AGENT_STATE $AGENT_NAME"`,
  );
  assert.equal(some.stdout, `yes\n# Rules\n${some.dir}/home Codex\n`);
});

test(
  "installing Codex refuses to run as the sandbox's user",
  { skip: process.getuid() === 0 },
  () => {
    const result = spawnSync(`${bin}agents/codex/install`, [], {
      env: { PATH: process.env.PATH, CODEX_VERSION: "9.9.9" },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run it as root/);
  },
);

// The work feedback prompt can't run here (it needs Claude Code): its text, as bash has it.
test("work feedback rebases on the base and force-pushes with a lease before gh pr ready", () => {
  const script = readFileSync(`${bin}entrypoint.sh`, "utf8");
  const feedback = /prompt="New feedback on this issue: [^]*?"\n/.exec(script)[0];
  assert.match(feedback, /Before marking it ready[^]*\\`git rebase origin\/\$BASE_BRANCH\\`/);
  assert.match(feedback, /run the checks again, then\s+\\`git push --force-with-lease\\`/);
  assert.match(feedback, /can't be resolved safely[^]*stop\s+and ask/);
});

// The engine note, from the entrypoint's own engine_note(), with a `docker` that answers or
// not: three distinct notes, and every prompt (new or continued) ends with it.
test("the prompt says whether the run has a container engine, and whether it answers", (t) => {
  const script = readFileSync(`${bin}entrypoint.sh`, "utf8");
  const fn = /^engine_note\(\) \{[^]*?^\}$/m.exec(script)[0];
  const dir = tempDir(t, "engine-");
  const note = (env, answers) => {
    writeFileSync(join(dir, "docker"), `#!/bin/sh\nexit ${answers ? 0 : 1}\n`);
    chmodSync(join(dir, "docker"), 0o755);
    return spawnSync("bash", ["-c", `${fn}\nengine_note`], {
      env: { PATH: `${dir}:${process.env.PATH}`, ...env },
      encoding: "utf8",
    });
  };
  const engine = { DOCKER_HOST: "tcp://engine:2375" };

  const up = note(engine, true);
  assert.match(
    up.stdout,
    /^This run has a container engine: `docker`, `docker buildx` and `docker compose`/,
  );
  assert.match(up.stdout, /DOCKER_HOST=tcp:\/\/engine:2375/);
  assert.match(up.stdout, /published ports answer on `engine`/);

  const down = note(engine, false);
  assert.match(
    down.stdout,
    /^This run was given a container engine \(DOCKER_HOST=tcp:\/\/engine:2375\), but it didn't\nanswer/,
  );
  assert.match(down.stdout, /Retry `docker version`/);
  assert.match(down.stderr, /The container engine at tcp:\/\/engine:2375 doesn't answer yet/);

  // A `docker` that answers proves nothing without DOCKER_HOST: the CLI is in every image.
  const none = note({}, true);
  assert.equal(
    none.stdout,
    "This run has no container engine: `docker` can't build or start anything here.\n",
  );

  // After every branch that sets the prompt, before agent_run.
  assert.match(script, /prompt\+="\n\n\$engine"\n[^]*?agent_run "\$session" "\$prompt"/);
});

// The clone kept in a session volume, from the entrypoint's own reset_clone(), in a clone of a
// local origin: whatever the last run checked out or left in .git, setup and the agent start
// on trusted code, and nothing of the last run's is lost.
function resetClone(t) {
  const script = readFileSync(`${bin}entrypoint.sh`, "utf8");
  const fns = ["reset_clone", "clean_git_dir", "whole_clone"]
    .map((name) => new RegExp(`^${name}\\(\\) \\{[^]*?^\\}$`, "m").exec(script)[0])
    .join("\n");
  const dir = tempDir(t, "reset-");
  const origin = join(dir, "origin");
  const clone = join(dir, "clone");
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@example",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@example",
    REPO_URL: origin,
  };
  const sh = (cwd, command, extra = {}) => {
    const result = spawnSync("bash", ["-c", command], {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  sh(
    dir,
    `git init -q -b main origin && cd origin && echo ignored/ > .gitignore &&
    git add . && git commit -qm base && git branch feat`,
  );
  sh(dir, `git clone -q ${origin} clone && cd clone && git branch -q --track feat origin/feat`);
  // What a fork's code run by a work run could leave in .git: a hook, and settings git runs.
  const hooked = join(dir, "hooked");
  const plant = () =>
    sh(
      clone,
      `printf '#!/bin/sh\ntouch "${hooked}"\n' > "${dir}/hook" && chmod +x "${dir}/hook" &&
      cp "${dir}/hook" .git/hooks/post-checkout && git config core.fsmonitor "${dir}/hook" &&
      git config remote.origin.url https://example.com/elsewhere.git &&
      git config --add remote.origin.fetch '+refs/pull/*/head:refs/remotes/origin/pr/*'`,
    );
  // A fork's head as `gh pr checkout` leaves it: project hooks, untracked and ignored files.
  const leave = (branch, remote, merge) =>
    sh(
      clone,
      `git checkout -q -B ${branch} origin/main && mkdir -p .claude ignored &&
      echo '{"hooks":{}}' > .claude/settings.json && git add .claude && git commit -qm fork &&
      git config branch.${branch}.remote ${remote} && git config branch.${branch}.merge ${merge} &&
      touch untracked ignored/tampered.tgz`,
    );
  const reset = (extra = {}) => {
    plant();
    return sh(
      clone,
      `${fns}\nset -euo pipefail\nBASE_BRANCH=\${BASE_BRANCH:-main}\nreset_clone\n` +
        `echo "$(git branch --show-current)|\${reset_from:-}|\${reset_stashed:-}"`,
      extra,
    );
  };
  const clean = () => {
    assert.equal(sh(clone, "git status --porcelain --ignored"), "");
    assert.ok(!existsSync(join(clone, ".claude")));
    assert.deepEqual(readdirSync(join(clone, ".git", "hooks")), []);
    assert.equal(sh(clone, "git config core.fsmonitor || true"), "");
    assert.equal(sh(clone, "git config remote.origin.url"), origin);
    // git's default refspec, whatever a run widened it to (a fork's pull requests').
    assert.equal(
      sh(clone, "git config --get-all remote.origin.fetch"),
      "+refs/heads/*:refs/remotes/origin/*",
    );
    // Not just during the reset: the checkout draft-pr.sh may do next runs no hook either.
    sh(clone, "git checkout -q feat && git checkout -q -");
    assert.ok(!existsSync(hooked), "a git hook ran");
  };
  return { sh, origin, clone, leave, reset, clean, script, fns };
}

test("every start puts the kept clone back on a branch of the repository, with nothing untracked", (t) => {
  const { sh, clone, leave, reset, clean, script } = resetClone(t);
  // A fork whose maintainers may push: its URL. One whose maintainers can't: refs/pull/<n>/head.
  // A work run's untracked files are stashed, not lost.
  leave("fork-head", "https://github.com/someone/repo.git", "refs/heads/feat");
  assert.equal(reset(), "main|fork-head|1");
  clean();
  assert.match(sh(clone, "git stash list"), /Left uncommitted by a run, on fork-head/);
  assert.equal(sh(clone, "git stash show --include-untracked --name-only"), "untracked");
  leave("pr-7", "origin", "refs/pull/7/head");
  assert.equal(reset(), "main|pr-7|1");
  clean();
  // The repository's own branch: a work run stays there, a light run goes back to the base,
  // with nothing stashed.
  sh(clone, "git checkout -q feat && mkdir -p ignored && touch ignored/x");
  assert.equal(reset(), "feat||");
  clean();
  sh(clone, "git checkout -q feat && touch untracked");
  assert.equal(reset({ SANDBOX_LIGHT: "1" }), "main|feat|");
  clean();
  // Commits that aren't on the repository (a fork's, merged in and not pushed): the base
  // branch, and the branch kept as it is.
  sh(clone, "git checkout -q feat && git commit -q --allow-empty -m unpushed");
  assert.equal(reset(), "main|feat|");
  clean();
  assert.equal(sh(clone, "git log -1 --format=%s feat"), "unpushed");

  // Before anything runs on the clone: the setup, and the agent.
  assert.match(
    script,
    /\|\| reset_clone\n[^]*?bash -c "\$SANDBOX_SETUP"[^]*?agent_run "\$session"/,
  );
});

// A work run that isn't a fork's fetches no blob on its own (the GitHub gateway refuses it:
// github-forks.mjs): a blobless clone kept from a fork's run or an older Deckhand gets them all
// at once, before the checkout would ask for them; other runs leave it blobless.
test("a work run that isn't a fork's makes a kept blobless clone whole, before any checkout", (t) => {
  const { sh, origin, fns, script } = resetClone(t);
  sh(
    origin,
    `git config uploadpack.allowFilter true && for v in 1 2 3; do echo $v > f && git add f &&
    git commit -qm $v; done`,
  );
  const dir = join(origin, "..");
  const missing = (clone) =>
    sh(clone, "git rev-list --objects --missing=print --all | grep -c '^?' || true");
  const start = (name, extra) => {
    sh(dir, `git clone -q --filter=blob:none file://${origin} ${name}`);
    const clone = join(dir, name);
    assert.equal(missing(clone), "2");
    sh(clone, `${fns}\nset -euo pipefail\nBASE_BRANCH=main\nreset_clone`, extra);
    return clone;
  };
  const whole = start("whole", { SANDBOX_FULL_CLONE: "1" });
  assert.equal(missing(whole), "0");
  assert.equal(sh(whole, "git config remote.origin.partialclonefilter || true"), "");
  // A local branch whose commit no branch of the repository has any more: its blob stays
  // missing, counted for the agent.
  const kept = start("kept", {});
  sh(origin, "git checkout -q -b gone && echo gone > g && git add g && git commit -qm gone");
  sh(origin, "git checkout -q main");
  sh(kept, "git fetch -q origin gone && git branch -q gone FETCH_HEAD");
  sh(origin, "git checkout -q main && git branch -q -D gone");
  const said = sh(
    kept,
    `${fns}\nset -euo pipefail\nBASE_BRANCH=main\nSANDBOX_FULL_CLONE=1\nreset_clone\necho "\${reset_missing:-}"`,
  );
  assert.equal(said, "1");
  assert.match(script, /\$reset_missing objects of its local branches or stash/);
  const light = start("light", {});
  assert.equal(missing(light), "2");
  assert.equal(sh(light, "git config remote.origin.partialclonefilter"), "blob:none");
  // A new clone is whole from the start.
  assert.match(
    script,
    /filter=\(--filter=blob:none\)\n\s*\[ -z "\$\{SANDBOX_FULL_CLONE:-\}" \] \|\| filter=\(\)/,
  );
});

test("a kept clone resets whatever its worktrees and base branch became", (t) => {
  const { sh, origin, clone, reset, clean } = resetClone(t);
  // A worktree that held the base branch, gone with its container.
  sh(clone, `git checkout -q feat && git worktree add -q ${clone}-wt main && rm -rf ${clone}-wt`);
  sh(clone, "git checkout -q -b local");
  assert.equal(reset(), "main|local|");
  clean();
  // The base branch renamed on the repository since the clone: fetched.
  sh(origin, "git branch -m main trunk");
  sh(clone, "git checkout -q local");
  assert.equal(reset({ BASE_BRANCH: "trunk" }), "trunk|local|");
  clean();
});

// After the reset, draft-pr.sh goes back to the issue's branch only when the repository has
// all its commits: those it doesn't have may be a fork's, for the agent to read first.
test("draft-pr's start leaves the issue's branch alone when it has commits that aren't pushed", (t) => {
  const { sh, clone } = resetClone(t);
  const fake = tempDir(t, "gh-");
  writeFileSync(join(fake, "gh"), "#!/bin/sh\necho 1\n"); // its pull request exists
  chmodSync(join(fake, "gh"), 0o755);
  // Its functions only: the script itself works in /workspace.
  const script = readFileSync(`${bin}draft-pr.sh`, "utf8");
  const fns = ["info", "ensure", "start"]
    .map((name) => new RegExp(`^${name}\\(\\) \\{[^]*?^\\}$`, "m").exec(script)[0])
    .join("\n");
  const start = () =>
    sh(
      clone,
      `base=main\ncache=.git/deckhand-task.json\n${fns}\nstart\ngit branch --show-current`,
      { PATH: `${fake}:${process.env.PATH}`, TASK_ISSUE: "5" },
    );
  sh(clone, `echo '{"title":"t","branch":"feat"}' > .git/deckhand-task.json`);
  assert.equal(start(), "feat");
  sh(clone, "git commit -q --allow-empty -m unpushed && git checkout -q main");
  assert.equal(start(), "main");
});

// The entrypoint's fetch of the run's files (fetch_run_files()), against a fake deckhand-files:
// the variables name the fetched files, a path stays as it is, a failed fetch stops the run.
test("the entrypoint fetches the CA and digest from the broker, and stops when it can't", (t) => {
  const script = readFileSync(`${bin}entrypoint.sh`, "utf8");
  const fn = /^fetch_run_files\(\) \{[^]*?^\}$/m.exec(script)[0];
  assert.match(script, /^fetch_run_files \/tmp\/deckhand$/m, "called at start");
  const fake = tempDir(t, "files-");
  writeFileSync(
    join(fake, "deckhand-files"),
    '#!/bin/sh\n[ "$1" = get ] || exit 2\ncase "$2" in *fail*) exit 1 ;; esac\necho "from $2" > "$3"\n',
  );
  chmodSync(join(fake, "deckhand-files"), 0o755);
  const dir = join(fake, "run");
  const run = (env) =>
    spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail\n${fn}\nfetch_run_files "$DIR"\necho "CA=\${DECKHAND_CA:-} DIGEST=\${TASK_DIGEST:-}"`,
      ],
      { env: { PATH: `${fake}:${process.env.PATH}`, DIR: dir, ...env }, encoding: "utf8" },
    );
  const both = run({
    DECKHAND_CA: "http://listener:8081/run/ca",
    TASK_DIGEST: "https://listener:8081/run/digest",
  });
  assert.equal(both.status, 0, both.stderr);
  assert.equal(both.stdout, `CA=${dir}/egress-ca.crt DIGEST=${dir}/digest.md\n`);
  assert.equal(
    readFileSync(join(dir, "egress-ca.crt"), "utf8"),
    "from http://listener:8081/run/ca\n",
  );
  assert.equal(
    readFileSync(join(dir, "digest.md"), "utf8"),
    "from https://listener:8081/run/digest\n",
  );
  // A path (a sandbox started by hand) and an unset variable are left as they are.
  const byHand = run({ DECKHAND_CA: "/etc/my-ca.crt" });
  assert.equal(byHand.stdout, "CA=/etc/my-ca.crt DIGEST=\n");
  // A fetch that fails stops the run before anything else.
  const failed = run({ TASK_DIGEST: "http://listener:8081/run/fail" });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, "");
});

// The agent's Stop hook and every push upload the run's screenshots, for every run, before
// the final message or the pushed work links them: the watcher's 3 s may be too late.
test("the Stop hook, a git push hook and pre-push upload the screenshots; other hooks don't", (t) => {
  const fake = tempDir(t, "files-");
  const calls = join(fake, "calls");
  writeFileSync(join(fake, "deckhand-files"), `#!/bin/sh\necho "$*" >> ${calls}\n`);
  chmodSync(join(fake, "deckhand-files"), 0o755);
  const env = { PATH: `${fake}:${process.env.PATH}`, SCREENSHOT_DIR: "/tmp/screenshots" };
  // A brainstorm: draft-pr.sh does nothing else for it.
  const hook = (args, input = "") =>
    spawnSync(`${bin}draft-pr.sh`, ["hook", ...args], {
      env: { ...env, TASK_MODE: "brainstorm" },
      input,
      encoding: "utf8",
    }).status;
  const count = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").length - 1 : 0);
  assert.equal(hook([], JSON.stringify({ hook_event_name: "Stop" })), 0);
  assert.equal(count(), 1);
  const bash = (command) =>
    JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { command } });
  assert.equal(hook([], bash("ls -l")), 0);
  assert.equal(count(), 1);
  assert.equal(hook([], bash("git push -u origin x")), 0);
  assert.equal(count(), 2);
  assert.equal(hook(["Stop"]), 0); // agy's
  assert.equal(count(), 3);
  const push = spawnSync(`${bin}pre-push`, [], { env, input: "", encoding: "utf8" });
  assert.equal(push.status, 0);
  // After the hook's own work (on exit), within 20 s: a work run's Stop hook opens the draft
  // first, whatever the upload takes, and its gh calls (the wrapper) don't upload.
  const order = join(fake, "order");
  writeFileSync(
    join(fake, "git"),
    `#!/bin/sh\necho "git $1" >> ${order}\n[ "$1" = branch ] && echo feat\nexit 0\n`,
  );
  writeFileSync(join(fake, "timeout"), `#!/bin/sh\necho "timeout $1 $2" >> ${order}\n`);
  writeFileSync(
    join(fake, "real-gh"),
    `#!/bin/sh\necho "gh $1 $2" >> ${order}\n[ "$1" = issue ] && echo "A title"\nexit 0\n`,
  );
  for (const f of ["git", "timeout", "real-gh"]) chmodSync(join(fake, f), 0o755);
  mkdirSync(join(fake, ".git"));
  const script = readFileSync(`${bin}draft-pr.sh`, "utf8").replace(/\/workspace/g, fake);
  writeFileSync(join(fake, "draft-pr.sh"), script);
  spawnSync("bash", [join(fake, "draft-pr.sh"), "hook", "Stop"], {
    env: {
      ...env,
      // The image's gh wrapper (sandbox/gh), in front of a fake real gh.
      PATH: `${fake}:${bin}:${process.env.PATH}`,
      DECKHAND_REAL_GH: join(fake, "real-gh"),
      DECKHAND_BROKER_URL: "http://listener:8081",
      DECKHAND_RUN_SECRET: "s",
      TASK_ISSUE: "5",
    },
    encoding: "utf8",
  });
  assert.deepEqual(readFileSync(order, "utf8").trim().split("\n"), [
    "git branch",
    "git ls-remote",
    "gh pr list",
    "gh issue view",
    "gh pr create",
    "timeout 20 deckhand-files",
  ]);
  // Outside the hooks, gh uploads first, within 20 s.
  rmSync(order);
  spawnSync(`${bin}gh`, ["pr", "view"], {
    env: {
      ...env,
      DECKHAND_REAL_GH: join(fake, "real-gh"),
      DECKHAND_BROKER_URL: "http://x",
      DECKHAND_RUN_SECRET: "s",
      PATH: `${fake}:${bin}:${process.env.PATH}`,
    },
  });
  assert.deepEqual(readFileSync(order, "utf8").trim().split("\n"), [
    "timeout 20 deckhand-files",
    "gh pr view",
  ]);
  rmSync(join(fake, "git"));
  rmSync(join(fake, "timeout"));
  rmSync(join(fake, "real-gh"));
  // The hooks' stderr is only the run's log (--log); git push's is the agent's.
  assert.equal(readFileSync(calls, "utf8"), "shots --log\n".repeat(3) + "shots\n");
  // A failure blocks no push.
  writeFileSync(join(fake, "deckhand-files"), "#!/bin/sh\nexit 1\n");
  const failing = spawnSync(`${bin}pre-push`, [], { env, input: "", encoding: "utf8" });
  assert.equal(failing.status, 0);
});

// The branch's slug, from draft-pr.sh's own slug(): the gateway only takes issue-<n>-<slug>,
// so it is never empty.
test("draft-pr's branch slug: accents dropped, and never empty", () => {
  const script = readFileSync(`${bin}draft-pr.sh`, "utf8");
  const slug = /^slug\(\) \{[^]*?^\}$/m.exec(script)[0];
  const of = (title) =>
    spawnSync("bash", ["-c", `${slug}\nslug`], { input: title, encoding: "utf8" }).stdout;
  assert.equal(of("Café : bientôt"), "cafe-bientot");
  assert.equal(of("修复登录"), "task");
  assert.equal(of("🔥 !"), "task");
});

test(
  "installing Claude Code refuses to run as the sandbox's user",
  { skip: process.getuid() === 0 },
  () => {
    const result = spawnSync(`${bin}agents/claude/install`, [], {
      env: { PATH: process.env.PATH, CLAUDE_CODE_VERSION: "9.9.9" },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run it as root/);
  },
);

test("for the broker's host, git gets the run's secret: what the git gateway takes", async () => {
  const env = {
    DECKHAND_BROKER_URL: "http://listener:8081",
    DECKHAND_RUN_SECRET: "the-secret",
    REPO_URL: "https://github.com/org/repo.git",
  };
  const res = await helper(env, "protocol=http\nhost=listener:8081\n\n");
  assert.equal(res.stdout, "username=deckhand\npassword=the-secret\n");
});

// --- gh, through the GitHub gateway --------------------------------------------------------------

// The real gh, played by a script: logs its token and arguments.
function fakeGh(t) {
  const dir = tempDir(t, "deckhand-gh-");
  const log = join(dir, "calls");
  const path = join(dir, "gh");
  writeFileSync(path, `#!/bin/bash\necho "$GH_TOKEN $*" >> ${JSON.stringify(log)}\n`);
  chmodSync(path, 0o755);
  return { path, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

function gh(env, ...args) {
  return new Promise((resolve) => {
    execFile(
      `${bin}gh`,
      args,
      { env: { PATH: `${bin}:${process.env.PATH}`, ...env }, timeout: 10000 },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

// `gh pr create`, `edit` and `ready` too: the gateway checks their writes (github-pulls.mjs).
test("every gh command goes to the real gh, with the run's secret as its token", async (t) => {
  const real = fakeGh(t);
  const env = {
    DECKHAND_BROKER_URL: "http://listener:8081",
    DECKHAND_RUN_SECRET: "the-secret",
    DECKHAND_REAL_GH: real.path,
  };
  const commands = [
    ["pr", "view", "7", "--comments"],
    ["issue", "view", "3"],
    ["pr", "create", "--draft", "--head", "issue-1-x", "--title", "t", "--label", "bug"],
    ["pr", "edit", "7", "--add-label", "bug", "--base", "release"],
    ["pr", "ready", "--undo"],
  ];
  for (const args of commands) {
    const res = await gh(env, ...args);
    assert.equal(res.status, 0, res.stderr);
  }
  assert.deepEqual(
    real.calls(),
    commands.map((args) => `the-secret ${args.join(" ")}`),
  );
  // Outside a run, gh as it is: no secret.
  const outside = await gh({ DECKHAND_REAL_GH: real.path, GH_TOKEN: "mine" }, "pr", "ready");
  assert.equal(outside.status, 0);
  assert.equal(real.calls().at(-1), "mine pr ready");
});

// AGENTS.md's syntax check names the scripts one by one: a new one must join the list.
test("AGENTS.md's syntax check covers every script in sandbox/, and they pass it", () => {
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const check = agents.split("\n").find((line) => line.startsWith("| Syntax check"));
  for (const file of readdirSync(bin)) {
    if (statSync(join(bin, file)).isDirectory()) continue;
    const shebang = readFileSync(join(bin, file), "utf8").split("\n")[0];
    const listed = check.includes(file.endsWith(".sh") ? "sandbox/*.sh" : `sandbox/${file}`);
    if (shebang === "#!/bin/bash") {
      assert.ok(listed, `${file} is not in AGENTS.md's syntax check`);
      assert.equal(spawnSync("bash", ["-n", join(bin, file)]).status, 0, `bash -n ${file}`);
    } else if (shebang === "#!/usr/bin/env node") {
      assert.ok(listed, `${file} is not in AGENTS.md's syntax check`);
      assert.equal(
        spawnSync("node", ["--check", join(bin, file)]).status,
        0,
        `node --check ${file}`,
      );
    } else assert.doesNotMatch(shebang, /^#!/, `${file}: a script AGENTS.md doesn't check`);
  }
});

test("npm-install: no install scripts but the package's own, then the version's folder", (t) => {
  const dir = tempDir(t, "deckhand-npm-install-");
  // A fake npm: logs its arguments, and `install` makes the package's bin.
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/bash
echo "$*" >> "${dir}/calls"
if [ "$1" = install ]; then
  prefix=$3
  mkdir -p "$prefix/node_modules/.bin"
  printf '#!/bin/sh\\n' > "$prefix/node_modules/.bin/claude"
  chmod +x "$prefix/node_modules/.bin/claude"
fi
`,
  );
  chmodSync(join(dir, "npm"), 0o755);
  const root = join(dir, "opt");
  mkdirSync(root);
  const run = () =>
    spawnSync(
      `${bin}agents/npm-install`,
      [root, "@anthropic-ai/claude-code", "9.9.9", "claude", "Claude Code"],
      { env: { PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" },
    );
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /Claude Code 9\.9\.9 installed/);
  const [install, rebuild, ...rest] = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  assert.match(
    install,
    /^install --prefix \S+ --ignore-scripts .*@anthropic-ai\/claude-code@9\.9\.9$/,
  );
  // Only the package itself runs its scripts: not its dependencies.
  assert.match(
    rebuild,
    /^rebuild --prefix \S+ --ignore-scripts=false --foreground-scripts .*@anthropic-ai\/claude-code$/,
  );
  assert.deepEqual(rest, []);
  assert.ok(existsSync(join(root, "9.9.9/node_modules/.bin/claude")));
  // Already there: npm isn't run again.
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length, 2);
});
