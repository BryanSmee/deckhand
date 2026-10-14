// Per-repo settings: a repo's .deckhand.yaml, always read from its default branch so a pull
// request can't change its own permissions. It can only narrow the operator's settings
// (users, parallel runs), and brings what is the project's own: trigger lines, models,
// setup command, extra instructions, Dockerfile, caches, preview hook. Format and example:
// ../docs/repo-config.md.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { EFFORTS } from "./events.mjs";
import { list, normalize } from "./config.mjs";
import { parseYaml } from "./yaml.mjs";

export const CONFIG_FILE = ".deckhand.yaml";

// What the sandbox mounts itself: a cache can't take these over.
const RESERVED = ["/workspace", "/home/node/.claude", "/opt/claude-code", "/screenshots"];

// What a repo gets without a config file: the operator's settings as they are.
export function defaultSettings(config) {
  return {
    users: config.users,
    trigger: config.trigger,
    brainstormTrigger: config.brainstormTrigger,
    stopTrigger: config.stopTrigger,
    model: config.model,
    effort: config.effort,
    brainstormModel: config.brainstormModel,
    brainstormEffort: config.brainstormEffort,
    maxParallel: config.maxParallel,
    setup: null,
    instructions: null,
    dockerfile: null,
    allowBranchDockerImages: false,
    caches: [],
    hosts: [],
    mounts: [],
    inbox: {},
    preview: null,
  };
}

// The operator's config as seen from one repo: what events.mjs and the runs read.
export function effectiveConfig(config, settings) {
  const { users, trigger, brainstormTrigger, stopTrigger, maxParallel } = settings;
  const { model, effort, brainstormModel, brainstormEffort } = settings;
  return {
    ...config,
    users,
    trigger,
    brainstormTrigger,
    stopTrigger,
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
  const string = (key, value) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    fail(key, "expected text");
    return null;
  };

  for (const [key, value] of Object.entries(raw)) {
    if (value === null) continue; // "key:" with nothing: the default
    switch (key) {
      case "users": {
        if (!Array.isArray(value) || value.some((u) => typeof u !== "string")) {
          fail(key, "expected a list of GitHub logins");
          break;
        }
        // Only narrows: someone the operator doesn't allow stays out.
        const wanted = list(value.join(","));
        const outside = wanted.filter((u) => !config.users.includes(u));
        if (outside.length)
          warnings.push(`users not in ALLOWED_USERS, ignored: ${outside.join(", ")}`);
        settings.users = wanted.filter((u) => config.users.includes(u));
        break;
      }
      case "triggers": {
        if (!isMap(value)) {
          fail(key, "expected work, brainstorm and stop lines");
          break;
        }
        const names = { work: "trigger", brainstorm: "brainstormTrigger", stop: "stopTrigger" };
        for (const [name, line] of Object.entries(value)) {
          if (!names[name]) warnings.push(`triggers.${name}: unknown, ignored`);
          else if (typeof line === "string" && normalize(line))
            settings[names[name]] = normalize(line);
          else fail(`triggers.${name}`, "expected a line of text");
        }
        break;
      }
      case "model":
      case "brainstorm_model": {
        const field = key === "model" ? "model" : "brainstormModel";
        if (typeof value === "string" && /^[\w.[\]-]+$/.test(value)) settings[field] = value;
        else fail(key, "expected a model name (opus, sonnet, claude-…)");
        break;
      }
      case "effort":
      case "brainstorm_effort": {
        const field = key === "effort" ? "effort" : "brainstormEffort";
        if (EFFORTS.includes(String(value).toLowerCase()))
          settings[field] = String(value).toLowerCase();
        else fail(key, `expected one of ${EFFORTS.join(", ")}`);
        break;
      }
      case "max_parallel":
        // The operator's MAX_PARALLEL stays the ceiling.
        if (Number.isInteger(value) && value > 0)
          settings.maxParallel = Math.min(value, config.maxParallel);
        else fail(key, "expected a whole number above 0");
        break;
      case "setup":
        settings.setup = string(key, value);
        break;
      case "instructions":
      case "dockerfile": {
        const path = repoPath(value);
        if (path) settings[key] = path;
        else fail(key, "expected a path in the repository (relative, no ..)");
        break;
      }
      case "allow_branch_docker_images":
        if (typeof value === "boolean") settings.allowBranchDockerImages = value;
        else fail(key, "expected true or false");
        break;
      case "caches": {
        if (!Array.isArray(value)) {
          fail(key, "expected a list of absolute paths");
          break;
        }
        for (const path of value) {
          const problem = cacheProblem(path);
          if (problem) fail(`caches: ${JSON.stringify(path)}`, problem);
          else if (!settings.caches.includes(path.replace(/\/$/, ""))) {
            settings.caches.push(path.replace(/\/$/, ""));
          }
        }
        break;
      }
      case "hosts":
        if (!Array.isArray(value)) {
          fail(key, "expected a list of host names");
          break;
        }
        for (const host of value) {
          const name = String(host).toLowerCase();
          if (/^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)$/.test(name)) settings.hosts.push(name);
          else fail(`hosts: ${JSON.stringify(host)}`, "expected a host name, *.domain or *");
        }
        break;
      case "mounts":
        // Granted by the operator only (#3): parsed here, so a typo shows up now.
        if (!Array.isArray(value)) {
          fail(key, "expected a list of { path, read_only }");
          break;
        }
        for (const mount of value) {
          const path = isMap(mount) ? mount.path : mount;
          if (typeof path !== "string" || !path.startsWith("/")) {
            fail("mounts", `expected absolute host paths, got ${JSON.stringify(path)}`);
            continue;
          }
          settings.mounts.push({ path, readOnly: isMap(mount) ? mount.read_only !== false : true });
        }
        break;
      case "inbox":
        if (!isMap(value)) {
          fail(key, "expected ideas, bugs and discussions issue numbers");
          break;
        }
        for (const [name, number] of Object.entries(value)) {
          if (!["ideas", "bugs", "discussions"].includes(name)) {
            warnings.push(`inbox.${name}: unknown, ignored`);
          } else if (Number.isInteger(number) && number > 0) settings.inbox[name] = number;
          else if (number !== null) fail(`inbox.${name}`, "expected an issue number");
        }
        break;
      case "preview": {
        const preview = isMap(value) ? value : { command: value };
        const command = string("preview.command", preview.command);
        const image = preview.image ?? null;
        const minutes = preview.timeout_minutes ?? 30;
        if (image !== null && (typeof image !== "string" || !/^[\w./:@-]+$/.test(image))) {
          fail("preview.image", "expected an image name");
        }
        if (!Number.isInteger(minutes) || minutes <= 0) {
          fail("preview.timeout_minutes", "expected a whole number above 0");
        }
        for (const other of Object.keys(preview)) {
          if (!["command", "image", "timeout_minutes"].includes(other)) {
            warnings.push(`preview.${other}: unknown, ignored`);
          }
        }
        if (command) settings.preview = { command, image, timeoutMinutes: minutes };
        break;
      }
      default:
        warnings.push(`${key}: unknown, ignored`);
    }
  }
  return { settings, errors, warnings };
}

function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (!/^\/[\w./@+-]*$/.test(path)) return "expected an absolute path (letters, digits, ./@+-_)";
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
