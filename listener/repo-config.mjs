// Per-repo settings: a repo's .deckhand.yaml, always read from its default branch so a pull
// request can't change its own permissions. It can only narrow the operator's settings
// (users, parallel runs), requests what the operator must grant (mounts, preview hook,
// Dockerfile, container engine: grants.mjs), and brings what is the project's own: trigger
// word, agent (among the operator's), models, setup command, extra instructions, its own
// modes, caches. Format and example: ../docs/repo-config.md.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { AGENTS } from "./agents/index.mjs";
import { EFFORTS, MODEL_NAME, SPEEDS } from "./events.mjs";
import { list, normalize } from "./config.mjs";
import { customMode, PICKED_MODES, RESERVED_MODES } from "./modes.mjs";
import { INBOX_DIR } from "./runner/inbox.mjs";
import { isMap, parseYaml } from "./yaml.mjs";

export const CONFIG_FILE = ".deckhand.yaml";

// What the sandbox mounts itself: a cache or mount can't take these over. Every agent's
// session and install, from its definition, so a new agent can't be left out.
export const RESERVED = [
  "/workspace",
  "/screenshots",
  INBOX_DIR,
  ...Object.values(AGENTS).flatMap((a) => [a.session.path, a.install({}).mount]),
];

// Docker's --mount is comma-separated: host and cache paths stay within these characters.
export const PLAIN_PATH = /^\/[\w./@+-]*$/;

const MODE_KEYS = ["instructions", "light", "session", "agent", "model", "effort", "speed"];

const REVIEW_KEYS = [
  "on",
  "instructions",
  "agent",
  "model",
  "effort",
  "fix",
  "merge",
  "merge_method",
];
// When a review starts by itself (reviews.mjs): `ready`, a pull request marked ready for review
// or opened as ready; `manual`, only with a "/mode review" line.
const REVIEW_ON = ["ready", "manual"];
// How an auto-merge merges (`review.merge_method`), GitHub's merge_method values.
export const MERGE_METHODS = ["squash", "merge", "rebase"];

// The listener's own modes (modes.mjs): a repo's `modes:` can't take these names.
export { customMode, RESERVED_MODES };

// What a repo gets without a config file: the operator's settings as they are.
export function defaultSettings(config) {
  const settings = {};
  for (const { field, default: value } of Object.values(KEYS)) {
    if (field) settings[field] = typeof value === "function" ? value(config, field) : value;
  }
  return settings;
}

