// The operator's settings, from the environment and config.yaml. Names of images, volumes and
// networks come from here so nothing in the listener is tied to one deployment. What the
// operator grants one repo (hosts, mounts, limits) is in its grants folder instead (grants.mjs).
import { readFileSync } from "node:fs";
import { CREDENTIALS, credentialName } from "./anthropic.mjs";
import { hostProblem } from "./egress.mjs";
import { MODEL_NAME } from "./events.mjs";
import { isMap, parseYaml } from "./yaml.mjs";

export class ConfigError extends Error {}

// "a, B,,c" → ["a", "b", "c"]: GitHub logins and repo names are case-insensitive.
export function list(value) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// "@Deckhand:" matches "deckhand", "Let's go!" matches "lets go".
export function normalize(line) {
  return line
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A sandbox's CPU, memory and pids limits: { cpus: "2", memory: "4g", pids: 2048 } → the
// same, checked, or a ConfigError naming the key with `label`. Missing keys keep `base`'s.
export function parseLimits(value, base, label) {
  const limits = { ...base };
  for (const [key, raw] of Object.entries(value ?? {})) {
    const text = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (key === "cpus" && /^\d+(\.\d+)?$/.test(text) && Number(text) > 0) limits.cpus = text;
    else if (key === "memory" && /^\d+[kmg]?$/.test(text) && parseInt(text) > 0)
      limits.memory = text;
    else if (key === "pids" && /^\d+$/.test(text) && Number(text) > 0) limits.pids = Number(text);
    else if (["cpus", "memory", "pids"].includes(key)) {
      throw new ConfigError(`${label(key)}: expected ${LIMIT_FORMAT[key]}, got ${raw}`);
    } else throw new ConfigError(`${label(key)}: unknown (cpus, memory or pids)`);
  }
  return limits;
}

const LIMIT_FORMAT = {
  cpus: "a number of CPUs (2, 0.5)",
  memory: "an amount (512m, 4g)",
  pids: "a whole number",
};

// What config.yaml may set: each setting's environment variable, in lowercase as the key,
// with the YAML it takes. Secrets and the wiring compose.yaml sets to match its own services
// stay in the environment only.
export const FILE_SETTINGS = {
  ALLOWED_USERS: "list",
  ALLOWED_REPOS: "list",
  ALLOWED_HOSTS: "list",
  PUBLIC_URL: "scalar",
  TRIGGER: "scalar",
  CLAUDE_CODE_VERSION: "scalar",
  ANTHROPIC_BASE_URL: "scalar",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "scalar",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "scalar",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "scalar",
  SANDBOX_MODEL: "scalar",
  SANDBOX_EFFORT: "scalar",
  BRAINSTORM_MODEL: "scalar",
  BRAINSTORM_EFFORT: "scalar",
  BRAINSTORM_IDLE_MINUTES: "scalar",
  MAX_PARALLEL: "scalar",
  SANDBOX_CPUS: "scalar",
  SANDBOX_MEMORY: "scalar",
  SANDBOX_PIDS: "scalar",
  ONBOARDING: "boolean",
  NEEDS_INPUT_LABEL: "scalar",
  CONFLICT_CHECK_MINUTES: "scalar",
  WAITS_CHECK_MINUTES: "scalar",
  NAME_PREFIX: "scalar",
  CLAUDE_CODE_VOLUME: "scalar",
  GRANTS_DIR: "scalar",
  INSTALL_NETWORK: "scalar",
  DEBOUNCE_MS: "scalar",
  BRAINSTORM_DEBOUNCE_MS: "scalar",
  GITHUB_URL: "scalar",
  GITHUB_API: "scalar",
};

// Where an empty value means something (no label): set in the environment, even empty, wins.
const EMPTY_MEANS = new Set(["NEEDS_INPUT_LABEL"]);

const TYPE_FORMAT = {
  list: "a list",
  scalar: "a value (not a list or a mapping)",
  boolean: "true or false",
};

// One value of config.yaml as the environment would hold it, or undefined when it has the
// wrong type: loadConfig() then checks it as it checks the variable.
function fileValue(value, type) {
  const scalar = (v) => typeof v === "string" || typeof v === "number";
  if (type === "list" && Array.isArray(value) && value.every(scalar)) return value.join(",");
  if (type === "boolean" && typeof value === "boolean") return value ? "on" : "off";
  if (scalar(value)) return String(value);
}

// config.yaml's text → { path, settings: { ALLOWED_USERS: "a,b", … } }. Fails closed: any
// unknown key, wrong type or secret refuses to start, every one named.
export function parseConfigFile(text, path) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${path}: ${error.message}`);
  }
  if (raw === null) return { path, settings: {} };
  if (!isMap(raw))
    throw new ConfigError(`${path}: expected settings (key: value) at the top level`);
  const settings = {};
  const errors = [];
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toUpperCase();
    const type = key === name.toLowerCase() ? FILE_SETTINGS[name] : undefined;
    if (CREDENTIALS.includes(name)) {
      errors.push(`${key}: a secret, keep it in the environment (.env), not in a file`);
    } else if (name === "GRANTS_FILE") {
      errors.push(`${key}: gone, one file per repository in grants_dir instead (docs/security.md)`);
    } else if (!type) {
      errors.push(`${key}: unknown (secrets and compose.yaml's wiring are environment only)`);
    } else if (value !== null) {
      const text = fileValue(value, type);
      if (text === undefined) errors.push(`${key}: expected ${TYPE_FORMAT[type]}`);
      else settings[name] = text;
    }
  }
  if (errors.length) throw new ConfigError(`${path}: ${errors.join("; ")}`);
  return { path, settings };
}

