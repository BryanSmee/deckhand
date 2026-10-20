import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  ConfigError,
  loadConfig,
  normalize,
  parseConfigFile,
  readConfigFile,
  repoAllowed,
  withCredentialFiles,
} from "../listener/config.mjs";

test("refuses to start without allowed users", () => {
  for (const ALLOWED_USERS of [undefined, "", " , ,"]) {
    assert.throws(() => loadConfig({ ALLOWED_USERS }), ConfigError);
  }
});

test("allowed users and repos are lowercase lists", () => {
  const config = loadConfig({
    ALLOWED_USERS: " Alice,BOB ",
    ALLOWED_REPOS: "Org/Repo",
  });
  assert.deepEqual(config.users, ["alice", "bob"]);
  assert.deepEqual(config.repos, ["org/repo"]);
});

test("repoAllowed: ALLOWED_REPOS whatever the case, every repo without it", () => {
  const some = loadConfig({ ALLOWED_USERS: "alice", ALLOWED_REPOS: "Org/Repo" });
  assert.equal(repoAllowed(some, "org/repo"), true);
  assert.equal(repoAllowed(some, "ORG/REPO"), true);
  assert.equal(repoAllowed(some, "org/other"), false);
  assert.equal(repoAllowed(loadConfig({ ALLOWED_USERS: "alice" }), "any/repo"), true);
});

test("repoAllowed: owner/* lets every repo of that owner through, and only that owner", () => {
  const config = loadConfig({ ALLOWED_USERS: "alice", ALLOWED_REPOS: "BryanSmee/*, Org/Repo" });
  assert.deepEqual(config.repos, ["bryansmee/*", "org/repo"]);
  assert.equal(repoAllowed(config, "bryansmee/anything"), true);
  assert.equal(repoAllowed(config, "BryanSmee/Other"), true);
  assert.equal(repoAllowed(config, "org/repo"), true);
  assert.equal(repoAllowed(config, "org/other"), false);
  assert.equal(repoAllowed(config, "bryansmeex/repo"), false);
  assert.equal(repoAllowed(config, "bryansme/repo"), false);
});

test("ALLOWED_REPOS refuses entries that are neither owner/repo nor owner/*", () => {
  for (const entry of ["*", "*/*", "owner", "own*/repo", "owner/re*", "a/b/c", "/repo", "owner/"]) {
    assert.throws(
      () => loadConfig({ ALLOWED_USERS: "alice", ALLOWED_REPOS: `org/app,${entry}` }),
      (error) =>
        error instanceof ConfigError &&
        error.message.startsWith("ALLOWED_REPOS: ") &&
        error.message.includes(entry.toLowerCase()),
      entry,
    );
  }
  assert.throws(
    () => loadConfig({}, file("allowed_users: [a]\nallowed_repos: ['*']")),
    /config\.yaml: allowed_repos: expected owner\/repo or owner\/\*, got \*/,
  );
});

test("names come from settings, with a neutral default", () => {
  const defaults = loadConfig({ ALLOWED_USERS: "a" });
  assert.equal(defaults.image, "deckhand-sandbox");
  assert.equal(defaults.shotsVolume, "deckhand-screenshots");
  assert.equal(defaults.claudeCodeVolume, "deckhand-claude-code");
  assert.equal(defaults.publicUrl, null);
  const custom = loadConfig({
    ALLOWED_USERS: "a",
    NAME_PREFIX: "ops",
    SANDBOX_IMAGE: "registry/img:1",
    PUBLIC_URL: "https://hooks.example.com/",
  });
  assert.equal(custom.image, "registry/img:1");
  assert.equal(custom.publicUrl, "https://hooks.example.com");
});

test("trigger lines are compared loosely", () => {
  assert.equal(normalize("@Deckhand:"), "deckhand");
  assert.equal(normalize("Let’s go!"), "lets go");
});

test("the default trigger is Deckhand", () => {
  assert.equal(loadConfig({ ALLOWED_USERS: "alice" }).trigger, "deckhand");
  assert.equal(loadConfig({ ALLOWED_USERS: "alice", TRIGGER: "Hey Bot!" }).trigger, "hey bot");
});

