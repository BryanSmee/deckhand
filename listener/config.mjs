// The operator's settings, from the environment and config.yaml. Names of images, volumes and
// networks come from here so nothing in the listener is tied to one deployment. What the
// operator grants one repo (hosts, mounts, limits) is in its grants folder instead (grants.mjs).
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_SECRETS,
  AGENTS,
  DEFAULT_AGENT,
  ENTRIES,
  entryName,
  entryOf,
} from "./agents/index.mjs";
import { hostProblem } from "./egress.mjs";
import {
  credentialName,
  GEMINI_URL,
  GOOGLE_CREDENTIALS,
  OPENAI_CREDENTIALS,
} from "./agents/credentials.mjs";
import { MODEL_NAME } from "./events.mjs";
import { ENGINES } from "./runner/engine.mjs";
import { urlProblem } from "../lib/service-client.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { PRIVATE_RANGES, parseCidr, privateRange } from "../lib/subnets.mjs";
import {
  ConfigError,
  fileTypes,
  list,
  NO_FILE,
  parseSettingsFile,
  readSettings,
  readSettingsFile,
  settingSource,
} from "../lib/settings.mjs";

export { ConfigError, list };

// Whether ALLOWED_REPOS lets `repo` ("Owner/Name") through: empty, it lets all of them.
// "owner/*" lets every repo of that owner through, compared whole: not "ownerx/…".
export function repoAllowed(config, repo) {
  if (!config.repos.length) return true;
  const name = repo.toLowerCase();
  const owner = name.split("/")[0];
  return config.repos.includes(name) || config.repos.includes(`${owner}/*`);
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

// What opus, sonnet and haiku mean to Claude Code (its variables), and best, balanced and fast
// to Codex and the Antigravity CLI: each the setting <prefix>_<tier>_MODEL (aliasesFrom()).
const CLAUDE_TIERS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: "OPUS",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "SONNET",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "HAIKU",
};
const TIERS = { best: "BEST", balanced: "BALANCED", fast: "FAST" };

// The Antigravity CLI's default version, and the sha256 of its release's tarballs for Linux,
// pinned here: the release's own digest, which comes with the download, would follow a
// re-published asset.
const AGY_DEFAULT_VERSION = "1.4.0";
const AGY_DEFAULT_SHA256 =
  "x64:fd96967583c1eed94733c039638fa59b71ddbd823c75ebc8dd0e677463565aad," +
  "arm64:cf953adcc69f87d00d71f97c3f35dc723a8669a350accf9a199df781f0523f56";

// The runners there is a backend for (runner/index.mjs).
const RUNNERS = ["docker", "kubernetes"];

