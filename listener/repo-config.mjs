// Per-repo settings: a repo's .deckhand.yaml, always read from its default branch so a pull
// request can't change its own permissions. It can only narrow the operator's settings
// (users, parallel runs), requests what the operator must grant (mounts, preview hook,
// Dockerfile, container engine: grants.mjs), and brings what is the project's own: trigger
// word, agent (among the operator's), models, setup command, extra instructions, its own
// modes, caches. Format and example: ../docs/repo-config.md.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { AGENTS } from "./agents/index.mjs";
import { EFFORTS, MODEL_NAME } from "./events.mjs";
import { list, normalize } from "./config.mjs";
import { isMap, parseYaml } from "./yaml.mjs";

export const CONFIG_FILE = ".deckhand.yaml";

// What the sandbox mounts itself: a cache can't take these over.
export const RESERVED = [
  "/workspace",
  "/home/node/.claude",
  "/opt/claude-code",
  "/home/node/.codex",
  "/opt/codex",
  "/screenshots",
];

// Docker's --mount is comma-separated: host and cache paths stay within these characters.
export const PLAIN_PATH = /^\/[\w./@+-]*$/;

// The listener's own modes: a repo's `modes:` can't take these names, and any other mode is
// one of the repo's own (modes.mjs). Work, brainstorm and onboarding (proposing this file,
// onboarding.mjs) are the ones "/mode" picks; the others come from the inbox, discussions,
// "/stop" and the dashboard's Analyze (analysis.mjs). The dashboard has a copy (format.ts),
// checked by a test.
const PICKED_MODES = ["work", "brainstorm", "onboarding"];
export const RESERVED_MODES = [...PICKED_MODES, "stop", "idea", "bug", "discussion", "analyze"];
const MODE_KEYS = ["instructions", "light", "session", "agent", "model", "effort"];

// What a repo gets without a config file: the operator's settings as they are.
export function defaultSettings(config) {
  return {
    users: config.users,
    trigger: config.trigger,
    agent: config.agent,
    brainstormAgent: config.brainstormAgent,
    model: config.model,
    effort: config.effort,
    brainstormModel: config.brainstormModel,
    brainstormEffort: config.brainstormEffort,
    maxParallel: config.maxParallel,
    setup: null,
    instructions: null,
    dockerfile: null,
    // { cache } when its runs get a container engine (runner/engine.mjs), with its grant.
    docker: null,
    caches: [],
    mounts: [],
    inbox: {},
    modes: {},
    preview: null,
    conflicts: null,
    // An issue's open questions (the needs-input label) hold its work runs back (tasks.mjs).
    waitForAnswers: true,
  };
}

// The operator's config as seen from one repo: what events.mjs and the runs read.
export function effectiveConfig(config, settings) {
  const { users, trigger, maxParallel } = settings;
  const { model, effort, brainstormModel, brainstormEffort, inbox } = settings;
  return {
    ...config,
    inbox,
    users,
    trigger,
    agent: settings.agent,
    brainstormAgent: settings.brainstormAgent,
    model,
    effort,
    brainstormModel,
    brainstormEffort,
    maxParallel,
  };
}

// The file's text → { settings, errors, warnings }. Errors stop runs (the reply says why);
// warnings (unknown keys, users the operator doesn't allow) only go to the run's log.
export function parseRepoConfig(text, config) {
  const settings = defaultSettings(config);
  const errors = [];
  const warnings = [];
  let raw;
  try {
    raw = parseYaml(text) ?? {};
  } catch (error) {
    return { settings, errors: [`${CONFIG_FILE}: ${error.message}`], warnings };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { settings, errors: [`${CONFIG_FILE}: expected keys at the top level`], warnings };
  }
  const fail = (key, what) => errors.push(`${key}: ${what}`);
  const warn = (what) => warnings.push(what);
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) continue; // "key:" with nothing: the default
    if (Object.hasOwn(KEYS, key)) KEYS[key](value, { key, settings, config, fail, warn });
    else warn(`${key}: unknown, ignored`);
  }
  return { settings, errors, warnings };
}

// Non-empty text, else an error.
function text(key, value, fail) {
  if (typeof value === "string" && value.trim()) return value.trim();
  fail(key, "expected text");
  return null;
}