// CONFIG_FILE, read once at start (a restart applies an edit). No file: no settings, unless
// CONFIG_FILE names one, which then has to be there.
export function readConfigFile(env, read = (path) => readFileSync(path, "utf8")) {
  const path = env.CONFIG_FILE || "/etc/deckhand/config.yaml";
  let text;
  try {
    text = read(path);
  } catch (error) {
    if (error.code === "ENOENT" && !env.CONFIG_FILE) return NO_FILE;
    throw new ConfigError(`reading ${path}: ${error.message}`);
  }
  return parseConfigFile(text, path);
}

const NO_FILE = { path: null, settings: {} };

// A set, non-empty environment variable, else config.yaml's key; and how an error names it.
function settings(env, file) {
  const fromEnv = (name) => env[name] != null && (env[name] !== "" || EMPTY_MEANS.has(name));
  const setting = (name) => (fromEnv(name) ? env[name] : file.settings[name]);
  const label = (name) =>
    fromEnv(name) || !(name in file.settings) ? name : `${file.path}: ${name.toLowerCase()}`;
  const number = (name, fallback, what) => wholeNumber(setting(name), fallback, label(name), what);
  return { setting, label, number };
}

// WAITS_CHECK_MINUTES: the check catches missed deliveries, so it can't be turned off.
function waitsCheck({ number, label }) {
  const minutes = number("WAITS_CHECK_MINUTES", 5, "a whole number of minutes above 0");
  if (!minutes) throw new ConfigError(`${label("WAITS_CHECK_MINUTES")}: expected above 0, got 0`);
  return minutes;
}

// "15" → 15, or a ConfigError naming the setting: NaN would be a silent 0 or forever.
function wholeNumber(value, fallback, label, what) {
  const text = String(value ?? fallback).trim();
  if (!/^\d+$/.test(text)) throw new ConfigError(`${label}: expected ${what}, got ${value}`);
  return Number(text);
}