test("waits check: every 5 minutes by default, never off, junk refused", () => {
  const base = { ALLOWED_USERS: "alice" };
  assert.equal(loadConfig(base).waitsCheckMinutes, 5);
  assert.equal(loadConfig({ ...base, WAITS_CHECK_MINUTES: "2" }).waitsCheckMinutes, 2);
  assert.equal(loadConfig({ ...base, WAITS_CHECK_MINUTES: "" }).waitsCheckMinutes, 5);
  for (const bad of ["0", "-1", "2.5", "soon"]) {
    assert.throws(() => loadConfig({ ...base, WAITS_CHECK_MINUTES: bad }), ConfigError);
  }
});

test("log retention: 90 days by default, 0 keeps everything, junk refused", () => {
  const base = { ALLOWED_USERS: "alice" };
  assert.equal(loadConfig(base).logRetentionDays, 90);
  assert.equal(loadConfig({ ...base, LOG_RETENTION_DAYS: "0" }).logRetentionDays, 0);
  assert.equal(loadConfig({ ...base, LOG_RETENTION_DAYS: "30" }).logRetentionDays, 30);
  assert.equal(loadConfig({ ...base, LOG_RETENTION_DAYS: "" }).logRetentionDays, 90);
  for (const bad of ["-1", "2.5", "forever"]) {
    assert.throws(() => loadConfig({ ...base, LOG_RETENTION_DAYS: bad }), ConfigError);
  }
});

test("RUN_LOG_MAX_MB: megabytes, 200 by default, never 0", () => {
  const base = { ALLOWED_USERS: "alice" };
  assert.equal(loadConfig(base).runLogMax, 200 * 1024 * 1024);
  assert.equal(loadConfig({ ...base, RUN_LOG_MAX_MB: "50" }).runLogMax, 50 * 1024 * 1024);
  for (const bad of ["0", "-1", "2.5", "big"]) {
    assert.throws(() => loadConfig({ ...base, RUN_LOG_MAX_MB: bad }), ConfigError);
  }
});

test("conflict watcher floor: 5 minutes by default, 0 turns it off, junk refused", () => {
  const base = { ALLOWED_USERS: "alice" };
  assert.equal(loadConfig(base).conflictCheckMinutes, 5);
  assert.equal(loadConfig({ ...base, CONFLICT_CHECK_MINUTES: "0" }).conflictCheckMinutes, 0);
  assert.equal(loadConfig({ ...base, CONFLICT_CHECK_MINUTES: " 15 " }).conflictCheckMinutes, 15);
  // Empty is unset, as compose passes a variable .env leaves out.
  assert.equal(loadConfig({ ...base, CONFLICT_CHECK_MINUTES: "" }).conflictCheckMinutes, 5);
  for (const bad of ["-1", "2.5", "soon"]) {
    assert.throws(() => loadConfig({ ...base, CONFLICT_CHECK_MINUTES: bad }), ConfigError);
  }
});

const file = (text) => parseConfigFile(text, "/etc/deckhand/config.yaml");

