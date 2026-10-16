// The operator's settings, from the environment and config.yaml. Names of images, volumes and
// networks come from here so nothing in the listener is tied to one deployment. What the
// operator grants one repo (hosts, mounts, limits) is in its grants folder instead (grants.mjs).
import { readFileSync } from "node:fs";
import {
  AGENT_SECRETS,
  AGENTS,
  DEFAULT_AGENT,
  ENTRIES,
  entryName,
  entryOf,
} from "./agents/index.mjs";
import { credentialName } from "./anthropic.mjs";
import { OPENAI_CREDENTIALS } from "./openai.mjs";
import { MODEL_NAME } from "./events.mjs";
import { ENGINES } from "./runner/engine.mjs";
import { parseCidr } from "./subnets.mjs";
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
  PUBLIC_URL: "scalar",
  TRIGGER: "scalar",
  SANDBOX_AGENT: "scalar",
  BRAINSTORM_AGENT: "scalar",
  CLAUDE_CODE_VERSION: "scalar",
  ANTHROPIC_BASE_URL: "scalar",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "scalar",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "scalar",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "scalar",
  CLAUDE_FALLBACK_MODEL: "scalar",
  OPENROUTER_BASE_URL: "scalar",
  OPENROUTER_OPUS_MODEL: "scalar",
  OPENROUTER_SONNET_MODEL: "scalar",
  OPENROUTER_HAIKU_MODEL: "scalar",
  CODEX_VERSION: "scalar",
  OPENAI_BASE_URL: "scalar",
  CODEX_BEST_MODEL: "scalar",
  CODEX_BALANCED_MODEL: "scalar",
  CODEX_FAST_MODEL: "scalar",
  FALLBACKS: "list",
  SANDBOX_MODEL: "scalar",
  SANDBOX_EFFORT: "scalar",
  BRAINSTORM_MODEL: "scalar",
  BRAINSTORM_EFFORT: "scalar",
  BRAINSTORM_IDLE_MINUTES: "scalar",
  MAX_PARALLEL: "scalar",
  SANDBOX_ENGINE: "scalar",
  SANDBOX_SUBNETS: "scalar",
  SANDBOX_SUBNET_SIZE: "scalar",
  ONBOARDING: "boolean",
  NEEDS_INPUT_LABEL: "scalar",
  CONFLICT_CHECK_MINUTES: "scalar",
  WAITS_CHECK_MINUTES: "scalar",
  LOG_RETENTION_DAYS: "scalar",
  NAME_PREFIX: "scalar",
  CLAUDE_CODE_VOLUME: "scalar",
  CODEX_VOLUME: "scalar",
  GRANTS_DIR: "scalar",
  INSTALL_NETWORK: "scalar",
  DEBOUNCE_MS: "scalar",
  BRAINSTORM_DEBOUNCE_MS: "scalar",
  GITHUB_URL: "scalar",
  GITHUB_API: "scalar",
};

// Settings that moved to the grants folder (grants.mjs), and where: ignoring one would quietly
// take hosts away or change every sandbox's limits.
export const MOVED_TO_GRANTS = {
  ALLOWED_HOSTS: "hosts in grants/default.yaml",
  SANDBOX_CPUS: "limits.cpus in grants/default.yaml",
  SANDBOX_MEMORY: "limits.memory in grants/default.yaml",
  SANDBOX_PIDS: "limits.pids in grants/default.yaml",
};

