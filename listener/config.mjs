// The operator's settings, from the environment. Names of images, volumes and networks come
// from here so nothing in the listener is tied to one deployment. What the operator grants
// one repo (hosts, mounts, limits) is in its grants file instead (grants.mjs).
import { hostProblem } from "./egress.mjs";

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

export function loadConfig(env) {
  // Fail closed: the sandbox runs without permission prompts and can push, so nobody may
  // trigger it until the operator names who can.
  const users = list(env.ALLOWED_USERS);
  if (!users.length) {
    throw new ConfigError("ALLOWED_USERS is empty: name the GitHub users who may start runs");
  }
  const port = Number(env.PORT ?? 8080);
  const prefix = env.NAME_PREFIX || "deckhand";
  // Hosts every sandbox may reach, besides the mandatory ones (egress.mjs).
  const hosts = list(env.ALLOWED_HOSTS);
  const badHost = hosts.find(hostProblem);
  if (badHost) throw new ConfigError(`ALLOWED_HOSTS: ${badHost}: ${hostProblem(badHost)}`);
  return {
    port,
    // Internal only: sandboxes ask it for tokens. Not published by compose.yaml.
    brokerPort: Number(env.BROKER_PORT ?? 8081),
    // How sandboxes reach the broker on their network (compose service name by default).
    brokerUrl: (env.BROKER_URL || `http://listener:${env.BROKER_PORT ?? 8081}`).replace(/\/$/, ""),
    githubApi: (env.GITHUB_API || "https://api.github.com").replace(/\/$/, ""),
    githubUrl: (env.GITHUB_URL || "https://github.com").replace(/\/$/, ""),
    users,
    // Optional: narrows the repos where the App is installed. Empty: all of them.
    repos: list(env.ALLOWED_REPOS),
    // The first line of a comment that calls Deckhand; "/mode <name>" picks another mode.
    trigger: normalize(env.TRIGGER || "Deckhand"),
    prefix,
    image: env.SANDBOX_IMAGE || `${prefix}-sandbox`,
    network: env.SANDBOX_NETWORK || `${prefix}-sandboxes`,
    shotsVolume: env.SHOTS_VOLUME || `${prefix}-screenshots`,
    // Each run's inbox (runner/docker.mjs), mounted by the listener at <dataDir>/runs.
    runsVolume: env.RUNS_VOLUME || `${prefix}-runs`,
    // Claude Code is not in the image: the first run installs this version into the volume.
    claudeCodeVolume: env.CLAUDE_CODE_VOLUME || `${prefix}-claude-code`,
    claudeCodeVersion: env.CLAUDE_CODE_VERSION || "2.1.300",
    maxParallel: Number(env.MAX_PARALLEL ?? 2),
    hosts,
    // Per sandbox; a repo's grants may set its own.
    limits: parseLimits(
      {
        cpus: env.SANDBOX_CPUS || "2",
        memory: env.SANDBOX_MEMORY || "4g",
        pids: env.SANDBOX_PIDS || "2048",
      },
      {},
      (key) => `SANDBOX_${key.toUpperCase()}`,
    ),
    // The only way out of the sandboxes' network (../proxy/proxy.mjs).
    egressProxy: (env.EGRESS_PROXY || "http://egress:3128").replace(/\/$/, ""),
    // What the operator grants each repo: hosts, host mounts, limits (grants.mjs).
    grantsFile: env.GRANTS_FILE || "/etc/deckhand/grants.yaml",
    // Claude Code's install container downloads from npm, outside the sandboxes' network.
    installNetwork: env.INSTALL_NETWORK || "bridge",
    // The host's Docker socket, as preview hooks mount it.
    dockerSocket: env.DOCKER_SOCKET || "/var/run/docker.sock",
    // Batches the comments of one review (each arrives as its own webhook) into one run.
    debounceMs: Number(env.DEBOUNCE_MS ?? 15000),
    // A brainstorm comment comes alone, and someone is waiting for the answer.
    brainstormDebounceMs: Number(env.BRAINSTORM_DEBOUNCE_MS ?? 3000),
    brainstormIdleMs: Number(env.BRAINSTORM_IDLE_MINUTES ?? 10) * 60000,
    dataDir: env.DATA_DIR || "/data",
    // Where GitHub sends webhooks and screenshots are served. Optional: /setup detects it
    // and stores it with the App.
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/$/, "") : null,
    model: env.SANDBOX_MODEL || "opus",
    effort: env.SANDBOX_EFFORT || "medium",
    brainstormModel: env.BRAINSTORM_MODEL || env.SANDBOX_MODEL || "opus",
    brainstormEffort: env.BRAINSTORM_EFFORT || env.SANDBOX_EFFORT || "medium",
    needsInputLabel: env.NEEDS_INPUT_LABEL ?? "needs-input",
    // An issue proposing a .deckhand.yaml when the App is installed on a repo without one
    // (onboarding.mjs). "/mode onboarding" works either way.
    onboarding: !["off", "false", "0", "no"].includes((env.ONBOARDING ?? "").trim().toLowerCase()),
  };
}