test("SANDBOX_SUBNETS: an IPv4 range cut into /28 blocks by default, checked, off when empty", () => {
  const base = { ALLOWED_USERS: "a" };
  assert.equal(loadConfig(base).subnets, null);
  assert.equal(loadConfig({ ...base, SANDBOX_SUBNETS: " " }).subnets, null);
  assert.deepEqual(loadConfig({ ...base, SANDBOX_SUBNETS: "10.200.0.0/16" }).subnets, {
    range: "10.200.0.0/16",
    base: 10 * 2 ** 24 + 200 * 2 ** 16,
    prefix: 16,
    size: 28,
  });
  const sized = loadConfig({
    ...base,
    SANDBOX_SUBNETS: "172.30.0.0/24",
    SANDBOX_SUBNET_SIZE: "29",
  });
  assert.equal(sized.subnets.size, 29);
  // CGNAT's and RFC 1918's ranges, whole.
  for (const range of ["100.64.0.0/10", "172.16.0.0/12", "192.168.10.0/24", "10.0.0.0/8"]) {
    assert.equal(loadConfig({ ...base, SANDBOX_SUBNETS: range }).subnets.range, range);
  }
  // One block is enough.
  assert.equal(loadConfig({ ...base, SANDBOX_SUBNETS: "10.9.9.0/28" }).subnets.prefix, 28);
  const bad = [
    [{ SANDBOX_SUBNETS: "10.200.0.0" }, /SANDBOX_SUBNETS: expected an IPv4 range/],
    [{ SANDBOX_SUBNETS: "10.200.1.0/16" }, /SANDBOX_SUBNETS: expected an IPv4 range/],
    [{ SANDBOX_SUBNETS: "10.300.0.0/16" }, /SANDBOX_SUBNETS: expected an IPv4 range/],
    [{ SANDBOX_SUBNETS: "10.0.0.0/33" }, /SANDBOX_SUBNETS: expected an IPv4 range/],
    [{ SANDBOX_SUBNETS: "fd00::/64" }, /SANDBOX_SUBNETS: expected an IPv4 range/],
    [{ SANDBOX_SUBNETS: "10.9.9.0/29" }, /10\.9\.9\.0\/29 is smaller than one block of \/28/],
    // Public ranges, and private ones that spill out of theirs: never a run's network.
    [{ SANDBOX_SUBNETS: "11.0.0.0/8" }, /SANDBOX_SUBNETS: 11\.0\.0\.0\/8 is not a private range/],
    [{ SANDBOX_SUBNETS: "8.8.0.0/16" }, /is not a private range/],
    [{ SANDBOX_SUBNETS: "172.0.0.0/8" }, /is not a private range/],
    [{ SANDBOX_SUBNETS: "100.0.0.0/8" }, /is not a private range/],
    [{ SANDBOX_SUBNETS: "0.0.0.0/0" }, /is not a private range/],
    [{ SANDBOX_SUBNET_SIZE: "30" }, /SANDBOX_SUBNET_SIZE: expected a prefix length from 1 to 29/],
    [{ SANDBOX_SUBNET_SIZE: "0" }, /SANDBOX_SUBNET_SIZE: expected a prefix length from 1 to 29/],
    [{ SANDBOX_SUBNET_SIZE: "/28" }, /SANDBOX_SUBNET_SIZE: expected a prefix length/],
  ];
  for (const [env, pattern] of bad) {
    assert.throws(() => loadConfig({ ...base, ...env }), pattern);
  }
  // From config.yaml, named by its key.
  const yaml = parseConfigFile(
    "allowed_users: [a]\nsandbox_subnets: 10.200.0.0/16\nsandbox_subnet_size: 26",
    "c.yaml",
  );
  assert.equal(loadConfig({}, yaml).subnets.size, 26);
  assert.throws(
    () =>
      loadConfig(
        {},
        parseConfigFile("allowed_users: [a]\nsandbox_subnets: 10.200.0.1/16", "c.yaml"),
      ),
    /c\.yaml: sandbox_subnets: expected an IPv4 range/,
  );
});

test("config.yaml sets what the environment leaves out, as YAML lists and values", () => {
  const config = loadConfig(
    {},
    file(`
allowed_users: [Alice, bob]
allowed_repos:
  - org/api
  - Team/*
trigger: Hey Bot
sandbox_model: sonnet
max_parallel: 3
onboarding: false
needs_input_label: ""
conflict_check_minutes: 0
claude_code_version: 2.1.300
`),
  );
  assert.deepEqual(config.users, ["alice", "bob"]);
  assert.deepEqual(config.repos, ["org/api", "team/*"]);
  assert.equal(repoAllowed(config, "team/web"), true);
  assert.equal(config.trigger, "hey bot");
  assert.equal(config.model, "sonnet");
  assert.equal(config.brainstormModel, "sonnet");
  // Limits are the grants folder's (default.yaml), over these.
  assert.deepEqual(config.limits, { cpus: "2", memory: "4g", pids: 2048 });
  assert.equal(config.maxParallel, 3);
  assert.equal(config.onboarding, false);
  assert.equal(config.needsInputLabel, "");
  assert.equal(config.conflictCheckMinutes, 0);
  assert.equal(config.claudeCodeVersion, "2.1.300");
});