// A model name, into settings[field].
const modelKey =
  (field) =>
  (value, { key, settings, fail }) => {
    if (typeof value === "string" && MODEL_NAME.test(value)) settings[field] = value;
    else
      fail(
        key,
        "expected a model tier (best, balanced, fast) or name (opus, claude-…, openai/gpt-…)",
      );
  };

// One of the agents the operator configured (config.agents), or null with `fail` called:
// a repo picks among them, it can't add one.
function agentName(value, key, config, fail) {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (config.agents.includes(name)) return name;
  const known = Object.hasOwn(AGENTS, name);
  fail(
    key,
    known
      ? `the operator hasn't configured ${name} (configured: ${config.agents.join(", ")})`
      : `expected one of ${config.agents.join(", ")}`,
  );
  return null;
}

const agentKey =
  (field) =>
  (value, { key, settings, config, fail }) => {
    const name = agentName(value, key, config, fail);
    if (name) settings[field] = name;
  };

// A thinking effort, into settings[field].
const effortKey =
  (field) =>
  (value, { key, settings, fail }) => {
    if (EFFORTS.includes(String(value).toLowerCase()))
      settings[field] = String(value).toLowerCase();
    else fail(key, `expected one of ${EFFORTS.join(", ")}`);
  };

// A file of the repository, into settings[key].
function pathKey(value, { key, settings, fail }) {
  const path = repoPath(value);
  if (path) settings[key] = path;
  else fail(key, "expected a path in the repository (relative, no ..)");
}

function parseUsers(value, { key, settings, config, fail, warn }) {
  if (!Array.isArray(value) || value.some((u) => typeof u !== "string")) {
    return fail(key, "expected a list of GitHub logins");
  }
  // Only narrows: someone the operator doesn't allow stays out.
  const wanted = list(value.join(","));
  const outside = wanted.filter((u) => !config.users.includes(u));
  if (outside.length) warn(`users not in ALLOWED_USERS, ignored: ${outside.join(", ")}`);
  settings.users = wanted.filter((u) => config.users.includes(u));
}

function parseCaches(value, { key, settings, fail }) {
  if (!Array.isArray(value)) return fail(key, "expected a list of absolute paths");
  for (const path of value) {
    const problem = cacheProblem(path);
    if (problem) fail(`caches: ${JSON.stringify(path)}`, problem);
    else if (!settings.caches.includes(path.replace(/\/$/, ""))) {
      settings.caches.push(path.replace(/\/$/, ""));
    }
  }
}

// Requests only: a mount happens under a root the operator grants the repo (grants.mjs),
// checked at each run.
function parseMounts(value, { key, settings, fail }) {
  if (!Array.isArray(value)) return fail(key, "expected a list of { path, read_only }");
  for (const mount of value) {
    const path = isMap(mount) ? mount.path : mount;
    if (typeof path !== "string" || !path.startsWith("/")) {
      fail("mounts", `expected absolute host paths, got ${JSON.stringify(path)}`);
      continue;
    }
    settings.mounts.push({ path, readOnly: isMap(mount) ? mount.read_only !== false : true });
  }
}

function parseInbox(value, { key, settings, fail, warn }) {
  if (!isMap(value)) {
    return fail(key, "expected ideas and bugs issue numbers, and a discussions category");
  }
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null) continue;
    if (name === "discussions") {
      // A category of the repo's GitHub Discussions, compared loosely like trigger lines.
      if (typeof entry === "string" && normalize(entry)) settings.inbox[name] = normalize(entry);
      else fail(`inbox.${name}`, "expected the name of a discussion category");
    } else if (!["ideas", "bugs"].includes(name)) {
      warn(`inbox.${name}: unknown, ignored`);
    } else if (Number.isInteger(entry) && entry > 0) settings.inbox[name] = entry;
    else fail(`inbox.${name}`, "expected an issue number");
  }
}

// A hook runs as root on the host's Docker, and a restart waits for it: two hours at most.
export const MAX_PREVIEW_MINUTES = 120;