// The operator's settings, by environment variable (in lowercase, its config.yaml key), in the
// order they are read: a default can use the ones before it. Each one has a type, a default, a
// parser and maybe `empty`, as lib/settings.mjs reads them.
// Each one is in docs/setup.md and compose.yaml (test/settings.test.mjs). Secrets and the
// wiring compose.yaml sets to match its own services stay in the environment only.
export const SETTINGS = {
  // Fail closed: required (requiredSettings()).
  ALLOWED_USERS: { type: "list", default: [], parse: list },
  // Optional: narrows the repos where the App is installed. Empty: all of them.
  ALLOWED_REPOS: { type: "list", default: [], parse: repoList },
  // Where GitHub sends webhooks and screenshots are served. Optional: /setup detects it and
  // stores it with the App.
  PUBLIC_URL: { default: null, parse: noSlash },
  // The first line of a comment that calls Deckhand; "/mode <name>" picks another mode.
  TRIGGER: { default: "deckhand", parse: normalize },
  // Which agent runs work and light runs (by default the same).
  SANDBOX_AGENT: { default: DEFAULT_AGENT, parse: agentSetting },
  BRAINSTORM_AGENT: { default: (s) => s.SANDBOX_AGENT, parse: agentSetting },
  // Claude Code is not in the image: the first run installs this version into its volume.
  CLAUDE_CODE_VERSION: { default: "2.1.300" },
  // Where the listener's Anthropic endpoint sends sandboxes' requests: Anthropic, or an
  // Anthropic-compatible gateway (OpenRouter, a company's). The operator's only: a repo that
  // could set it would send its code and the credential elsewhere.
  ANTHROPIC_BASE_URL: { default: "https://api.anthropic.com", parse: apiUrl },
  // What opus, sonnet and haiku mean to the sandboxes' Claude Code, by name: a gateway's
  // models have its own names. Empty: Claude Code's defaults.
  ...tierSettings("ANTHROPIC_DEFAULT", CLAUDE_TIERS),
  // Claude Code's own model fallback (--fallback-model), when its model is overloaded: a tier
  // or a model's name. Empty: none.
  CLAUDE_FALLBACK_MODEL: { default: null, parse: modelName },
  // Claude Code through OpenRouter (claude@openrouter in FALLBACKS), and what opus, sonnet and
  // haiku mean there, over the aliases above.
  OPENROUTER_BASE_URL: { default: "https://openrouter.ai/api", parse: apiUrl },
  ...tierSettings("OPENROUTER", CLAUDE_TIERS),
  // Codex's, the same way (agents/codex.mjs, openai.mjs).
  CODEX_VERSION: { default: "0.162.1" },
  OPENAI_BASE_URL: { default: "https://api.openai.com/v1", parse: apiUrl },
  // What best, balanced and fast mean to Codex, when not its built-in models.
  ...tierSettings("CODEX", TIERS),
  // The Antigravity CLI's, with a Gemini API key or a Google AI plan's login that the models
  // service holds (agents/antigravity.mjs, ../models/google.mjs, ../models/antigravity-login.mjs), and what best, balanced
  // and fast mean to it.
  AGY_VERSION: { default: AGY_DEFAULT_VERSION },
  // Its tarballs' sha256 by architecture, "x64:<hex>,arm64:<hex>" (one will do): the default
  // version's are pinned above; another version needs its own, or it isn't installed.
  AGY_SHA256: {
    default: (s) => (s.AGY_VERSION === AGY_DEFAULT_VERSION ? AGY_DEFAULT_SHA256 : null),
    parse: archDigests,
  },
  GEMINI_BASE_URL: { default: GEMINI_URL, parse: apiUrl },
  ...tierSettings("AGY", TIERS),
  // Where a run goes, in order, when its provider fails (runs.mjs). Empty: nowhere.
  FALLBACKS: { type: "list", default: [], parse: fallbacks },
  // A tier (best, balanced, fast) each agent maps to one of its models, or a model's name.
  SANDBOX_MODEL: { default: "best" },
  SANDBOX_EFFORT: { default: "medium" },
  BRAINSTORM_MODEL: { default: (s) => s.SANDBOX_MODEL },
  BRAINSTORM_EFFORT: { default: (s) => s.SANDBOX_EFFORT },
  // Whether `/speed fast` may turn on Claude Code's fast mode, which costs more: off until the
  // operator says `allowed`. A repo's `fast_mode: false` turns it off there.
  SANDBOX_FAST_MODE: { default: false, parse: fastModeSetting },
  BRAINSTORM_IDLE_MINUTES: { default: 10, parse: whole("a whole number of minutes") },
  MAX_PARALLEL: { default: 2, parse: whole("a whole number of sandboxes") },
  // Slots within MAX_PARALLEL kept for the open issues labelled AUTO_PICKUP_LABEL, which the
  // listener starts by itself, oldest first, in the repos whose `auto_pickup` opts in
  // (auto-pickup.mjs). 0: off.
  AUTO_PICKUP_SLOTS: { default: 0, parse: whole("a whole number of sandboxes (0: off)") },
  AUTO_PICKUP_LABEL: { default: "auto-pickup" },
  // Where sandboxes run (runner/index.mjs): the host's Docker, or pods of a Kubernetes cluster.
  RUNNER: { default: "docker", parse: runnerSetting },
  // The Kubernetes runner's (runner/kubernetes.mjs): its namespace, which holds the listener's
  // and the egress proxy's pods too (empty: the runner's own, its ServiceAccount's), how long
  // a pod may stay Pending before its run fails, and its session claims' storage class
  // (empty: the cluster's default) and size.
  KUBERNETES_NAMESPACE: { default: null },
  KUBERNETES_PENDING_MINUTES: {
    default: 10,
    parse: aboveZero("a whole number of minutes above 0"),
  },
  KUBERNETES_STORAGE_CLASS: { default: null },
  KUBERNETES_SESSION_SIZE: { default: "10Gi", parse: storageSize },
  // Repo images on Kubernetes (runner/kube-images.mjs): the registry they are pushed to and
  // nodes pull them from (empty: no repo images), the kubernetes.io/dockerconfigjson Secret
  // with its credentials, and the BuildKit daemon that builds them (buildctl's --addr).
  KUBERNETES_REGISTRY: { default: null, parse: registrySetting },
  KUBERNETES_REGISTRY_SECRET: { default: null },
  KUBERNETES_BUILDKIT: { default: "tcp://buildkitd:1234", parse: buildkitAddress },
  // More hosts the BuildKit daemon reaches while it pulls and pushes (a registry's token
  // service, the storage it sends layers from), beyond those runner/kube-images.mjs knows.
  KUBERNETES_REGISTRY_HOSTS: { type: "list", default: [], parse: hostList },
  // Claims every run of a repo mounts at once, of a ReadWriteMany storage class: its caches
  // (empty: none) and the agents' installs (empty: the caches' class; neither, and no claim
  // made beforehand: each run installs its agent in an init container).
  KUBERNETES_CACHE_STORAGE_CLASS: { default: null },
  KUBERNETES_CACHE_SIZE: { default: "10Gi", parse: storageSize },
  KUBERNETES_AGENT_STORAGE_CLASS: { default: (s) => s.KUBERNETES_CACHE_STORAGE_CLASS },
  KUBERNETES_AGENT_SIZE: { default: "5Gi", parse: storageSize },
  // The container engine sidecar of runs whose repo is granted `docker`
  // (runner/engine.mjs); none until the operator picks one.
  SANDBOX_ENGINE: { default: null, parse: engineSetting },
  // Where the runs' networks take their subnets from (runner/docker.mjs, lib/subnets.mjs).
  SANDBOX_SUBNET_SIZE: { default: 28, parse: subnetSize },
  SANDBOX_SUBNETS: { default: null, parse: sandboxSubnets },
  // An issue proposing a .deckhand.yaml when the App is installed on a repo without one
  // (onboarding.mjs). "/mode onboarding" works either way.
  ONBOARDING: { type: "boolean", default: true, parse: onOff },
  NEEDS_INPUT_LABEL: { default: "needs-input", empty: true },
  // The shortest interval at which a repo's `conflicts.check_minutes` may look at its open
  // pull requests (conflicts.mjs); each conflict found is a run. 0: the watcher is off.
  CONFLICT_CHECK_MINUTES: { default: 5, parse: whole("a whole number of minutes (0: off)") },
  // The most fix runs a repo's `review.fix` may ask for per pull request (reviews.mjs): each
  // round is a work run and a review run.
  MAX_FIX_ROUNDS: { default: 5, parse: aboveZero("a whole number of fix runs above 0") },
  // How often every "/after" wait asks GitHub again (waits.mjs), for what no delivery said.
  // It catches missed deliveries, so it can't be turned off.
  WAITS_CHECK_MINUTES: { default: 5, parse: aboveZero("a whole number of minutes above 0") },
  // The most a run's log may hold: a run whose output passes it is stopped, as failed (runs.mjs).
  RUN_LOG_MAX_MB: { default: 200, parse: aboveZero("a whole number of megabytes above 0") },
  // How long a run's log, summary and screenshots are kept (history.mjs). 0: forever.
  LOG_RETENTION_DAYS: { default: 90, parse: whole("a whole number of days (0: forever)") },
  // The names of what the listener creates on Docker.
  NAME_PREFIX: { default: "deckhand" },
  CLAUDE_CODE_VOLUME: { default: (s) => `${s.NAME_PREFIX}-claude-code` },
  CODEX_VOLUME: { default: (s) => `${s.NAME_PREFIX}-codex` },
  AGY_VOLUME: { default: (s) => `${s.NAME_PREFIX}-antigravity` },
  // What the operator grants each repo, one file per repo: hosts, host mounts, limits
  // (grants.mjs).
  GRANTS_DIR: { default: "/etc/deckhand/grants" },
  // The agents' install containers download from npm, outside the runs' networks.
  INSTALL_NETWORK: { default: "bridge" },
  // Batches the comments of one review (each arrives as its own webhook) into one run.
  DEBOUNCE_MS: { default: 15000, parse: whole("a whole number of milliseconds") },
  // A brainstorm comment comes alone, and someone is waiting for the answer.
  BRAINSTORM_DEBOUNCE_MS: { default: 3000, parse: whole("a whole number of milliseconds") },
  // After a default branch moved, the wait before its conflicts are checked (conflicts.mjs
  // soon()): GitHub computes the pull requests' mergeability again meanwhile.
  CONFLICT_MERGE_DELAY_MS: { default: 30000, parse: whole("a whole number of milliseconds") },
  GITHUB_URL: { default: "https://github.com", parse: noSlash },
  GITHUB_API: { default: "https://api.github.com", parse: noSlash },
};