test("a set, non-empty environment variable overrides config.yaml, of every type", () => {
  const yaml = file(`
allowed_users: [alice]
trigger: Bot
max_parallel: 3
onboarding: true
needs_input_label: waiting
`);
  const config = loadConfig(
    {
      ALLOWED_USERS: "carol,dan",
      TRIGGER: "Other",
      MAX_PARALLEL: "5",
      ONBOARDING: "off",
      NEEDS_INPUT_LABEL: "",
    },
    yaml,
  );
  assert.deepEqual(config.users, ["carol", "dan"]);
  assert.equal(config.trigger, "other");
  assert.equal(config.maxParallel, 5);
  assert.equal(config.onboarding, false);
  // Empty means no label, so set in the environment it still wins.
  assert.equal(config.needsInputLabel, "");

  // Empty elsewhere is unset: compose passes `${TRIGGER:-}` when .env leaves it out.
  const kept = loadConfig({ ALLOWED_USERS: "", TRIGGER: "", MAX_PARALLEL: "" }, yaml);
  assert.deepEqual(kept.users, ["alice"]);
  assert.equal(kept.trigger, "bot");
  assert.equal(kept.maxParallel, 3);
  assert.equal(kept.needsInputLabel, "waiting");
});

test("config.yaml refuses unknown keys, wrong types and secrets, naming each", () => {
  const refuse = (text, pattern) => assert.throws(() => file(text), pattern);
  refuse("allowed_user: [a]", /config\.yaml: allowed_user: unknown/);
  refuse("ALLOWED_USERS: [a]", /ALLOWED_USERS: unknown/);
  refuse("broker_url: http://x", /broker_url: unknown/);
  refuse("anthropic_api_key: sk-1", /anthropic_api_key: a secret/);
  refuse("claude_code_oauth_token: t", /claude_code_oauth_token: a secret/);
  refuse("anthropic_auth_token: sk-or-1", /anthropic_auth_token: a secret/);
  refuse("allowed_users: alice\nmax_parallel: [1]", /max_parallel: expected a value/);
  refuse("allowed_users: {a: 1}", /allowed_users: expected a list/);
  refuse("[a, b]", /config\.yaml: line 1/);
  refuse("a: [", /config\.yaml/);
  assert.throws(
    () => file("trigger: x\nfoo: 1\nanthropic_api_key: k"),
    (error) =>
      error instanceof ConfigError && /foo/.test(error.message) && /anthropic/.test(error.message),
  );
});

test("a gateway: its address and model names from config.yaml, checked", () => {
  const base = "allowed_users: [a]\n";
  const config = loadConfig(
    {},
    file(`${base}anthropic_base_url: https://openrouter.ai/api/
anthropic_default_opus_model: anthropic/claude-opus-4.1
anthropic_default_haiku_model: meta-llama/llama-4:free
sandbox_model: openai/gpt-5
`),
  );
  assert.equal(config.anthropicUrl, "https://openrouter.ai/api");
  assert.deepEqual(config.modelAliases, {
    ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.1",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "meta-llama/llama-4:free",
  });
  assert.equal(config.model, "openai/gpt-5");

  // Without them, Anthropic and Claude Code's own names.
  const plain = loadConfig({}, file(base));
  assert.equal(plain.anthropicUrl, "https://api.anthropic.com");
  assert.deepEqual(plain.modelAliases, {});

  assert.throws(
    () => loadConfig({}, file(`${base}anthropic_base_url: openrouter.ai`)),
    /config\.yaml: anthropic_base_url: expected an http\(s\) URL/,
  );
  assert.throws(
    () => loadConfig({ ANTHROPIC_DEFAULT_SONNET_MODEL: "two words" }, file(base)),
    /ANTHROPIC_DEFAULT_SONNET_MODEL: expected a model name/,
  );
});