function parsePreview(value, { settings, fail, warn }) {
  const preview = isMap(value) ? value : { command: value };
  const command = text("preview.command", preview.command, fail);
  const image = preview.image ?? null;
  const minutes = preview.timeout_minutes ?? 30;
  if (image !== null && (typeof image !== "string" || !/^[\w./:@-]+$/.test(image))) {
    fail("preview.image", "expected an image name");
  }
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_PREVIEW_MINUTES) {
    fail("preview.timeout_minutes", `expected a whole number from 1 to ${MAX_PREVIEW_MINUTES}`);
  }
  for (const other of Object.keys(preview)) {
    if (!["command", "image", "timeout_minutes"].includes(other)) {
      warn(`preview.${other}: unknown, ignored`);
    }
  }
  if (command) settings.preview = { command, image, timeoutMinutes: minutes };
}

// `docker: true`, or `docker: { cache: true }` to keep the engine's images and layers
// between the repo's runs. Every key is checked, like conflicts'.
function parseDocker(value, { key, settings, fail }) {
  if (typeof value === "boolean") {
    settings.docker = value ? { cache: false } : null;
    return;
  }
  if (!isMap(value)) return fail(key, "expected true, false or { cache: true }");
  let ok = true;
  for (const [other, v] of Object.entries(value)) {
    if (other !== "cache") {
      ok = false;
      fail(`docker.${other}`, "unknown key (expected cache)");
    } else if (typeof v !== "boolean" && v !== null) {
      ok = false;
      fail("docker.cache", "expected true or false");
    }
  }
  if (ok) settings.docker = { cache: value.cache === true };
}

// Opt-in: how often the conflict watcher (conflicts.mjs) looks at the repo's open pull
// requests. Never more often than the operator's CONFLICT_CHECK_MINUTES, and not at all when
// that is 0. Every key is checked: a mistyped one would leave the watcher off unnoticed.
function parseConflicts(value, { key, settings, config, fail, warn }) {
  if (!isMap(value)) return fail(key, "expected check_minutes");
  let ok = true;
  for (const other of Object.keys(value)) {
    if (other !== "check_minutes") {
      ok = false;
      fail(`conflicts.${other}`, "unknown key (expected check_minutes)");
    }
  }
  const minutes = value.check_minutes;
  if (minutes === undefined || minutes === null) return;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    return fail("conflicts.check_minutes", "expected a whole number above 0");
  }
  const floor = config.conflictCheckMinutes;
  if (!floor) return warn("conflicts: the operator turned the conflict watcher off, ignored");
  if (minutes < floor) {
    warn(`conflicts.check_minutes: below CONFLICT_CHECK_MINUTES, checked every ${floor} minutes`);
  }
  if (ok) settings.conflicts = { checkMinutes: Math.max(minutes, floor) };
}

// Each top-level key's parser, into `settings`; any other key is unknown (a warning).
const KEYS = {
  users: parseUsers,
  // The whole first line of a comment, compared loosely ("Deckhand", "@deckhand:").
  trigger: (value, { key, settings, fail }) => {
    if (typeof value === "string" && normalize(value)) settings.trigger = normalize(value);
    else fail(key, "expected a line of text");
  },
  agent: agentKey("agent"),
  brainstorm_agent: agentKey("brainstormAgent"),
  model: modelKey("model"),
  brainstorm_model: modelKey("brainstormModel"),
  effort: effortKey("effort"),
  brainstorm_effort: effortKey("brainstormEffort"),
  // The operator's MAX_PARALLEL stays the ceiling.
  max_parallel: (value, { key, settings, config, fail }) => {
    if (Number.isInteger(value) && value > 0) {
      settings.maxParallel = Math.min(value, config.maxParallel);
    } else fail(key, "expected a whole number above 0");
  },
  setup: (value, { key, settings, fail }) => {
    settings.setup = text(key, value, fail);
  },
  instructions: pathKey,
  dockerfile: pathKey,
  // Moved to the operator's grants folder (grants.mjs): a repo can't allow itself this.
  allow_branch_docker_images: (value, { key, warn }) => {
    warn(`${key}: ignored here, the operator's grants folder sets it for this repository`);
  },
  caches: parseCaches,
  // Moved to the operator's grants folder (grants.mjs): only the operator lists hosts. Its
  // runs never counted them unless the grant said allow_repo_hosts, which now stops them.
  hosts: (value, { key, warn }) => {
    warn(`${key}: ignored, the operator lists the hosts in grants/<owner>/<repo>.yaml`);
  },
  // The egress proxy's cache is shared by every run: only the operator says what goes in it.
  cached_hosts: (value, { key, warn }) => {
    warn(`${key}: ignored, the operator lists them in grants/<owner>/<repo>.yaml`);
  },
  mounts: parseMounts,
  inbox: parseInbox,
  modes: (value, { key, settings, config, fail }) => {
    if (!isMap(value)) return fail(key, "expected modes by name, each with its instructions");
    for (const [name, mode] of Object.entries(value)) {
      parseMode(name, mode, settings, config, fail);
    }
  },
  preview: parsePreview,
  conflicts: parseConflicts,
  docker: parseDocker,
  // A behaviour switch, not a permission: nothing to narrow.
  wait_for_answers: (value, { key, settings, fail }) => {
    if (typeof value === "boolean") settings.waitForAnswers = value;
    else fail(key, "expected true or false");
  },
};