// The operator's config as seen from one repo: what events.mjs and the runs read.
export function effectiveConfig(config, settings) {
  const own = Object.values(KEYS).filter((k) => k.effective);
  return { ...config, ...Object.fromEntries(own.map(({ field }) => [field, settings[field]])) };
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
    if (!Object.hasOwn(KEYS, key)) warn(`${key}: unknown, ignored`);
    else KEYS[key].parse(value, { key, field: KEYS[key].field, settings, config, fail, warn });
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
function modelKey(value, { key, field, settings, fail }) {
  if (typeof value === "string" && MODEL_NAME.test(value)) settings[field] = value;
  else
    fail(
      key,
      "expected a model tier (best, balanced, fast) or name (opus, claude-…, openai/gpt-…)",
    );
}

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

function agentKey(value, { key, field, settings, config, fail }) {
  const name = agentName(value, key, config, fail);
  if (name) settings[field] = name;
}

// A thinking effort, into settings[field].
function effortKey(value, { key, field, settings, fail }) {
  if (EFFORTS.includes(String(value).toLowerCase())) settings[field] = String(value).toLowerCase();
  else fail(key, `expected one of ${EFFORTS.join(", ")}`);
}

// A file of the repository, into settings[field].
function pathKey(value, { key, field, settings, fail }) {
  const path = repoPath(value);
  if (path) settings[field] = path;
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
const MAX_PREVIEW_MINUTES = 120;

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

// Opt-in: the built-in review mode (modes.mjs, reviews.mjs), `true` for "/mode review" only.
// Every key is checked, like a mode's: a mistyped one would change what it does unnoticed.
// It widens nothing (a light run with a read-only token), so no grant; `merge` does, and only
// the operator's `allow_auto_merge` makes it merge (grants.mjs autoMergeProblems()).
function parseReview(value, { key, settings, config, fail, warn }) {
  if (value === false) return;
  const review = {
    on: "manual",
    instructions: null,
    agent: null,
    model: null,
    effort: null,
    fix: false,
    merge: false,
    mergeMethod: "squash",
  };
  if (value === true) {
    settings.review = review;
    return;
  }
  if (!isMap(value)) return fail(key, `expected true, or ${REVIEW_KEYS.join(", ")}`);
  let ok = true;
  const bad = (k, what) => {
    ok = false;
    fail(`review.${k}`, what);
  };
  for (const [k, v] of Object.entries(value)) {
    if (v === null) continue;
    if (!REVIEW_KEYS.includes(k)) bad(k, `unknown key (expected ${REVIEW_KEYS.join(", ")})`);
    else if (k === "on") {
      if (REVIEW_ON.includes(v)) review.on = v;
      else bad(k, `expected ${REVIEW_ON.join(" or ")}`);
    } else if (k === "instructions") {
      review.instructions = repoPath(v);
      if (!review.instructions) bad(k, "expected a path in the repository (relative, no ..)");
    } else if (k === "fix") {
      // A normal work run, with the same push rules: no grant either.
      if (typeof v === "boolean") review.fix = v;
      else bad(k, "expected true or false");
    } else if (k === "merge") {
      if (typeof v === "boolean") review.merge = v;
      else bad(k, "expected true or false");
    } else if (k === "merge_method") {
      if (MERGE_METHODS.includes(v)) review.mergeMethod = v;
      else bad(k, `expected ${MERGE_METHODS.join(", ")}`);
    } else if (k === "agent") {
      review.agent = agentName(v, `review.${k}`, config, (_, what) => bad(k, what));
    } else if (k === "model") {
      if (typeof v === "string" && MODEL_NAME.test(v)) review.model = v;
      else
        bad(
          k,
          "expected a model tier (best, balanced, fast) or name (opus, claude-…, openai/gpt-…)",
        );
    } else if (EFFORTS.includes(String(v).toLowerCase())) review.effort = String(v).toLowerCase();
    else bad(k, `expected one of ${EFFORTS.join(", ")}`);
  }
  if (ok && review.merge && review.on !== "ready") {
    warn("review.merge: needs `review.on: ready`, nothing is merged");
  }
  if (ok) settings.review = review;
}

function reviewText(review) {
  if (!review) return "off";
  const when = review.on === "ready" ? "when a pull request is ready" : '"/mode review" only';
  const fix = review.fix && "one fix run per pull request";
  const merge = review.merge && `auto-merge (${review.mergeMethod})`;
  return [when, fix, merge, review.instructions].filter(Boolean).join(" · ");
}

// The operator's value of `field`, as the repo's default: a file can only narrow or replace it.
const operator = (config, field) => config[field];

const none = (values) => (values.length ? values.join(", ") : "none");

// A row of the dashboard's config panel showing the value as it is, or "none".
const asIs = ({ value, row }) => row(String(value));
const orNone = ({ value, row }) => row(value ?? "none");

// Each top-level key of the file:
// - field: what it sets in `settings`; none for the keys that are only ignored (a warning);
// - default: its value without the key, or a function of the operator's config;
// - effective: part of the operator's config as one repo sees it (effectiveConfig());
// - parse: the key's value into settings[field], or `fail` (an error) or `warn`;
// - display: its rows on the dashboard's config panel (repo-view.mjs settingRows(), which
//   gives `row`, `refused` and `unknown`), or false for those it shows in a table of their own.
// Any other key is unknown (a warning).
export const KEYS = {
  users: {
    field: "users",
    default: operator,
    effective: true,
    parse: parseUsers,
    display: ({ value, row, changed, config }) =>
      row(none(value), changed ? `narrowed from ALLOWED_USERS (${none(config.users)})` : null),
  },
  // The whole first line of a comment, compared loosely ("Deckhand", "@deckhand:").
  trigger: {
    field: "trigger",
    default: operator,
    effective: true,
    parse: (value, { key, settings, fail }) => {
      if (typeof value === "string" && normalize(value)) settings.trigger = normalize(value);
      else fail(key, "expected a line of text");
    },
    display: asIs,
  },
  agent: { field: "agent", default: operator, effective: true, parse: agentKey, display: asIs },
  brainstorm_agent: {
    field: "brainstormAgent",
    default: operator,
    effective: true,
    parse: agentKey,
    display: asIs,
  },
  model: { field: "model", default: operator, effective: true, parse: modelKey, display: asIs },
  effort: { field: "effort", default: operator, effective: true, parse: effortKey, display: asIs },
  brainstorm_model: {
    field: "brainstormModel",
    default: operator,
    effective: true,
    parse: modelKey,
    display: asIs,
  },
  brainstorm_effort: {
    field: "brainstormEffort",
    default: operator,
    effective: true,
    parse: effortKey,
    display: asIs,
  },
  // Whether `/speed fast` (and a mode's `speed: fast`) may turn on fast mode: only narrows the
  // operator's SANDBOX_FAST_MODE, which costs more.
  fast_mode: {
    field: "fastMode",
    default: operator,
    effective: true,
    parse: (value, { key, settings, config, fail, warn }) => {
      if (typeof value !== "boolean") return fail(key, "expected true or false");
      if (value && !config.fastMode) {
        warn(`${key}: the operator hasn't allowed fast mode (SANDBOX_FAST_MODE), ignored`);
      }
      settings.fastMode = value && config.fastMode;
    },
    display: ({ value, row, changed, config }) =>
      row(
        value ? "allowed" : "off",
        !config.fastMode
          ? "the operator hasn't allowed it (SANDBOX_FAST_MODE)"
          : changed
            ? "turned off for this repository"
            : null,
      ),
  },
  // The operator's MAX_PARALLEL stays the ceiling.
  max_parallel: {
    field: "maxParallel",
    default: operator,
    effective: true,
    parse: (value, { key, settings, config, fail }) => {
      if (Number.isInteger(value) && value > 0) {
        settings.maxParallel = Math.min(value, config.maxParallel);
      } else fail(key, "expected a whole number above 0");
    },
    display: ({ value, row, changed, config }) =>
      row(String(value), changed ? `MAX_PARALLEL is ${config.maxParallel}` : null),
  },
  setup: {
    field: "setup",
    default: null,
    parse: (value, { key, settings, fail }) => {
      settings.setup = text(key, value, fail);
    },
    display: orNone,
  },
  instructions: { field: "instructions", default: null, parse: pathKey, display: orNone },
  dockerfile: {
    field: "dockerfile",
    default: null,
    parse: pathKey,
    display: ({ value, row, refused, config }) =>
      refused(value) ?? row(value ?? `none: the base image ${config.image}`),
  },
  // Moved to the operator's grants folder (grants.mjs): a repo can't allow itself this.
  allow_branch_docker_images: {
    parse: (value, { key, warn }) => {
      warn(`${key}: ignored here, the operator's grants folder sets it for this repository`);
    },
    display: ({ settings, grant, known, row, unknown }) =>
      !known && settings.dockerfile
        ? unknown("unknown")
        : row(
            String(grant.allowBranchDockerImages && !!settings.dockerfile),
            grant.allowBranchDockerImages && !settings.dockerfile
              ? "granted, but the repository has no dockerfile"
              : "the operator's grants",
          ),
  },
  // { cache } when its runs get a container engine (runner/engine.mjs), with its grant.
  docker: {
    field: "docker",
    default: null,
    parse: parseDocker,
    display: ({ value, row, refused, config }) =>
      refused(dockerText(value)) ??
      row(
        dockerText(value),
        value && !config.engine ? "the operator hasn't set SANDBOX_ENGINE" : null,
      ),
  },
  caches: {
    field: "caches",
    default: () => [],
    parse: parseCaches,
    display: ({ value, row }) => row(none(value)),
  },
  // Moved to the operator's grants folder (grants.mjs): only the operator lists hosts. Its
  // runs never counted them unless the grant said allow_repo_hosts, which now stops them. The
  // panel's hosts are the grants'.
  hosts: {
    parse: (value, { key, warn }) => {
      warn(`${key}: ignored, the operator lists the hosts in grants/<owner>/<repo>.yaml`);
    },
    display: false,
  },
  // The egress proxy's cache is shared by every run: only the operator says what goes in it.
  cached_hosts: {
    parse: (value, { key, warn }) => {
      warn(`${key}: ignored, the operator lists them in grants/<owner>/<repo>.yaml`);
    },
    display: false,
  },
  // The panel resolves them in a table of their own (repo-view.mjs mountRows()).
  mounts: { field: "mounts", default: () => [], parse: parseMounts, display: false },
  inbox: {
    field: "inbox",
    default: () => ({}),
    effective: true,
    parse: parseInbox,
    display: ({ value, row }) => row(inboxText(value)),
  },
  preview: {
    field: "preview",
    default: null,
    parse: parsePreview,
    display: ({ value, row, refused }) => refused(previewText(value)) ?? row(previewText(value)),
  },
  conflicts: {
    field: "conflicts",
    default: null,
    parse: parseConflicts,
    display: ({ value, row, config }) =>
      row(
        value ? `every ${value.checkMinutes} minutes` : "off",
        config.conflictCheckMinutes ? null : "the operator turned the conflict watcher off",
      ),
  },
  // An issue's open questions (the needs-input label) hold its work runs back (tasks.mjs). A
  // behaviour switch, not a permission: nothing to narrow.
  wait_for_answers: {
    field: "waitForAnswers",
    default: true,
    parse: (value, { key, settings, fail }) => {
      if (typeof value === "boolean") settings.waitForAnswers = value;
      else fail(key, "expected true or false");
    },
    display: asIs,
  },
  review: {
    field: "review",
    default: null,
    parse: parseReview,
    display: ({ value, settings, grant, known, row }) => {
      const mode = value && customMode(settings, "review");
      // Not refused: the reviews run, only the merge waits for a human (grants.mjs).
      const merge =
        value?.merge && known && !grant.allowAutoMerge
          ? "nothing is merged: the operator's grants don't set allow_auto_merge"
          : null;
      const model = mode ? `${mode.model}/${mode.effort}` : null;
      return row(reviewText(value), [model, merge].filter(Boolean).join("; ") || null);
    },
  },
  // One row per mode: only the repo's file defines them.
  modes: {
    field: "modes",
    default: () => ({}),
    parse: (value, { key, settings, config, fail }) => {
      if (!isMap(value)) return fail(key, "expected modes by name, each with its instructions");
      for (const [name, mode] of Object.entries(value)) {
        parseMode(name, mode, settings, config, fail);
      }
    },
    display: ({ value, settings }) => Object.keys(value).map((name) => modeRow(settings, name)),
  },
};

function modeRow(settings, name) {
  const mode = customMode(settings, name);
  const traits = [
    mode.instructions,
    `${mode.model}/${mode.effort}${mode.speed === "fast" ? "/fast" : ""}`,
    mode.light ? "light" : null,
    mode.fresh ? "fresh session" : null,
  ];
  return {
    key: `modes.${name}`,
    value: traits.filter(Boolean).join(" · "),
    source: "repo",
    note: null,
  };
}

function inboxText(inbox) {
  const parts = [];
  if (inbox.ideas) parts.push(`ideas #${inbox.ideas}`);
  if (inbox.bugs) parts.push(`bugs #${inbox.bugs}`);
  if (inbox.discussions) parts.push(`discussions "${inbox.discussions}"`);
  return none(parts);
}

function dockerText(docker) {
  if (!docker) return "none";
  return docker.cache ? "a container engine, its cache kept" : "a container engine";
}

function previewText(preview) {
  if (!preview) return "none";
  const image = preview.image ? `, image ${preview.image}` : "";
  return `${preview.command} (${preview.timeoutMinutes} min${image})`;
}

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
  if (id === "review") {
    return fail(
      where,
      "review is built in: remove it and turn it on with a top-level `review:` block, or rename it",
    );
  }
  if (RESERVED_MODES.includes(id)) return fail(where, `${id} is reserved by Deckhand`);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
    return fail(where, "expected a name of letters, digits, - and _ (32 at most)");
  }
  if (!isMap(mode)) {
    return fail(where, `expected ${MODE_KEYS.join(", ")}`);
  }
  const before = settings.modes[id];
  const own = {
    instructions: null,
    light: false,
    session: "issue",
    agent: null,
    model: null,
    effort: null,
    speed: null,
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
    } else if (key === "speed") {
      // Checked against the operator's and the repo's fast_mode when a run starts, so the
      // reply can say why it ran at normal speed.
      if (SPEEDS.includes(String(value).toLowerCase())) own.speed = String(value).toLowerCase();
      else bad(key, `expected ${SPEEDS.join(" or ")}`);
    } else if (EFFORTS.includes(String(value).toLowerCase())) {
      own.effort = String(value).toLowerCase();
    } else bad(key, `expected one of ${EFFORTS.join(", ")}`);
  }
  if (!("instructions" in mode)) bad("instructions", "missing: a mode is its instructions");
  if (before) return fail(where, "defined twice (names are not case-sensitive)");
  if (ok) settings.modes[id] = own;
}