test("a bad value in config.yaml names its key, one in the environment its variable", () => {
  const base = "allowed_users: [a]\n";
  const bad = [
    ["max_parallel: lots", /config\.yaml: max_parallel: expected/],
    ["onboarding: maybe", /config\.yaml: onboarding: expected on or off/],
    ["debounce_ms: 1.5", /config\.yaml: debounce_ms: expected/],
  ];
  for (const [line, pattern] of bad) {
    assert.throws(() => loadConfig({}, file(base + line)), pattern);
  }
  assert.throws(
    () => loadConfig({ MAX_PARALLEL: "lots" }, file(base + "max_parallel: 2")),
    /MAX_PARALLEL: expected/,
  );
  assert.throws(() => loadConfig({}, file("trigger: x")), /ALLOWED_USERS is empty/);
});

test("ALLOWED_HOSTS and SANDBOX_CPUS/MEMORY/PIDS are gone: the listener names grants/default.yaml", () => {
  const users = { ALLOWED_USERS: "a" };
  assert.throws(
    () => loadConfig({ ...users, ALLOWED_HOSTS: "pypi.org" }),
    /ALLOWED_HOSTS is gone \(ALLOWED_HOSTS: set hosts in grants\/default\.yaml instead/,
  );
  assert.throws(
    () => loadConfig({ ...users, SANDBOX_CPUS: "4", SANDBOX_PIDS: "100" }),
    /SANDBOX_CPUS, SANDBOX_PIDS are gone \(SANDBOX_CPUS: set limits\.cpus in grants\/default\.yaml; SANDBOX_PIDS: set limits\.pids/,
  );
  // Empty, as an older compose.yaml passes them: nothing to move.
  assert.equal(loadConfig({ ...users, ALLOWED_HOSTS: "", SANDBOX_MEMORY: "" }).users[0], "a");
  // In config.yaml, even empty: every one named.
  assert.throws(
    () => parseConfigFile("allowed_hosts: []\nsandbox_memory: 8g\nsandbox_pids: 10\n", "c.yaml"),
    (error) =>
      /c\.yaml: allowed_hosts: gone, set hosts in grants\/default\.yaml instead/.test(
        error.message,
      ) &&
      /sandbox_memory: gone, set limits\.memory in grants\/default\.yaml/.test(error.message) &&
      /sandbox_pids: gone, set limits\.pids/.test(error.message),
  );
  assert.equal("hosts" in loadConfig(users), false);
});

test("without config.yaml, the environment alone, as before", () => {
  const read = () => {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  };
  assert.deepEqual(readConfigFile({}, read).settings, {});
  assert.deepEqual(
    loadConfig({ ALLOWED_USERS: "a" }, readConfigFile({}, read)),
    loadConfig({ ALLOWED_USERS: "a" }),
  );
  // Named on purpose, it has to be there.
  assert.throws(() => readConfigFile({ CONFIG_FILE: "/x.yaml" }, read), /reading \/x\.yaml/);
  let path;
  const found = readConfigFile({ CONFIG_FILE: "/ops/deckhand.yaml" }, (p) => {
    path = p;
    return "allowed_users: [a]";
  });
  assert.equal(path, "/ops/deckhand.yaml");
  assert.deepEqual(found.settings, { ALLOWED_USERS: "a" });
  assert.equal(readConfigFile({}, () => "").settings.ALLOWED_USERS, undefined);
});

test("server.example/config.yaml is a valid config.yaml", () => {
  const text = readFileSync(new URL("../server.example/config.yaml", import.meta.url), "utf8");
  const file = parseConfigFile(text, "server.example/config.yaml");
  // No login of its own: copied as is, it allows nobody until the operator adds theirs.
  assert.throws(() => loadConfig({}, file), /ALLOWED_USERS/);
  assert.deepEqual(loadConfig({ ALLOWED_USERS: "alice" }, file).users, ["alice"]);
});

test("SANDBOX_ENGINE: none by default, sysbox, podman or auto; a typo is an error", () => {
  assert.equal(loadConfig({ ALLOWED_USERS: "a" }).engine, null);
  assert.equal(loadConfig({ ALLOWED_USERS: "a", SANDBOX_ENGINE: " Sysbox " }).engine, "sysbox");
  assert.equal(loadConfig({ ALLOWED_USERS: "a", SANDBOX_ENGINE: "auto" }).engine, "auto");
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", SANDBOX_ENGINE: "docker" }),
    /SANDBOX_ENGINE: expected sysbox, podman, auto or nothing, got docker/,
  );
  const defaults = loadConfig({ ALLOWED_USERS: "a" });
  assert.equal(defaults.engineImage, "deckhand-engine");
  assert.equal(defaults.enginePodmanImage, "deckhand-engine-podman");
  const file = parseConfigFile("sandbox_engine: podman\n", "config.yaml");
  assert.equal(loadConfig({ ALLOWED_USERS: "a" }, file).engine, "podman");
});

test("agents: Claude Code by default; Codex with OPENAI_API_KEY, for work or light runs", () => {
  const plain = loadConfig({ ALLOWED_USERS: "a" });
  assert.equal(plain.agent, "claude");
  assert.equal(plain.brainstormAgent, "claude");
  assert.deepEqual(plain.agents, ["claude"]);
  assert.equal(plain.openaiCredential, null);
  assert.equal(plain.openaiUrl, "https://api.openai.com/v1");
  assert.equal(plain.codexVersion, "0.162.1");
  assert.equal(plain.codexVolume, "deckhand-codex");
  assert.deepEqual(plain.codexModels, {});

  // A key makes Codex one a repo may pick; Claude Code stays the default.
  const both = loadConfig({
    ALLOWED_USERS: "a",
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    OPENAI_API_KEY: "sk-proj-1",
  });
  assert.equal(both.agent, "claude");
  assert.deepEqual(both.agents, ["claude", "codex"]);
  assert.equal(both.openaiCredential, "OPENAI_API_KEY");

  // Codex for everything: Claude Code, without a credential, isn't one a repo may pick.
  const codex = loadConfig(
    { OPENAI_API_KEY: "sk-proj-1" },
    file(`allowed_users: [a]
sandbox_agent: Codex
openai_base_url: https://gateway.example/openai/v1/
codex_fast_model: gpt-6-mini
codex_version: 0.170.0
`),
  );
  assert.equal(codex.agent, "codex");
  assert.equal(codex.brainstormAgent, "codex");
  assert.deepEqual(codex.agents, ["codex"]);
  assert.equal(codex.openaiUrl, "https://gateway.example/openai/v1");
  assert.deepEqual(codex.codexModels, { fast: "gpt-6-mini" });
  assert.equal(codex.codexVersion, "0.170.0");
  // Light runs on Claude Code, work on Codex.
  const split = loadConfig({
    ALLOWED_USERS: "a",
    OPENAI_API_KEY: "k",
    SANDBOX_AGENT: "codex",
    BRAINSTORM_AGENT: "claude",
  });
  assert.deepEqual(
    [split.agent, split.brainstormAgent, split.agents],
    ["codex", "claude", ["claude", "codex"]],
  );
});

test("agents: an unknown one, or Codex without its key, stops the listener", () => {
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", SANDBOX_AGENT: "gemini" }),
    /SANDBOX_AGENT: expected claude, codex, antigravity, got gemini/,
  );
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", SANDBOX_AGENT: "codex" }),
    /SANDBOX_AGENT is codex, which needs OPENAI_API_KEY or CODEX_AUTH_FILE in the environment/,
  );
  assert.throws(
    () => loadConfig({}, file("allowed_users: [a]\nbrainstorm_agent: codex")),
    /config\.yaml: brainstorm_agent is codex, which needs OPENAI_API_KEY/,
  );
  assert.throws(() => file("openai_api_key: sk-1"), /openai_api_key: a secret/);
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", CODEX_BEST_MODEL: "two words" }),
    /CODEX_BEST_MODEL: expected a model name/,
  );
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", OPENAI_BASE_URL: "api.openai.com" }),
    /OPENAI_BASE_URL: expected an http\(s\) URL/,
  );
});