// One of `modes:`, into settings.modes. Every key is checked: a mistyped one would otherwise
// change what the mode does without anyone noticing. Nothing here touches the repo's grants.
function parseMode(name, mode, settings, config, fail) {
  const where = `modes.${name}`;
  const id = name.toLowerCase();
  if (id === "work" || id === "brainstorm") {
    const keys =
      id === "work"
        ? "agent, model and effort"
        : "brainstorm_agent, brainstorm_model and brainstorm_effort";
    return fail(where, `${id} is built in: set it with ${keys} instead`);
  }
  if (RESERVED_MODES.includes(id)) return fail(where, `${id} is reserved by Deckhand`);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
    return fail(where, "expected a name of letters, digits, - and _ (32 at most)");
  }
  if (!isMap(mode)) {
    return fail(where, "expected instructions, light, session, agent, model, effort");
  }
  const before = settings.modes[id];
  const own = {
    instructions: null,
    light: false,
    session: "issue",
    agent: null,
    model: null,
    effort: null,
  };
  let ok = true;
  const bad = (key, what) => {
    ok = false;
    fail(`${where}.${key}`, what);
  };
  for (const [key, value] of Object.entries(mode)) {
    if (!MODE_KEYS.includes(key)) {
      bad(key, `unknown key (expected ${MODE_KEYS.join(", ")})`);
    } else if (key === "instructions") {
      own.instructions = repoPath(value);
      if (!own.instructions) bad(key, "expected a path in the repository (relative, no ..)");
    } else if (key === "light") {
      if (typeof value === "boolean") own.light = value;
      else bad(key, "expected true or false");
    } else if (key === "session") {
      if (["issue", "fresh"].includes(value)) own.session = value;
      else bad(key, "expected issue or fresh");
    } else if (key === "agent") {
      own.agent = agentName(value, `${where}.${key}`, config, (k, what) => bad(key, what));
    } else if (key === "model") {
      if (typeof value === "string" && MODEL_NAME.test(value)) own.model = value;
      else
        bad(
          key,
          "expected a model tier (best, balanced, fast) or name (opus, claude-…, openai/gpt-…)",
        );
    } else if (EFFORTS.includes(String(value).toLowerCase())) {
      own.effort = String(value).toLowerCase();
    } else bad(key, `expected one of ${EFFORTS.join(", ")}`);
  }
  if (!("instructions" in mode)) bad("instructions", "missing: a mode is its instructions");
  if (before) return fail(where, "defined twice (names are not case-sensitive)");
  if (ok) settings.modes[id] = own;
}

// What a run in the repo's own mode `name` gets, or null when the repo has no such mode
// (work, brainstorm and the inbox are the listener's): light (no branch, no setup, a read-only
// token: it can only comment), fresh (a new session each time, the issue's kept as it is),
// its instructions file, and its agent, model and effort, by default those of work or
// brainstorms.
// No hosts, mounts or limits: those are the repo's grants, the same in every mode.
export function customMode(settings, name) {
  const own = settings?.modes?.[name];
  if (!own) return null;
  const [agent, model, effort] = own.light
    ? [settings.brainstormAgent, settings.brainstormModel, settings.brainstormEffort]
    : [settings.agent, settings.model, settings.effort];
  return {
    name,
    light: own.light,
    fresh: own.session === "fresh",
    instructions: own.instructions,
    agent: own.agent ?? agent,
    model: own.model ?? model,
    effort: own.effort ?? effort,
  };
}