// The modes "/mode" can pick in a repo, for the reply to an unknown one: review only once its
// `review` block turns it on.
export function modeNames(settings) {
  const review = settings?.review ? ["review"] : [];
  return [...PICKED_MODES, ...review, ...Object.keys(settings?.modes ?? {})];
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

// A new task's sandbox name. Tasks with a session from before names had a hash keep their old
// name, so they still find their volumes; the others get the new one. Old names collide
// ("acme/x" #pr-5 and "acme/x-pr" #5): a volume of that name is only this task's when one of
// its own `runs` had the name (run ids are "<name>-<start>"), else a new task would take over
// another repo's session and workspace. `hasSession(name)`: the runner's.
export async function taskSandboxName(config, repo, id, runs, hasSession) {
  const key = `${repo}#${id}`.toLowerCase();
  const legacy = legacySandboxName(config, repo, id);
  const ran = runs.some(
    (r) =>
      r.key.toLowerCase() === key &&
      r.id.startsWith(`${legacy}-`) &&
      /^\d+$/.test(r.id.slice(legacy.length + 1)),
  );
  return ran && (await hasSession(legacy)) ? legacy : sandboxName(config, repo, id);
}

// The image a repo's Dockerfile builds (its tags are hashes, see images.mjs). The hash keeps
// "acme/x.y", "acme/x-y" and "acme-x/y" apart: one repo never runs on another's image.
export function repoImage(config, repo) {
  return `${legacyRepoImage(config, repo).slice(0, 100)}-${shortHash(repo.toLowerCase())}`;
}

// The name before it had a hash, shared by repos whose names slug alike: only pruned.
export function legacyRepoImage(config, repo) {
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