// What config.yaml may set, and the YAML it takes: each setting's environment variable, in
// lowercase as the key.
export const FILE_SETTINGS = fileTypes(SETTINGS);

// Settings that moved to the grants folder (grants.mjs), and where: ignoring one would quietly
// take hosts away or change every sandbox's limits.
const MOVED_TO_GRANTS = {
  ALLOWED_HOSTS: "hosts in grants/default.yaml",
  SANDBOX_CPUS: "limits.cpus in grants/default.yaml",
  SANDBOX_MEMORY: "limits.memory in grants/default.yaml",
  SANDBOX_PIDS: "limits.pids in grants/default.yaml",
};

// A sandbox's limits when the grants folder sets none.
const DEFAULT_LIMITS = { cpus: "2", memory: "4g", pids: 2048 };

// config.yaml's text → { path, settings: { ALLOWED_USERS: "a,b", … } }. Fails closed: any
// unknown key, wrong type or secret refuses to start, every one named.
export function parseConfigFile(text, path) {
  return parseSettingsFile(text, path, { types: FILE_SETTINGS, refused });
}

// Why config.yaml may not hold `key`, or null.
function refused(key, name) {
  if (AGENT_SECRETS.includes(name))
    return "a secret, keep it in the environment (.env), not in a file";
  if (name === "GRANTS_FILE")
    return "gone, one file per repository in grants_dir instead (docs/security.md)";
  if (key === name.toLowerCase() && MOVED_TO_GRANTS[name]) {
    return `gone, set ${MOVED_TO_GRANTS[name]} instead (docs/security.md)`;
  }
  return null;
}

// CONFIG_FILE, read once at start (a restart applies an edit). No file: no settings, unless
// CONFIG_FILE names one, which then has to be there.
export function readConfigFile(env, read) {
  return readSettingsFile(env, {
    path: "/etc/deckhand/config.yaml",
    parse: parseConfigFile,
    ...(read && { read }),
  });
}

// What the orchestrator can't write of its data volume, said at start, before it refuses to
// start: it runs as uid 1000 (#536), where the listener before it wrote that volume as root. The
// folder and what is in it (logs, shots, store, the state files), not deeper: a volume from
// before is root's throughout. The chown needs CHOWN back: `compose run` keeps the service's
// cap_drop. → lines for the log, [] when all is writable.
export function unwritableData(dir, { access = accessSync, list = readdirSync } = {}) {
  const fix = `it runs as uid 1000, and a data volume from an earlier release is root's: hand it over once with \`docker compose run --rm --no-deps --user root --cap-add CHOWN --entrypoint chown orchestrator -R 1000:1000 /data\` (docs/setup.md#upgrading-the-orchestrator-runs-as-node-536)`;
  const unwritable = (path, folder = true) => {
    try {
      access(path, folder ? constants.W_OK | constants.X_OK : constants.W_OK);
      return null;
    } catch (error) {
      return error.code === "ENOENT"
        ? null
        : `The orchestrator can't write ${path} (${error.code}): ${fix}`;
    }
  };
  const top = unwritable(dir);
  if (top) return [top];
  let entries = [];
  try {
    entries = list(dir, { withFileTypes: true });
  } catch {
    // Not there yet: made below, as the orchestrator's.
  }
  return entries
    .map((entry) => unwritable(join(dir, entry.name), entry.isDirectory()))
    .filter(Boolean);
}