// The modes "/mode" can pick in a repo, for the reply to an unknown one.
export function modeNames(settings) {
  return [...PICKED_MODES, ...Object.keys(settings?.modes ?? {})];
}

// "docker/Dockerfile" → itself; absolute paths, "..", odd characters → null.
export function repoPath(value) {
  if (typeof value !== "string" || !/^[\w./@+-]+$/.test(value)) return null;
  const path = posix.normalize(value);
  if (path.startsWith("/") || path === "." || path.split("/").includes("..")) return null;
  return path;
}

// Why a cache path is refused, or null. Docker's -v syntax and the sandbox's own mounts
// decide the rules.
export function cacheProblem(path) {
  if (typeof path !== "string") return "expected an absolute path";
  if (!PLAIN_PATH.test(path)) return "expected an absolute path (letters, digits, ./@+-_)";
  const clean = path.replace(/\/$/, "");
  if (!clean || posix.normalize(clean) !== clean) return "expected a plain path (no .., //)";
  const clash = RESERVED.find(
    (r) => clean === r || clean.startsWith(`${r}/`) || r.startsWith(`${clean}/`),
  );
  return clash ? `the sandbox uses ${clash} itself` : null;
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortHash(...parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 10);
}

// One named volume per repo and path. The hash keeps "/a-b" and "/a/b" apart.
export function cacheVolume(config, repo, path) {
  return (
    `${config.prefix}-cache-${slug(repo)}-${slug(path)}`.slice(0, 100) +
    `-${shortHash(repo.toLowerCase(), path)}`
  );
}

// The base name of the repo's engine cache (its `docker.cache`); the runner adds the
// engine's backend, whose layouts differ.
export function engineCacheVolume(config, repo) {
  return (
    `${config.prefix}-engine-cache-${slug(repo)}`.slice(0, 100) +
    `-${shortHash(repo.toLowerCase())}`
  );
}

// A task's container, and the prefix of its volumes (`-workspace`, `-claude`). The hash keeps
// "acme/x" #pr-5 and "acme/x-pr" #5 apart: the readable part alone is the same.
export function sandboxName(config, repo, id) {
  return `${legacySandboxName(config, repo, id).slice(0, 80)}-${shortHash(repo.toLowerCase(), id)}`;
}

// The name before the hash: still the one of tasks whose volumes have it (tasks.mjs).
export function legacySandboxName(config, repo, id) {
  return `${config.prefix}-${repo}-${id}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

// The image a repo's Dockerfile builds (its tags are hashes, see images.mjs).
export function repoImage(config, repo) {
  return `${slug(config.prefix)}-repo-${slug(repo)}`;
}

// A file of the repo at `ref`, as { sha, text }; null when there is none.
export async function readRepoFile(request, repo, path, ref) {
  const url = `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
  const res = await request(repo, "GET", url, null, [404]);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`reading ${path} of ${repo}: ${res.status}`);
  const file = await res.json();
  if (file.type !== "file") throw new Error(`${path} of ${repo} is not a file`);
  return { sha: file.sha, text: Buffer.from(file.content ?? "", "base64").toString("utf8") };
}

// The repo's settings, from CONFIG_FILE on `ref` (its default branch).
export async function loadRepoSettings(request, config, repo, ref) {
  const file = await readRepoFile(request, repo, CONFIG_FILE, ref);
  if (!file) return { settings: defaultSettings(config), errors: [], warnings: [] };
  return parseRepoConfig(file.text, config);
}

// Which of the ready tasks (in priority order) start now: the operator's MAX_PARALLEL
// overall, each repo's own max_parallel within it.
export function startable(ready, running, total, maxParallel) {
  const counts = new Map(running);
  const chosen = [];
  for (const task of ready) {
    if (total + chosen.length >= maxParallel) break;
    const cap = task.settings?.maxParallel ?? maxParallel;
    const now = counts.get(task.repo) ?? 0;
    if (now >= cap) continue;
    counts.set(task.repo, now + 1);
    chosen.push(task);
  }
  return chosen;
}
