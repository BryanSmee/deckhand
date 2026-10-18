// The sandbox's side of the broker: git's credential helper asks it for a token per call.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createPrReady } from "../listener/pr-ready.mjs";
import { serve, tempDir } from "./helpers.mjs";

const bin = new URL("../sandbox/", import.meta.url).pathname;

async function broker(t) {
  let n = 0;
  const b = createBroker({
    app: () => ({
      repoToken: async () => ({
        token: `fresh-${++n}`,
        expiresAt: Date.now() + 1,
      }),
    }),
  });
  const { url } = await serve(t, (req, res) => b.handle(req, res));
  return { b, url };
}

// Async: the broker answers from this same process.
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

test("git gets a fresh token for the repo's host on each call", async (t) => {
  const { b, url } = await broker(t);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: b.register("org/repo", undefined, { push: true }),
    REPO_URL: "https://github.com/org/repo.git",
  };
  const ask = "protocol=https\nhost=github.com\n\n";
  assert.equal((await helper(env, ask)).stdout, "username=x-access-token\npassword=fresh-1\n");
  assert.equal((await helper(env, ask)).stdout, "username=x-access-token\npassword=fresh-2\n");
  // Another host never sees the token.
  assert.equal((await helper(env, "protocol=https\nhost=evil.example\n\n")).stdout, "");
});

test("a finished run's helper answers nothing, so git fails instead of using a stale token", async (t) => {
  const { b, url } = await broker(t);
  const secret = b.register("org/repo", undefined, { push: true });
  b.revoke(secret);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: secret,
    REPO_URL: "https://github.com/o/r",
  };
  const res = await helper(env, "protocol=https\nhost=github.com\n\n");
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
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
  const fns = ["reset_clone", "clean_git_dir"]
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
      git config remote.origin.url https://example.com/elsewhere.git`,
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
    // Not just during the reset: the checkout draft-pr.sh may do next runs no hook either.
    sh(clone, "git checkout -q feat && git checkout -q -");
    assert.ok(!existsSync(hooked), "a git hook ran");
  };
  return { sh, origin, clone, leave, reset, clean, script };
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

test("for the broker's host, git gets the run's secret: what the git gateway takes", async (t) => {
  const { b, url } = await broker(t);
  const secret = b.register("org/repo", undefined, { push: true });
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: secret,
    REPO_URL: "https://github.com/org/repo.git",
  };
  const host = new URL(url).host;
  const res = await helper(env, `protocol=http\nhost=${host}\n\n`);
  assert.equal(res.stdout, `username=deckhand\npassword=${secret}\n`);
});

// --- gh pr ready, through the listener ---------------------------------------------------------

// A broker that also marks pull requests ready (pr-ready.mjs): `mutations` are its calls to
// GitHub. Pull request 7 of org/repo is a draft, 8 is ready.
async function prBroker(t) {
  const mutations = [];
  const github = {
    repoToken: async () => ({ token: "token", expiresAt: Date.now() + 3600000 }),
    request: async (repo, method, path) => {
      const number = Number(path.split("/").pop());
      return Response.json({
        draft: number === 7,
        node_id: `PR_${number}`,
        base: { repo: { full_name: repo } },
        head: { ref: "issue-1-x", repo: { full_name: repo } },
      });
    },
  };
  const b = createBroker({ app: () => github });
  const prReady = createPrReady({
    broker: b,
    app: () => github,
    fetch: async (url, { body }) => {
      const { query, variables } = JSON.parse(body);
      mutations.push(`${/\{ (\w+)\(/.exec(query)[1]} ${variables.id}`);
      return Response.json({ data: {} });
    },
  });
  const { url } = await serve(t, (req, res) =>
    (req.url.startsWith("/pr/") ? prReady : b).handle(req, res),
  );
  return { b, mutations, url };
}

// The real gh, played by a script: logs its arguments and token, and finds pull request 7 for
// the current branch, or the number it was given.
function fakeGh(t) {
  const dir = tempDir(t, "deckhand-gh-");
  const log = join(dir, "calls");
  const path = join(dir, "gh");
  writeFileSync(
    path,
    `#!/bin/bash
echo "$GH_TOKEN $*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "pr view" ]; then
  n=7
  case \${3:-} in [0-9]*) n=$3 ;; esac
  echo "https://github.com/org/repo/pull/$n"
fi
`,
  );
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

test("gh pr ready goes to the listener, with or without a number, and --undo too", async (t) => {
  const { b, mutations, url } = await prBroker(t);
  const real = fakeGh(t);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: b.register("org/repo", undefined, { push: true }),
    DECKHAND_REAL_GH: real.path,
  };
  b.allow(env.DECKHAND_RUN_SECRET, ["issue-1-*"]);
  const current = await gh(env, "pr", "ready");
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /org\/repo#7 is marked as ready for review/);
  assert.equal((await gh(env, "pr", "ready", "8", "--undo")).status, 0);
  assert.equal((await gh(env, "pr", "ready", "--undo", "-R", "org/repo", "8")).status, 0);
  assert.deepEqual(mutations, [
    "markPullRequestReadyForReview PR_7",
    "convertPullRequestToDraft PR_8",
    "convertPullRequestToDraft PR_8",
  ]);
  // The real gh only looked the pull requests up, with a fresh token.
  assert.deepEqual(real.calls(), [
    "token pr view --json url --jq .url",
    "token pr view 8 --json url --jq .url",
    "token pr view 8 --repo org/repo --json url --jq .url",
  ]);
});

test("a refused gh pr ready fails with the listener's reason", async (t) => {
  const { b, mutations, url } = await prBroker(t);
  const real = fakeGh(t);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: b.register("org/repo", { pull_requests: "read" }, { push: false }),
    DECKHAND_REAL_GH: real.path,
  };
  const res = await gh(env, "pr", "ready", "7");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /this run can't change pull requests/);
  assert.deepEqual(mutations, []);
});

test("other gh commands go to the real gh, with a fresh token", async (t) => {
  const { b, mutations, url } = await prBroker(t);
  const real = fakeGh(t);
  const env = {
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: b.register("org/repo", undefined, { push: true }),
    DECKHAND_REAL_GH: real.path,
  };
  assert.equal((await gh(env, "pr", "edit", "7", "--title", "x")).status, 0);
  assert.equal((await gh(env, "issue", "view", "3")).status, 0);
  assert.deepEqual(real.calls(), ["token pr edit 7 --title x", "token issue view 3"]);
  assert.deepEqual(mutations, []);
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