test("Codex: an API key, else a ChatGPT plan's login (CODEX_AUTH_FILE), environment only", () => {
  const plan = loadConfig({
    ALLOWED_USERS: "a",
    SANDBOX_AGENT: "codex",
    CODEX_AUTH_FILE: "/data/a.json",
  });
  assert.equal(plan.openaiCredential, "CODEX_AUTH_FILE");
  assert.deepEqual(plan.agents, ["codex"]);
  const both = loadConfig({ ALLOWED_USERS: "a", OPENAI_API_KEY: "k", CODEX_AUTH_FILE: "/a.json" });
  assert.equal(both.openaiCredential, "OPENAI_API_KEY");
  assert.equal(loadConfig({ ALLOWED_USERS: "a" }).openaiCredential, null);
  assert.throws(() => file("codex_auth_file: /data/a.json"), /codex_auth_file: a secret/);
});

test("the plans' logins: found in the credentials folder unless their variable is set", () => {
  const present = new Set(["/d/credentials/codex-auth.json", "/d/credentials/agy-auth.json"]);
  const exists = (path) => present.has(path);
  const env = { DATA_DIR: "/d", ALLOWED_USERS: "a" };
  const found = withCredentialFiles(env, exists);
  assert.equal(found.CODEX_AUTH_FILE, "/d/credentials/codex-auth.json");
  assert.equal(found.AGY_AUTH_FILE, "/d/credentials/agy-auth.json");
  assert.equal(loadConfig(found).openaiCredential, "CODEX_AUTH_FILE");
  assert.equal(loadConfig(found).agyCredential, "AGY_AUTH_FILE");
  assert.equal(env.CODEX_AUTH_FILE, undefined);
  // The variable wins; /data by default; nothing found, the same environment.
  const set = withCredentialFiles({ ...env, AGY_AUTH_FILE: "/elsewhere.json" }, exists);
  assert.equal(set.AGY_AUTH_FILE, "/elsewhere.json");
  const looked = [];
  const none = { ALLOWED_USERS: "a" };
  assert.equal(
    withCredentialFiles(none, (path) => looked.push(path) && false),
    none,
  );
  assert.deepEqual(looked, [
    "/data/credentials/codex-auth.json",
    "/data/credentials/agy-auth.json",
  ]);
});