// A sandbox's limits when the grants folder sets none.
export const DEFAULT_LIMITS = { cpus: "2", memory: "4g", pids: 2048 };

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
    if (AGENT_SECRETS.includes(name)) {
      errors.push(`${key}: a secret, keep it in the environment (.env), not in a file`);
    } else if (name === "GRANTS_FILE") {
      errors.push(`${key}: gone, one file per repository in grants_dir instead (docs/security.md)`);
    } else if (key === name.toLowerCase() && MOVED_TO_GRANTS[name]) {
      errors.push(`${key}: gone, set ${MOVED_TO_GRANTS[name]} instead (docs/security.md)`);
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

// SANDBOX_SUBNETS cut into blocks of SANDBOX_SUBNET_SIZE (subnets.mjs): { range, base, prefix,
// size }, or null (empty: Docker's own address pools). A /29 is the smallest block that holds
// a sandbox, the listener, the proxy and a container engine besides the gateway.
function sandboxSubnets({ setting, label, number }) {
  const size = number("SANDBOX_SUBNET_SIZE", 28, "a prefix length (28 for blocks of 16 addresses)");
  if (size < 1 || size > 29) {
    throw new ConfigError(
      `${label("SANDBOX_SUBNET_SIZE")}: expected a prefix length from 1 to 29, got ${size}`,
    );
  }
  const range = (setting("SANDBOX_SUBNETS") ?? "").trim();
  if (!range) return null;
  const cidr = parseCidr(range);
  if (!cidr) {
    throw new ConfigError(
      `${label("SANDBOX_SUBNETS")}: expected an IPv4 range with its host bits at zero (10.200.0.0/16), got ${range}`,
    );
  }
  if (cidr.prefix > size) {
    throw new ConfigError(
      `${label("SANDBOX_SUBNETS")}: ${range} is smaller than one block of /${size} (${label("SANDBOX_SUBNET_SIZE")})`,
    );
  }
  return { range, ...cidr, size };
}

// Where sandboxes run, what they get and what they may reach.
function sandboxConfig(env, from, prefix) {
  const { setting, label, number } = from;
  return {
    prefix,
    image: env.SANDBOX_IMAGE || `${prefix}-sandbox`,
    shotsVolume: env.SHOTS_VOLUME || `${prefix}-screenshots`,
    // Each run's inbox (runner/docker.mjs), mounted by the listener at <dataDir>/runs.
    runsVolume: env.RUNS_VOLUME || `${prefix}-runs`,
    // Claude Code is not in the image: the first run installs this version into the volume.
    claudeCodeVolume: setting("CLAUDE_CODE_VOLUME") || `${prefix}-claude-code`,
    claudeCodeVersion: setting("CLAUDE_CODE_VERSION") || "2.1.300",
    // Codex's, the same way (agents/codex.mjs).
    codexVolume: setting("CODEX_VOLUME") || `${prefix}-codex`,
    codexVersion: setting("CODEX_VERSION") || "0.162.1",
    maxParallel: number("MAX_PARALLEL", 2, "a whole number of sandboxes"),
    // Where the runs' networks take their subnets from (runner/docker.mjs).
    subnets: sandboxSubnets(from),
    // Per sandbox, under the grants folder's: default.yaml's limits, then a repo's own.
    limits: DEFAULT_LIMITS,
    // The container engine sidecar of runs whose repo is granted allow_docker
    // (runner/engine.mjs), and its images; none until the operator picks one.
    engine: engineSetting(setting("SANDBOX_ENGINE"), label("SANDBOX_ENGINE")),
    engineImage: env.ENGINE_IMAGE || `${prefix}-engine`,
    enginePodmanImage: env.ENGINE_PODMAN_IMAGE || `${prefix}-engine-podman`,
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

// SANDBOX_ENGINE: sysbox, podman, auto, or nothing (null). A typo is an error rather than
// no engine.
function engineSetting(value, label) {
  const engine = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!engine) return null;
  if (ENGINES.includes(engine)) return engine;
  throw new ConfigError(`${label}: expected ${ENGINES.join(", ")} or nothing, got ${value}`);
}

// "https://openrouter.ai/api/" → "https://openrouter.ai/api", or a ConfigError: a typo would
// otherwise only show as every run failing.
function apiUrl(value, label, fallback) {
  if (!value) return fallback;
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (!["http:", "https:"].includes(url?.protocol)) {
    throw new ConfigError(`${label}: expected an http(s) URL, got ${value}`);
  }
  return value.replace(/\/$/, "");
}

// SANDBOX_AGENT and BRAINSTORM_AGENT (by default the same), and the agents the operator
// configured: those it has a credential for (each agent's `secrets`), and the defaults. A
// repo's `agent:` can only pick among these (repo-config.mjs). Claude Code may be the
// default without one, as before agents could be picked: its endpoint then answers that the
// operator set none. Another agent can't: it is picked on purpose.
function agentSettings(env, { setting, label }) {
  const pick = (value, name, fallback) => {
    const agent = String(value || fallback)
      .trim()
      .toLowerCase();
    if (!Object.hasOwn(AGENTS, agent)) {
      throw new ConfigError(
        `${label(name)}: expected ${Object.keys(AGENTS).join(" or ")}, got ${value}`,
      );
    }
    const secrets = AGENTS[agent].secrets;
    if (agent !== DEFAULT_AGENT && !secrets.some((secret) => env[secret])) {
      throw new ConfigError(
        `${label(name)} is ${agent}, which needs ${secrets.join(" or ")} in the environment`,
      );
    }
    return agent;
  };
  const agent = pick(setting("SANDBOX_AGENT"), "SANDBOX_AGENT", DEFAULT_AGENT);
  const brainstormAgent = pick(setting("BRAINSTORM_AGENT"), "BRAINSTORM_AGENT", agent);
  const agents = Object.keys(AGENTS).filter(
    (name) =>
      AGENTS[name].secrets.some((secret) => env[secret]) ||
      name === agent ||
      name === brainstormAgent,
  );
  return { agent, brainstormAgent, agents };
}

// FALLBACKS: where a run goes when its provider fails, in order ("claude@openrouter, codex"
// → ["claude@openrouter", "codex@openai"]). Each needs its credential: a fallback that can't
// run would only show when the first one fails.
function fallbackSettings(env, { setting, label }) {
  const fallbacks = [];
  for (const text of list(setting("FALLBACKS"))) {
    const entry = entryOf(text);
    if (!entry) {
      throw new ConfigError(
        `${label("FALLBACKS")}: expected agent@provider (${ENTRIES.join(", ")}), got ${text}`,
      );
    }
    const name = entryName(entry.agent, entry.provider);
    const { secrets } = AGENTS[entry.agent].providers[entry.provider];
    if (!secrets.some((secret) => env[secret])) {
      throw new ConfigError(
        `${label("FALLBACKS")}: ${name} needs ${secrets.join(" or ")} in the environment`,
      );
    }
    if (!fallbacks.includes(name)) fallbacks.push(name);
  }
  return fallbacks;
}

// Models by name, from settings: [what it is to the agent (a variable, a tier), the setting,
// its value].
function aliases(label, settings) {
  return Object.fromEntries(
    settings
      .filter(([, , value]) => value)
      .map(([key, name, value]) => [key, modelName(value, label(name))]),
  );
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
  // Moved to the grants folder, read at each run: one place for what every sandbox gets.
  const moved = Object.keys(MOVED_TO_GRANTS).filter((name) => env[name]);
  if (moved.length) {
    const where = moved.map((name) => `${name}: set ${MOVED_TO_GRANTS[name]}`).join("; ");
    throw new ConfigError(
      `${moved.join(", ")} ${moved.length > 1 ? "are" : "is"} gone (${where} instead, docs/security.md)`,
    );
  }
  const port = wholeNumber(env.PORT, 8080, "PORT", "a port");
  const brokerPort = wholeNumber(env.BROKER_PORT, 8081, "BROKER_PORT", "a port");
  const prefix = setting("NAME_PREFIX") || "deckhand";
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
    anthropicUrl: apiUrl(
      setting("ANTHROPIC_BASE_URL"),
      label("ANTHROPIC_BASE_URL"),
      "https://api.anthropic.com",
    ),
    // What opus, sonnet and haiku mean to the sandboxes' Claude Code, by name: a gateway's
    // models have its own names. Empty: Claude Code's defaults.
    modelAliases: aliases(label, [
      [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        setting("ANTHROPIC_DEFAULT_OPUS_MODEL"),
      ],
      [
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        setting("ANTHROPIC_DEFAULT_SONNET_MODEL"),
      ],
      [
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        setting("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
      ],
    ]),
    // Claude Code's own model fallback (--fallback-model), when its model is overloaded: a
    // tier or a model's name. Empty: none.
    claudeFallbackModel: setting("CLAUDE_FALLBACK_MODEL")
      ? modelName(setting("CLAUDE_FALLBACK_MODEL"), label("CLAUDE_FALLBACK_MODEL"))
      : null,
    // Claude Code through OpenRouter (claude@openrouter in FALLBACKS), with OPENROUTER_API_KEY,
    // and what opus, sonnet and haiku mean there, over the aliases above.
    openrouterUrl: apiUrl(
      setting("OPENROUTER_BASE_URL"),
      label("OPENROUTER_BASE_URL"),
      "https://openrouter.ai/api",
    ),
    openrouterAliases: aliases(label, [
      ["ANTHROPIC_DEFAULT_OPUS_MODEL", "OPENROUTER_OPUS_MODEL", setting("OPENROUTER_OPUS_MODEL")],
      [
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "OPENROUTER_SONNET_MODEL",
        setting("OPENROUTER_SONNET_MODEL"),
      ],
      [
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "OPENROUTER_HAIKU_MODEL",
        setting("OPENROUTER_HAIKU_MODEL"),
      ],
    ]),
    // Codex's, the same way (openai.mjs): OpenAI, or an OpenAI-compatible endpoint; without
    // a key, a ChatGPT plan's login, which the listener holds and refreshes (chatgpt.mjs).
    openaiCredential: OPENAI_CREDENTIALS.find((name) => env[name]) ?? null,
    openaiUrl: apiUrl(
      setting("OPENAI_BASE_URL"),
      label("OPENAI_BASE_URL"),
      "https://api.openai.com/v1",
    ),
    // What best, balanced and fast mean to Codex, when not its built-in models (agents/codex.mjs).
    codexModels: aliases(label, [
      ["best", "CODEX_BEST_MODEL", setting("CODEX_BEST_MODEL")],
      ["balanced", "CODEX_BALANCED_MODEL", setting("CODEX_BALANCED_MODEL")],
      ["fast", "CODEX_FAST_MODEL", setting("CODEX_FAST_MODEL")],
    ]),
    // Which agent runs work and light runs, and those a repo may pick instead.
    ...agentSettings(env, from),
    // Where a run goes, in order, when its provider fails (runs.mjs). Empty: nowhere.
    fallbacks: fallbackSettings(env, from),
    githubApi: (setting("GITHUB_API") || "https://api.github.com").replace(/\/$/, ""),
    githubUrl: (setting("GITHUB_URL") || "https://github.com").replace(/\/$/, ""),
    users,
    // Optional: narrows the repos where the App is installed. Empty: all of them.
    repos: list(setting("ALLOWED_REPOS")),
    // The first line of a comment that calls Deckhand; "/mode <name>" picks another mode.
    trigger: normalize(setting("TRIGGER") || "Deckhand"),
    ...sandboxConfig(env, from, prefix),
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
    // How long a run's log, summary and screenshots are kept (history.mjs). 0: forever.
    logRetentionDays: number("LOG_RETENTION_DAYS", 90, "a whole number of days (0: forever)"),
    // An issue proposing a .deckhand.yaml when the App is installed on a repo without one
    // (onboarding.mjs). "/mode onboarding" works either way.
    onboarding: !["off", "false", "0", "no"].includes(onboarding),
  };
}