// The plans' logins the models service holds and refreshes, at their fixed names in its
// credentials folder (compose.yaml mounts DECKHAND_CREDENTIALS_DIR there, read only): one present
// turns that login on. Its variable, when set, wins.
export const CREDENTIAL_FILES = {
  CODEX_AUTH_FILE: "codex-auth.json",
  AGY_AUTH_FILE: "agy-auth.json",
};

// `env` with each unset login variable pointing at its file in the credentials folder, when
// there is one. Everything else reads them from the environment as if the operator set them.
export function withCredentialFiles(env, exists = existsSync) {
  const dir = join(env.DATA_DIR || "/data", "credentials");
  const found = {};
  for (const [name, file] of Object.entries(CREDENTIAL_FILES)) {
    if (!env[name] && exists(join(dir, file))) found[name] = join(dir, file);
  }
  return Object.keys(found).length ? { ...env, ...found } : env;
}

// The broker service's URL (BROKER_SERVICE_URL) and the models service's (MODELS_SERVICE_URL,
// its copies comma-separated): wiring, environment only, which the listener needs before its
// settings, to learn which agents' credentials the models service holds.
export const brokerServiceUrl = (env) =>
  serviceUrls(env.BROKER_SERVICE_URL || "http://broker:8081", "BROKER_SERVICE_URL").replace(
    /\/$/,
    "",
  );
export const modelsServiceUrl = (env) =>
  serviceUrls(env.MODELS_SERVICE_URL || "http://models:8080", "MODELS_SERVICE_URL");

// What the listener's settings read of the agents' credentials (#504): `env` without any of
// their values, and with each of `names` (those the models service holds) set to a placeholder.
// Which agents and fallbacks may run, and which credential runs take, are decided from it as
// before; the values stay in the models service.
export const HELD = "(held by the models service)";
export function withModelCredentials(env, names) {
  const out = { ...env };
  for (const name of AGENT_SECRETS) delete out[name];
  for (const name of names) if (AGENT_SECRETS.includes(name)) out[name] = HELD;
  return out;
}

// The listener's ports, each its own (0: one the OS picks, in the tests): one set to another's
// must say so, not fail to bind.
function distinctPorts(ports) {
  const seen = new Map();
  for (const [name, port] of Object.entries(ports)) {
    if (port && seen.has(port)) {
      throw new ConfigError(
        `${seen.get(port)} and ${name} are both ${port}: set one to another port`,
      );
    }
    seen.set(port, name);
  }
}

// A service's URLs, comma-separated (its copies), each an http(s) URL: `runner:8080` would
// otherwise be tried on every call until it times out.
function serviceUrls(value, name) {
  for (const url of value.split(",").map((u) => u.trim())) {
    const problem = urlProblem(url);
    if (problem) throw new ConfigError(`${name}: ${url} is ${problem} (http://host:port)`);
  }
  return value;
}