test("the Antigravity CLI: GEMINI_API_KEY or a Google AI plan's login (AGY_AUTH_FILE), its version, tiers and volumes", () => {
  const plan = loadConfig(
    { SANDBOX_AGENT: "antigravity", AGY_AUTH_FILE: "/data/agy-auth.json" },
    file(
      "allowed_users: [a]\ngemini_base_url: https://gateway.example/gemini/\nagy_best_model: gemini-4-argon-medium\nagy_version: 1.5.0",
    ),
  );
  assert.equal(plan.agyCredential, "AGY_AUTH_FILE");
  assert.equal(plan.geminiUrl, "https://gateway.example/gemini");
  assert.deepEqual(plan.agents, ["antigravity"]);
  assert.deepEqual(plan.agyModels, { best: "gemini-4-argon-medium" });
  assert.equal(plan.agyVersion, "1.5.0");
  assert.equal(plan.agyVolume, "deckhand-antigravity");
  assert.equal(plan.agyLoginVolume, "deckhand-antigravity-login");
  // GEMINI_API_KEY wins over AGY_AUTH_FILE, like OPENAI_API_KEY over CODEX_AUTH_FILE.
  const both = loadConfig({
    ALLOWED_USERS: "a",
    GEMINI_API_KEY: "AIza-1",
    AGY_AUTH_FILE: "/data/agy-auth.json",
  });
  assert.equal(both.agyCredential, "GEMINI_API_KEY");
  assert.deepEqual(both.agents, ["claude", "antigravity"]);
  const defaults = loadConfig({ ALLOWED_USERS: "a", NAME_PREFIX: "dh" });
  assert.equal(defaults.agyCredential, null);
  assert.equal(defaults.geminiUrl, "https://generativelanguage.googleapis.com");
  assert.equal(defaults.agyVersion, "1.4.0");
  assert.equal(defaults.agyLoginVolume, "dh-antigravity-login");
  // Picked without a credential: the listener doesn't start, and a repo can't pick it.
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", SANDBOX_AGENT: "antigravity" }),
    /SANDBOX_AGENT is antigravity, which needs GEMINI_API_KEY or AGY_AUTH_FILE in the environment/,
  );
  assert.deepEqual(defaults.agents, ["claude"]);
  assert.throws(() => file("gemini_api_key: AIza-1"), /gemini_api_key: a secret/);
  assert.throws(() => file("agy_auth_file: /data/a.json"), /agy_auth_file: a secret/);
  // antigravity@google as a fallback, with its key or login.
  const fallback = loadConfig({
    ALLOWED_USERS: "a",
    AGY_AUTH_FILE: "/data/agy-auth.json",
    FALLBACKS: "codex, antigravity",
    OPENAI_API_KEY: "k",
  });
  assert.deepEqual(fallback.fallbacks, ["codex@openai", "antigravity@google"]);
  assert.deepEqual(fallback.agents, ["claude", "codex", "antigravity"]);
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", FALLBACKS: "antigravity@google" }),
    /FALLBACKS: antigravity@google needs GEMINI_API_KEY or AGY_AUTH_FILE in the environment/,
  );
});