// Where sandboxes run, what they get and what they may reach.
function sandboxConfig(env, { setting, label, number }, prefix, hosts) {
  return {
    prefix,
    image: env.SANDBOX_IMAGE || `${prefix}-sandbox`,
    shotsVolume: env.SHOTS_VOLUME || `${prefix}-screenshots`,
    // Each run's inbox (runner/docker.mjs), mounted by the listener at <dataDir>/runs.
    runsVolume: env.RUNS_VOLUME || `${prefix}-runs`,
    // Claude Code is not in the image: the first run installs this version into the volume.
    claudeCodeVolume: setting("CLAUDE_CODE_VOLUME") || `${prefix}-claude-code`,
    claudeCodeVersion: setting("CLAUDE_CODE_VERSION") || "2.1.300",
    maxParallel: number("MAX_PARALLEL", 2, "a whole number of sandboxes"),
    hosts,
    // Per sandbox; a repo's grants may set its own.
    limits: parseLimits(
      {
        cpus: setting("SANDBOX_CPUS") || "2",
        memory: setting("SANDBOX_MEMORY") || "4g",
        pids: setting("SANDBOX_PIDS") || "2048",
      },
      {},
      (key) => label(`SANDBOX_${key.toUpperCase()}`),
    ),
    // The only way out of the runs' networks (../proxy/proxy.mjs).
    egressProxy: (env.EGRESS_PROXY || "http://egress:3128").replace(/\/$/, ""),
    // The containers joined to each run's network (runner/docker.mjs): by default, the one
    // the listener runs in and the one compose.yaml labels deckhand.role=egress.
    listenerContainer: env.LISTENER_CONTAINER || "",
    egressContainer: env.EGRESS_CONTAINER || "",
    // What the operator grants each repo, one file per repo: hosts, host mounts, limits
    // (grants.mjs).
    grantsDir: setting("GRANTS_DIR") || "/etc/deckhand/grants",
    // Claude Code's install container downloads from npm, outside the runs' networks.
    installNetwork: setting("INSTALL_NETWORK") || "bridge",
    // The host's Docker socket, as preview hooks mount it.
    dockerSocket: env.DOCKER_SOCKET || "/var/run/docker.sock",
  };
}

// "https://openrouter.ai/api/" → "https://openrouter.ai/api", or a ConfigError: a typo would
// otherwise only show as every run failing.
function anthropicUrl(value, label) {
  if (!value) return "https://api.anthropic.com";
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (!["http:", "https:"].includes(url?.protocol)) {
    throw new ConfigError(`${label}: expected an http(s) URL, got ${value}`);
  }
  return value.replace(/\/$/, "");
}

function modelName(value, label) {
  if (MODEL_NAME.test(value)) return value;
  throw new ConfigError(`${label}: expected a model name (anthropic/claude-…), got ${value}`);
}