// The environment, over config.yaml's settings (readConfigFile()), over the defaults.
// `service`: "orchestrator" (the default) starts runs; "edge" (../edge/server.mjs) signs in
// ALLOWED_USERS, which it requires too, but starts none; "runner" (../runner/server.mjs),
// "github" (../github/server.mjs) and "models" (../models/server.mjs) start no run of their own:
// ALLOWED_USERS and the agents' credentials are the orchestrator's to require, and
// SERVICE_NETWORKS the github service's to read.
export function loadConfig(env, file = NO_FILE, { service = "orchestrator" } = {}) {
  const orchestrator = service === "orchestrator" || service === "listener";
  const settings = orchestrator ? SETTINGS : RUNNER_SETTINGS;
  const from = settingSource(env, file, settings);
  requiredSettings(env, from, { users: orchestrator || service === "edge" });
  const s = readSettings(env, from, settings);
  registryCredentials(s);
  pickupSlots(s);
  const port = wholeNumber(env.PORT, 8080, "PORT", "a port");
  const policyPort = wholeNumber(env.POLICY_PORT, 8082, "POLICY_PORT", "a port");
  const servicesPort = wholeNumber(env.SERVICES_PORT, 8083, "SERVICES_PORT", "a port");
  distinctPorts({
    PORT: port,
    POLICY_PORT: policyPort,
    SERVICES_PORT: servicesPort,
  });
  return {
    port,
    // The other services' calls to those the listener still is (the broker's, the github
    // service's: services-http.mjs), on the networks it shares with them only.
    servicesPort,
    // The runner service (../runner/): the only one with the Docker socket, or the Kubernetes
    // API. Several, comma-separated: its copies, tried in turn (lib/service-client.mjs).
    runnerUrl: serviceUrls(env.RUNNER_URL || "http://runner:8080", "RUNNER_URL"),
    // Which network each service calling the listener's services port is on
    // (lib/service-token.mjs networkCallers()); none: no service may call it.
    serviceNetworks: service === "github" ? null : serviceNetworks(env.SERVICE_NETWORKS),
    // The egress proxy's questions (/egress), on a port of their own: open until the
    // orchestrator exits (docs/architecture.md#restarts). Not published by compose.yaml.
    policyPort,
    // The broker service (../broker/, #505), which signs the runs' tokens: where the listener
    // asks for them, and for its own service tokens. On Kubernetes, the pod's token projected
    // for it, which proves who calls.
    brokerServiceUrl: brokerServiceUrl(env),
    // The models service (../models/, #504), which alone holds the agents' credentials.
    modelsServiceUrl: modelsServiceUrl(env),
    serviceAccountTokenFile: env.SERVICE_ACCOUNT_TOKEN_FILE || null,
    // The github service (../github/, #502), the only one with the GitHub App's key: the
    // listener's GitHub calls go there, and its own relays of sandboxes' calls.
    githubServiceUrl: serviceUrls(
      env.GITHUB_SERVICE_URL || "http://github:8080",
      "GITHUB_SERVICE_URL",
    ),
    // The policy service, which evaluates every policy decision (../policy-service/, #501).
    policyServiceUrl: (env.POLICY_SERVICE_URL || "http://policy:8181").replace(/\/$/, ""),
    // Which variable holds the operator's Claude credential (agents/credentials.mjs): the value
    // is the models service's alone (../models/anthropic.mjs).
    claudeCredential: credentialName(env),
    // The credentials entries can name (`claude@anthropic:key`) that the operator set, and the
    // one runs take without a name (null: another, a gateway's token).
    credentials: namedCredentials(env, credentialName(env)),
    anthropicUrl: s.ANTHROPIC_BASE_URL,
    modelAliases: aliasesFrom(s, "ANTHROPIC_DEFAULT", CLAUDE_TIERS),
    claudeFallbackModel: s.CLAUDE_FALLBACK_MODEL,
    openrouterUrl: s.OPENROUTER_BASE_URL,
    openrouterAliases: aliasesFrom(s, "OPENROUTER", CLAUDE_TIERS),
    // Without a key, a ChatGPT plan's login, which the models service holds and refreshes
    // (../models/chatgpt.mjs).
    openaiCredential: OPENAI_CREDENTIALS.find((name) => env[name]) ?? null,
    openaiUrl: s.OPENAI_BASE_URL,
    codexModels: aliasesFrom(s, "CODEX", TIERS),
    // The Antigravity CLI's: a Gemini API key, else a Google AI plan's login, which the
    // models service holds and refreshes (../models/antigravity-login.mjs).
    agyCredential: GOOGLE_CREDENTIALS.find((name) => env[name]) ?? null,
    geminiUrl: s.GEMINI_BASE_URL,
    agyModels: aliasesFrom(s, "AGY", TIERS),
    agent: s.SANDBOX_AGENT,
    brainstormAgent: s.BRAINSTORM_AGENT,
    agents: configuredAgents(env, s),
    fallbacks: s.FALLBACKS,
    githubApi: s.GITHUB_API,
    githubUrl: s.GITHUB_URL,
    users: s.ALLOWED_USERS,
    repos: s.ALLOWED_REPOS,
    trigger: s.TRIGGER,
    ...sandboxConfig(env, s),
    debounceMs: s.DEBOUNCE_MS,
    brainstormDebounceMs: s.BRAINSTORM_DEBOUNCE_MS,
    brainstormIdleMs: s.BRAINSTORM_IDLE_MINUTES * 60000,
    dataDir: env.DATA_DIR || "/data",
    publicUrl: s.PUBLIC_URL,
    model: s.SANDBOX_MODEL,
    effort: s.SANDBOX_EFFORT,
    brainstormModel: s.BRAINSTORM_MODEL,
    brainstormEffort: s.BRAINSTORM_EFFORT,
    fastMode: s.SANDBOX_FAST_MODE,
    needsInputLabel: s.NEEDS_INPUT_LABEL,
    conflictCheckMinutes: s.CONFLICT_CHECK_MINUTES,
    conflictMergeDelayMs: s.CONFLICT_MERGE_DELAY_MS,
    maxFixRounds: s.MAX_FIX_ROUNDS,
    waitsCheckMinutes: s.WAITS_CHECK_MINUTES,
    logRetentionDays: s.LOG_RETENTION_DAYS,
    runLogMax: s.RUN_LOG_MAX_MB * 1024 * 1024,
    onboarding: s.ONBOARDING,
  };
}