test("FALLBACKS: none by default; agent@provider entries in order, each with its credential", () => {
  assert.deepEqual(loadConfig({ ALLOWED_USERS: "a" }).fallbacks, []);
  const config = loadConfig(
    { CLAUDE_CODE_OAUTH_TOKEN: "t", OPENROUTER_API_KEY: "sk-or-1", OPENAI_API_KEY: "sk-proj-1" },
    file(`allowed_users: [a]
fallbacks: [Claude@OpenRouter, codex, claude, codex@openai]
openrouter_base_url: https://gateway.example/api/
openrouter_opus_model: anthropic/claude-opus-4.1
claude_fallback_model: sonnet
`),
  );
  // An agent alone is its default provider; each entry once.
  assert.deepEqual(config.fallbacks, ["claude@openrouter", "codex@openai", "claude@anthropic"]);
  assert.equal(config.openrouterUrl, "https://gateway.example/api");
  assert.deepEqual(config.openrouterAliases, {
    ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.1",
  });
  assert.equal(config.claudeFallbackModel, "sonnet");
  assert.equal(loadConfig({ ALLOWED_USERS: "a" }).openrouterUrl, "https://openrouter.ai/api");
});

test("FALLBACKS: an unknown entry, or one without its credential, stops the listener", () => {
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", FALLBACKS: "gemini" }),
    /FALLBACKS: expected agent@provider \(claude@anthropic, claude@openrouter, codex@openai, antigravity@google\), got gemini/,
  );
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", OPENAI_API_KEY: "k", FALLBACKS: "codex@openrouter" }),
    /FALLBACKS: expected agent@provider .*got codex@openrouter/,
  );
  assert.throws(
    () =>
      loadConfig({
        ALLOWED_USERS: "a",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        FALLBACKS: "claude@openrouter",
      }),
    /FALLBACKS: claude@openrouter needs OPENROUTER_API_KEY in the environment/,
  );
  assert.throws(
    () => loadConfig({}, file("allowed_users: [a]\nfallbacks: [codex]")),
    /config\.yaml: fallbacks: codex@openai needs OPENAI_API_KEY/,
  );
  assert.throws(() => file("openrouter_api_key: sk-or-1"), /openrouter_api_key: a secret/);
});
