// The operator's settings, from the environment. Names of images, volumes and networks come
// from here so nothing in the listener is tied to one deployment.

export class ConfigError extends Error {}

// "a, B,,c" → ["a", "b", "c"]: GitHub logins and repo names are case-insensitive.
export function list(value) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// "Claude let's brainstorm this" matches "claude lets brainstorm this!".
export function normalize(line) {
  return line
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function loadConfig(env) {
  // Fail closed: the sandbox runs without permission prompts and can push, so nobody may
  // trigger it until the operator names who can.
  const users = list(env.ALLOWED_USERS);
  if (!users.length) {
    throw new ConfigError("ALLOWED_USERS is empty: name the GitHub users who may start runs");
  }
  const port = Number(env.PORT ?? 8080);
  const prefix = env.NAME_PREFIX || "deckhand";
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
    trigger: normalize(env.TRIGGER || "Claude work on this"),
    brainstormTrigger: normalize(env.BRAINSTORM_TRIGGER || "Claude let's brainstorm this"),
    stopTrigger: normalize(env.BRAINSTORM_STOP || "Claude stop"),
    prefix,
    image: env.SANDBOX_IMAGE || `${prefix}-sandbox`,
    network: env.SANDBOX_NETWORK || `${prefix}-sandboxes`,
    shotsVolume: env.SHOTS_VOLUME || `${prefix}-screenshots`,
    // Claude Code is not in the image: the first run installs this version into the volume.
    claudeCodeVolume: env.CLAUDE_CODE_VOLUME || `${prefix}-claude-code`,
    claudeCodeVersion: env.CLAUDE_CODE_VERSION || "2.1.300",
    maxParallel: Number(env.MAX_PARALLEL ?? 2),
    // Batches the comments of one review (each arrives as its own webhook) into one run.
    debounceMs: Number(env.DEBOUNCE_MS ?? 15000),
    // A brainstorm comment comes alone, and someone is waiting for the answer.
    brainstormDebounceMs: Number(env.BRAINSTORM_DEBOUNCE_MS ?? 3000),
    brainstormIdleMs: Number(env.BRAINSTORM_IDLE_MINUTES ?? 10) * 60000,
    dataDir: env.DATA_DIR || "/data",
    dashboardPassword: env.DASHBOARD_PASSWORD ?? "",
    // Where GitHub sends webhooks and screenshots are served. Optional: /setup detects it
    // and stores it with the App.
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/$/, "") : null,
    model: env.SANDBOX_MODEL || "opus",
    effort: env.SANDBOX_EFFORT || "medium",
    brainstormModel: env.BRAINSTORM_MODEL || env.SANDBOX_MODEL || "opus",
    brainstormEffort: env.BRAINSTORM_EFFORT || env.SANDBOX_EFFORT || "medium",
    needsInputLabel: env.NEEDS_INPUT_LABEL ?? "needs-input",
  };
}