// The environment, over config.yaml's settings (readConfigFile()), over the defaults.
export function loadConfig(env, file = NO_FILE) {
  const from = settings(env, file);
  const { setting, label, number } = from;
  // Fail closed: the sandbox runs without permission prompts and can push, so nobody may
  // trigger it until the operator names who can.
  const users = list(setting("ALLOWED_USERS"));
  if (!users.length) {
    throw new ConfigError(
      "ALLOWED_USERS is empty: name the GitHub users who may start runs (or allowed_users in config.yaml)",
    );
  }
  // Replaced by a folder: ignoring it would quietly take back every grant it held.
  if (env.GRANTS_FILE) {
    throw new ConfigError(
      "GRANTS_FILE is gone: move each repository's entry to its own file in GRANTS_DIR (docs/security.md)",
    );
  }
  const port = wholeNumber(env.PORT, 8080, "PORT", "a port");
  const brokerPort = wholeNumber(env.BROKER_PORT, 8081, "BROKER_PORT", "a port");
  const prefix = setting("NAME_PREFIX") || "deckhand";
  // Hosts every sandbox may reach, besides the mandatory ones (egress.mjs).
  const hosts = list(setting("ALLOWED_HOSTS"));
  const badHost = hosts.find(hostProblem);
  if (badHost) {
    throw new ConfigError(`${label("ALLOWED_HOSTS")}: ${badHost}: ${hostProblem(badHost)}`);
  }
  const ms = "a whole number of milliseconds";
  const onboarding = (setting("ONBOARDING") ?? "on").trim().toLowerCase();
  if (!["on", "true", "1", "yes", "", "off", "false", "0", "no"].includes(onboarding)) {
    throw new ConfigError(`${label("ONBOARDING")}: expected on or off, got ${onboarding}`);
  }
  return {
    port,
    // Internal only: sandboxes ask it for tokens. Not published by compose.yaml.
    brokerPort,
    // How sandboxes reach the broker on their network (compose service name by default).
    brokerUrl: (env.BROKER_URL || `http://listener:${brokerPort}`).replace(/\/$/, ""),
    // Which variable holds the operator's Claude credential (anthropic.mjs): the value stays
    // in the environment, read by the listener's Anthropic endpoint only.
    claudeCredential: credentialName(env),
    // Where that endpoint sends sandboxes' requests: Anthropic, or an Anthropic-compatible
    // gateway (OpenRouter, a company's). The operator's only: a repo that could set it would
    // send its code and the credential elsewhere.
    anthropicUrl: anthropicUrl(setting("ANTHROPIC_BASE_URL"), label("ANTHROPIC_BASE_URL")),
    // What opus, sonnet and haiku mean to the sandboxes' Claude Code, by name: a gateway's
    // models have its own names. Empty: Claude Code's defaults.
    modelAliases: Object.fromEntries(
      [
        ["ANTHROPIC_DEFAULT_OPUS_MODEL", setting("ANTHROPIC_DEFAULT_OPUS_MODEL")],
        ["ANTHROPIC_DEFAULT_SONNET_MODEL", setting("ANTHROPIC_DEFAULT_SONNET_MODEL")],
        ["ANTHROPIC_DEFAULT_HAIKU_MODEL", setting("ANTHROPIC_DEFAULT_HAIKU_MODEL")],
      ]
        .filter(([, value]) => value)
        .map(([name, value]) => [name, modelName(value, label(name))]),
    ),
    githubApi: (setting("GITHUB_API") || "https://api.github.com").replace(/\/$/, ""),
    githubUrl: (setting("GITHUB_URL") || "https://github.com").replace(/\/$/, ""),
    users,
    // Optional: narrows the repos where the App is installed. Empty: all of them.
    repos: list(setting("ALLOWED_REPOS")),
    // The first line of a comment that calls Deckhand; "/mode <name>" picks another mode.
    trigger: normalize(setting("TRIGGER") || "Deckhand"),
    ...sandboxConfig(env, from, prefix, hosts),
    // Batches the comments of one review (each arrives as its own webhook) into one run.
    debounceMs: number("DEBOUNCE_MS", 15000, ms),
    // A brainstorm comment comes alone, and someone is waiting for the answer.
    brainstormDebounceMs: number("BRAINSTORM_DEBOUNCE_MS", 3000, ms),
    brainstormIdleMs: number("BRAINSTORM_IDLE_MINUTES", 10, "a whole number of minutes") * 60000,
    dataDir: env.DATA_DIR || "/data",
    // Where GitHub sends webhooks and screenshots are served. Optional: /setup detects it
    // and stores it with the App.
    publicUrl: setting("PUBLIC_URL") ? setting("PUBLIC_URL").replace(/\/$/, "") : null,
    // A tier (best, balanced, fast) each agent maps to one of its models, or a model's name.
    model: setting("SANDBOX_MODEL") || "best",
    effort: setting("SANDBOX_EFFORT") || "medium",
    brainstormModel: setting("BRAINSTORM_MODEL") || setting("SANDBOX_MODEL") || "best",
    brainstormEffort: setting("BRAINSTORM_EFFORT") || setting("SANDBOX_EFFORT") || "medium",
    needsInputLabel: setting("NEEDS_INPUT_LABEL") ?? "needs-input",
    // The shortest interval at which a repo's `conflicts.check_minutes` may look at its open
    // pull requests (conflicts.mjs); each conflict found is a run. 0: the watcher is off.
    conflictCheckMinutes: number("CONFLICT_CHECK_MINUTES", 5, "a whole number of minutes (0: off)"),
    // How often every "/after" wait asks GitHub again (waits.mjs), for what no delivery said.
    waitsCheckMinutes: waitsCheck(from),
    // An issue proposing a .deckhand.yaml when the App is installed on a repo without one
    // (onboarding.mjs). "/mode onboarding" works either way.
    onboarding: !["off", "false", "0", "no"].includes(onboarding),
  };
}