// Where sandboxes run, what they get and what they may reach: `s`, readSettings()'s, and the
// wiring compose.yaml sets.
function sandboxConfig(env, s) {
  const prefix = s.NAME_PREFIX;
  return {
    prefix,
    image: env.SANDBOX_IMAGE || `${prefix}-sandbox`,
    claudeCodeVolume: s.CLAUDE_CODE_VOLUME,
    claudeCodeVersion: s.CLAUDE_CODE_VERSION,
    codexVolume: s.CODEX_VOLUME,
    codexVersion: s.CODEX_VERSION,
    agyVolume: s.AGY_VOLUME,
    agyVersion: s.AGY_VERSION,
    agySha256: s.AGY_SHA256,
    // Where the runner refreshes the plan's login with `agy` itself, for the models service
    // (../models/antigravity-login.mjs).
    agyLoginVolume: `${s.AGY_VOLUME}-login`,
    runner: s.RUNNER,
    kubernetes: {
      namespace: s.KUBERNETES_NAMESPACE,
      pendingMs: s.KUBERNETES_PENDING_MINUTES * 60000,
      storageClass: s.KUBERNETES_STORAGE_CLASS,
      sessionSize: s.KUBERNETES_SESSION_SIZE,
      registry: s.KUBERNETES_REGISTRY,
      registrySecret: s.KUBERNETES_REGISTRY_SECRET,
      buildkit: s.KUBERNETES_BUILDKIT,
      registryHosts: s.KUBERNETES_REGISTRY_HOSTS,
      cacheStorageClass: s.KUBERNETES_CACHE_STORAGE_CLASS,
      cacheSize: s.KUBERNETES_CACHE_SIZE,
      agentStorageClass: s.KUBERNETES_AGENT_STORAGE_CLASS,
      agentSize: s.KUBERNETES_AGENT_SIZE,
    },
    maxParallel: s.MAX_PARALLEL,
    autoPickupSlots: s.AUTO_PICKUP_SLOTS,
    autoPickupLabel: s.AUTO_PICKUP_LABEL,
    subnets: s.SANDBOX_SUBNETS,
    // Per sandbox, under the grants folder's: default.yaml's limits, then a repo's own.
    limits: DEFAULT_LIMITS,
    engine: s.SANDBOX_ENGINE,
    engineImage: env.ENGINE_IMAGE || `${prefix}-engine`,
    enginePodmanImage: env.ENGINE_PODMAN_IMAGE || `${prefix}-engine-podman`,
    // The only way out of the runs' networks (../proxy/proxy.mjs).
    egressProxy: (env.EGRESS_PROXY || "http://egress:3128").replace(/\/$/, ""),
    // The container joined to each run's network (runner/networks.mjs): by default, the one
    // compose.yaml labels deckhand.role=egress.
    egressContainer: env.EGRESS_CONTAINER || "",
    grantsDir: s.GRANTS_DIR,
    installNetwork: s.INSTALL_NETWORK,
  };
}

// Fail closed: repo images run in their repos' sandboxes, with their broker secrets and
// grants, so a registry anyone could push to (an in-cluster one the sandboxes and builds can
// reach) would let one run replace another repo's image. Its credentials have to be there,
// which a registry that asks for none would make pointless: docs/setup.md says it must.
function registryCredentials(s) {
  if (s.KUBERNETES_REGISTRY && !s.KUBERNETES_REGISTRY_SECRET) {
    throw new ConfigError(
      "KUBERNETES_REGISTRY is set without KUBERNETES_REGISTRY_SECRET: name the dockerconfigjson Secret with its push credentials, for a registry that requires them to pull, push and delete (docs/setup.md, Repo images on Kubernetes)",
    );
  }
}

// The reserved slots leave at least one to the runs people start: all of them reserved, a
// trigger comment would wait for every labelled issue to be picked first.
function pickupSlots(s) {
  if (s.AUTO_PICKUP_SLOTS && s.AUTO_PICKUP_SLOTS >= s.MAX_PARALLEL) {
    throw new ConfigError(
      `AUTO_PICKUP_SLOTS (${s.AUTO_PICKUP_SLOTS}) must be below MAX_PARALLEL (${s.MAX_PARALLEL}): the reserved slots come out of it`,
    );
  }
}

// What must be settled before anything starts: who may trigger runs, and no setting that
// moved elsewhere.
function requiredSettings(env, { setting }, { users = true } = {}) {
  // Fail closed: the sandbox runs without permission prompts and can push, so nobody may
  // trigger it until the operator names who can.
  if (users && !list(setting("ALLOWED_USERS")).length) {
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
}

// SERVICE_NETWORKS, checked now: a typo would refuse every call of the runner's. `none` (the
// runner's, where the network can't tell) means nothing here: the orchestrator has to know which
// address is the runner's, and edge's. On Kubernetes, where every call arrives at the pod's one address,
// `runner=0.0.0.0/0` says so, and a NetworkPolicy lets only the runner's pods reach the port.
function serviceNetworks(text) {
  const value = String(text ?? "").trim();
  if (value === "none") {
    throw new ConfigError(
      "SERVICE_NETWORKS: none is the runner's; edge and the orchestrator need their callers' networks (the orchestrator's: runner=<subnet>,edge=<subnet>; on Kubernetes runner+edge=0.0.0.0/0, with a NetworkPolicy that lets only the runner's and edge's pods reach SERVICES_PORT: docs/setup.md, Kubernetes runner)",
    );
  }
  try {
    networkCallers(value);
  } catch (error) {
    throw new ConfigError(error.message);
  }
  return value;
}

// The parsers of SETTINGS: (text, { label, env, values, labelOf }) → the value.

// "Org/App, me/*" → ["org/app", "me/*"], or a ConfigError: a typo ("*", "org", "or*/app")
// would otherwise let every repo through or none, silently.
function repoList(text, { label }) {
  const entries = list(text);
  const bad = entries.filter((entry) => !/^[^/*\s]+\/(\*|[^/*\s]+)$/.test(entry));
  if (bad.length) {
    throw new ConfigError(`${label}: expected owner/repo or owner/*, got ${bad.join(", ")}`);
  }
  return entries;
}

function noSlash(text) {
  return text.replace(/\/$/, "");
}

// "15" → 15, or a ConfigError naming the setting: NaN would be a silent 0 or forever.
function wholeNumber(value, fallback, label, what) {
  const text = String(value ?? fallback).trim();
  if (!/^\d+$/.test(text)) throw new ConfigError(`${label}: expected ${what}, got ${value}`);
  return Number(text);
}

function whole(what) {
  return (text, { label }) => wholeNumber(text, undefined, label, what);
}

function aboveZero(what) {
  return (text, { label }) => {
    const number = wholeNumber(text, undefined, label, what);
    if (!number) throw new ConfigError(`${label}: expected above 0, got 0`);
    return number;
  };
}

// "registry.example.com/deckhand" (a host, a port, a path; no scheme, no tag): what repo
// images' names start with. A scheme or a tag would make every image reference wrong.
function registrySetting(text, { label }) {
  const value = text.trim().replace(/\/+$/, "");
  if (!value) return null;
  // Its host has a dot or a port (or is localhost), as a reference's first part must to be
  // taken for a registry rather than a Docker Hub user.
  const m = /^([a-z0-9.-]+)(:\d+)?(\/[a-z0-9._-]+)*$/.exec(value.toLowerCase());
  if (m && (m[1].includes(".") || m[2] || m[1] === "localhost")) return value.toLowerCase();
  throw new ConfigError(
    `${label}: expected a registry host and an optional path (registry.example.com/deckhand), got ${text}`,
  );
}

// "tcp://buildkitd:1234": its host is the name of the daemon's Service in the namespace, which
// the listener finds its pods by (runner/kube-images.mjs builderIsolation()): a single DNS
// label, not a full name or an address, or every build would be refused.
function buildkitAddress(text, { label }) {
  const value = text.trim();
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    url?.protocol === "tcp:" &&
    /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(url.hostname) &&
    url.port
  ) {
    return value;
  }
  throw new ConfigError(
    `${label}: expected tcp://<the daemon's Service name>:<port> (tcp://buildkitd:1234), a Service of the namespace by its short name, got ${text} (docs/setup.md, Repo images on Kubernetes)`,
  );
}

// "a.example.com, *.cdn.example" → the hosts, each checked as a grant's are (egress.mjs).
function hostList(text, { label }) {
  const hosts = list(text);
  const bad = hosts.filter((host) => hostProblem(host));
  if (bad.length) throw new ConfigError(`${label}: ${bad.join(", ")}: ${hostProblem(bad[0])}`);
  return hosts;
}

// A claim's size as Kubernetes takes it: "10Gi", "500Mi", "1T".
function storageSize(text, { label }) {
  const size = text.trim();
  if (/^\d+(\.\d+)?([KMGTPE]i?)?$/.test(size) && parseFloat(size) > 0) return size;
  throw new ConfigError(`${label}: expected a size (10Gi, 500Mi), got ${text}`);
}

function onOff(text, { label }) {
  const value = text.trim().toLowerCase();
  if (["on", "true", "1", "yes", ""].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  throw new ConfigError(`${label}: expected on or off, got ${value}`);
}

// A /29 is the smallest block that holds a sandbox, the proxy and a container engine besides
// the gateway.
function subnetSize(text, { label }) {
  const size = wholeNumber(
    text,
    undefined,
    label,
    "a prefix length (28 for blocks of 16 addresses)",
  );
  if (size < 1 || size > 29) {
    throw new ConfigError(`${label}: expected a prefix length from 1 to 29, got ${size}`);
  }
  return size;
}

// SANDBOX_SUBNETS cut into blocks of SANDBOX_SUBNET_SIZE (lib/subnets.mjs): { range, base, prefix,
// size }, or null (empty: Docker's own address pools).
function sandboxSubnets(text, { label, values, labelOf }) {
  const size = values.SANDBOX_SUBNET_SIZE;
  const range = text.trim();
  if (!range) return null;
  const cidr = parseCidr(range);
  if (!cidr) {
    throw new ConfigError(
      `${label}: expected an IPv4 range with its host bits at zero (10.200.0.0/16), got ${range}`,
    );
  }
  if (!privateRange(range)) {
    throw new ConfigError(
      `${label}: ${range} is not a private range: expected one inside ${PRIVATE_RANGES.join(", ")}`,
    );
  }
  if (cidr.prefix > size) {
    throw new ConfigError(
      `${label}: ${range} is smaller than one block of /${size} (${labelOf("SANDBOX_SUBNET_SIZE")})`,
    );
  }
  return { range, ...cidr, size };
}

// SANDBOX_ENGINE: sysbox, podman, auto, or nothing (null). A typo is an error rather than
// no engine.
// "allowed" → true; "off" or nothing → false. Not on/off: what it allows is spending more.
function fastModeSetting(text, { label }) {
  const value = text.trim().toLowerCase();
  if (value === "allowed") return true;
  if (["", "off"].includes(value)) return false;
  throw new ConfigError(`${label}: expected allowed or off, got ${text}`);
}

// RUNNER: docker, kubernetes, or nothing (docker). Another name stops the listener: falling back to
// Docker would start sandboxes where the operator didn't ask for them.
function runnerSetting(text, { label }) {
  const runner = text.trim().toLowerCase();
  if (!runner || RUNNERS.includes(runner)) return runner || "docker";
  throw new ConfigError(`${label}: expected ${RUNNERS.join(" or ")}, got ${text}`);
}

function engineSetting(text, { label }) {
  const engine = text.trim().toLowerCase();
  if (!engine) return null;
  if (ENGINES.includes(engine)) return engine;
  throw new ConfigError(`${label}: expected ${ENGINES.join(", ")} or nothing, got ${text}`);
}

// "https://openrouter.ai/api/" → "https://openrouter.ai/api", or a ConfigError: a typo would
// otherwise only show as every run failing.
function apiUrl(text, { label }) {
  let url;
  try {
    url = new URL(text);
  } catch {}
  if (!["http:", "https:"].includes(url?.protocol)) {
    throw new ConfigError(`${label}: expected an http(s) URL, got ${text}`);
  }
  return noSlash(text);
}

// SANDBOX_AGENT and BRAINSTORM_AGENT. Claude Code may be the default without a credential, as
// before agents could be picked: its endpoint then answers that the operator set none. Another
// agent can't: it is picked on purpose.
function agentSetting(text, { label, env, known = false }) {
  const agent = text.trim().toLowerCase();
  if (!Object.hasOwn(AGENTS, agent)) {
    throw new ConfigError(`${label}: expected ${Object.keys(AGENTS).join(", ")}, got ${text}`);
  }
  const secrets = AGENTS[agent].secrets;
  if (!known && agent !== DEFAULT_AGENT && !secrets.some((secret) => env[secret])) {
    throw new ConfigError(
      `${label} is ${agent}, which needs ${secrets.join(" or ")} in the environment`,
    );
  }
  return agent;
}

// The runner's and the models service's: an agent's credential is the listener's to require
// (config.yaml, which they all read, may pick one).
const knownAgent = (text, { label }) => agentSetting(text, { label, env: {}, known: true });
const RUNNER_SETTINGS = {
  ...SETTINGS,
  SANDBOX_AGENT: { ...SETTINGS.SANDBOX_AGENT, parse: knownAgent },
  BRAINSTORM_AGENT: { ...SETTINGS.BRAINSTORM_AGENT, parse: knownAgent },
  FALLBACKS: {
    ...SETTINGS.FALLBACKS,
    parse: (text, { label }) => fallbacks(text, { label, env: {}, known: true }),
  },
};

// The agents the operator configured: those it has a credential for (each agent's `secrets`),
// and the defaults. A repo's `agent:` can only pick among these (repo-config.mjs).
function configuredAgents(env, s) {
  return Object.keys(AGENTS).filter(
    (name) =>
      AGENTS[name].secrets.some((secret) => env[secret]) ||
      name === s.SANDBOX_AGENT ||
      name === s.BRAINSTORM_AGENT,
  );
}

// { "claude@anthropic": { set: ["plan", "key"], default: "plan" } }: for each agent's provider
// with credentials an entry can name (agents/ `credentials`), those whose variable is set, and
// the one the default variable (`claudeCredential`) is.
function namedCredentials(env, claudeCredential) {
  const found = {};
  for (const agent of Object.values(AGENTS)) {
    for (const [provider, { credentials }] of Object.entries(agent.providers)) {
      if (!credentials) continue;
      const named = Object.entries(credentials);
      found[entryName(agent.name, provider)] = {
        set: named.filter(([, c]) => env[c.variable]).map(([name]) => name),
        default: named.find(([, c]) => c.variable === claudeCredential)?.[0] ?? null,
      };
    }
  }
  return found;
}

// FALLBACKS: where a run goes when its provider fails, in order ("claude@openrouter, codex"
// → ["claude@openrouter", "codex@openai"]), "claude@anthropic:key" on a credential of the
// provider's. Each needs its credential: a fallback that can't run would only show when the
// first one fails. `known`: the runner's, which checks the entries only (as knownAgent()).
function fallbacks(text, { label, env, known = false }) {
  const names = [];
  for (const item of list(text)) {
    const entry = entryOf(item);
    if (!entry) {
      throw new ConfigError(
        `${label}: expected agent@provider or agent@provider:credential (${ENTRIES.join(", ")}), got ${item}`,
      );
    }
    const name = entryName(entry.agent, entry.provider, entry.credential);
    const { credentials } = AGENTS[entry.agent].providers[entry.provider];
    const secrets = entry.credential
      ? [credentials[entry.credential].variable]
      : AGENTS[entry.agent].providers[entry.provider].secrets;
    if (!known && !secrets.some((secret) => env[secret])) {
      throw new ConfigError(`${label}: ${name} needs ${secrets.join(" or ")} in the environment`);
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// "x64:<hex>,arm64:<hex>" (either, or both), as the installer reads it.
function archDigests(text, { label }) {
  const value = text.replace(/\s+/g, "").toLowerCase();
  if (/^(x64|arm64):[0-9a-f]{64}(,(x64|arm64):[0-9a-f]{64})?$/.test(value)) return value;
  throw new ConfigError(`${label}: expected x64:<sha256>,arm64:<sha256>, got ${text}`);
}

function modelName(text, { label }) {
  if (MODEL_NAME.test(text)) return text;
  throw new ConfigError(`${label}: expected a model name (anthropic/claude-…), got ${text}`);
}

// One <prefix>_<tier>_MODEL setting per tier, each a model's name.
function tierSettings(prefix, tiers) {
  return Object.fromEntries(
    Object.values(tiers).map((tier) => [
      `${prefix}_${tier}_MODEL`,
      { default: null, parse: modelName },
    ]),
  );
}

// Models by name, from tierSettings()'s values: { what it is to the agent (a variable, a
// tier): its model }, for those set.
function aliasesFrom(values, prefix, tiers) {
  return Object.fromEntries(
    Object.entries(tiers)
      .map(([key, tier]) => [key, values[`${prefix}_${tier}_MODEL`]])
      .filter(([, model]) => model),
  );
}
