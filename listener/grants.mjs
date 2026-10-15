// What the operator grants each repo, beyond what every sandbox gets: extra hosts, whether
// its own .deckhand.yaml may add hosts, run a preview hook, build its Dockerfile (and that of
// its pull requests' branches), host mounts under allowed roots, and its own CPU, memory and
// pids limits. It lives in the operator's GRANTS_DIR, never in a repo: a repo's .deckhand.yaml
// may request a mount, a host, a preview hook or a Dockerfile, but only a grant here makes it
// happen. One file per repo, so a team can own its repos' files (CODEOWNERS), and a mistake
// in one stops that repo's runs only. Read again at each run, so an edit applies without a
// restart. Format: ../docs/security.md.
//
//   grants/
//     default.yaml       # every repo: the flags, hosts added to each repo's, base limits
//       allow_repo_hosts: true
//       hosts: [pypi.org]
//       limits: { memory: 8g }
//     acme/api.yaml      # acme/api, matched case-insensitively
//       hosts: ["*.example.com"]
//       allow_repo_hosts: false  # overrides default.yaml for this repo
//       allow_preview: true      # its `preview` hook runs, with the Docker socket (root)
//       allow_branch_docker_images: true  # a pull request's runs build its branch's Dockerfile
//       limits: { cpus: 4 }      # over default.yaml's, over SANDBOX_*
//       mounts:                  # per repo only
//         - root: /nfs/work
//           read_only: false     # default: read-only
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { ConfigError, parseLimits } from "./config.mjs";
import { hostProblem, refusedRepoHosts } from "./egress.mjs";
import { PLAIN_PATH, RESERVED } from "./repo-config.mjs";
import { isMap, parseYaml } from "./yaml.mjs";

// The sandbox's user (sandbox/Dockerfile): who must not be able to rewrite a read-write
// mount's path.
export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;

export const DEFAULT_FILE = "default.yaml";

// "acme/api.yaml": a repo's file, with GitHub's characters for owners and repos.
const REPO_FILE = /^([\w.-]+)\/([\w.-]+)\.yaml$/;

// A grants error, with the file it comes from (relative to GRANTS_DIR) when there is one, so
// the dashboard can name the file to edit.
export class GrantsError extends ConfigError {
  constructor(message, file = null) {
    super(message);
    this.file = file;
  }
}

// The yes-or-no grants, by key: per repo or in default.yaml, all false by default.
const FLAGS = {
  allow_repo_hosts: "allowRepoHosts",
  allow_preview: "allowPreview",
  allow_dockerfile: "allowDockerfile",
  allow_branch_docker_images: "allowBranchDockerImages",
};

const NO_FLAGS = Object.fromEntries(Object.values(FLAGS).map((f) => [f, null]));

// One file's text → { hosts, mounts, limits, and FLAGS }; a flag is null when the file doesn't
// say, so default.yaml decides (grantFor), and limits null unless it sets them. `file` names it
// in errors; `base`: the limits its own start from. Throws a GrantsError listing every error.
export function parseGrant(text, file, base, { isDefault = false } = {}) {
  const errors = [];
  const fail = (what) => errors.push(what);
  let value;
  try {
    value = parseYaml(text) ?? {};
  } catch (error) {
    throw new GrantsError(`${file}: ${error.message}`, file);
  }
  if (!isMap(value)) throw new GrantsError(`${file}: expected a mapping of grants`, file);
  const grant = { hosts: [], ...NO_FLAGS, mounts: [], limits: null };
  for (const [key, v] of Object.entries(value)) {
    if (Object.hasOwn(FLAGS, key)) {
      if (typeof v === "boolean") grant[FLAGS[key]] = v;
      else fail(`${key}: expected true or false`);
    } else if (key === "hosts") {
      if (!Array.isArray(v)) fail("hosts: expected a list of host names");
      else
        for (const host of v) {
          if (hostProblem(host)) fail(`hosts: ${JSON.stringify(host)}: ${hostProblem(host)}`);
          else grant.hosts.push(host.toLowerCase());
        }
    } else if (key === "limits") {
      try {
        if (!isMap(v)) throw new ConfigError("limits: expected cpus, memory, pids");
        grant.limits = parseLimits(v, base, (k) => `limits.${k}`);
      } catch (error) {
        fail(error.message);
      }
    } else if (key === "mounts" && isDefault) {
      // A root for every repo would be too broad to grant by accident.
      fail("mounts: only a repository's own file grants mounts");
    } else if (key === "mounts") {
      if (!Array.isArray(v)) {
        fail("mounts: expected a list of { root, read_only }");
        continue;
      }
      for (const mount of v) {
        const root = isMap(mount) ? mount.root : mount;
        const clean = typeof root === "string" ? root.replace(/(.)\/$/, "$1") : null;
        if (!clean || !PLAIN_PATH.test(clean) || posix.normalize(clean) !== clean) {
          fail(`mounts: expected a plain absolute root, got ${JSON.stringify(root)}`);
        } else if (isMap(mount) && ![undefined, true, false].includes(mount.read_only)) {
          fail(`mounts: ${clean}: read_only: expected true or false`);
        } else {
          grant.mounts.push({
            root: clean,
            readOnly: !isMap(mount) || mount.read_only !== false,
          });
        }
      }
    } else {
      const keys = ["hosts", "limits", ...(isDefault ? [] : ["mounts"])];
      fail(`${key}: unknown (${keys.join(", ")} or ${Object.keys(FLAGS).join(", ")})`);
    }
  }
  if (errors.length) throw new GrantsError(`${file}: ${errors.join("; ")}`, file);
  return grant;
}

// The folder's files, by path relative to it ("acme/api.yaml") → text, or a function reading
// it (read when a run needs it), as loadGrants() finds them, into what grantFor() reads.
// `problems`: what the scan found wrong outside a repo's file. default.yaml is parsed now;
// a repo's file when first asked for, and its errors stop that repo only. A broken
// default.yaml or a file that isn't <owner>/<repo>.yaml throws: it stops every run.
export function grantsFrom(files, config, problems = []) {
  const errors = [...problems];
  const culprits = new Set(problems.map((p) => p.file));
  const wrong = (file, what) => {
    errors.push({ file, what });
    culprits.add(file);
  };
  const text = (value) => (typeof value === "function" ? value() : value);
  const found = new Map(); // lowercase "owner/repo" → its file
  let defaults = null;
  for (const [file, value] of Object.entries(files)) {
    if (file === DEFAULT_FILE) {
      try {
        defaults = parseGrant(text(value), file, config.limits, { isDefault: true });
      } catch (error) {
        wrong(file, error.message.replace(/^(grants: )?default\.yaml: /, ""));
      }
      continue;
    }
    const match = REPO_FILE.exec(file);
    if (!match) {
      const hint = /\.yml$/i.test(file) ? "; name it .yaml" : "";
      wrong(file, `not a grant: expected ${DEFAULT_FILE} or <owner>/<repo>.yaml${hint}`);
      continue;
    }
    const repo = `${match[1]}/${match[2]}`.toLowerCase();
    const twin = found.get(repo);
    if (twin) {
      wrong(file, `the same repository as ${twin.file} (names are case-insensitive)`);
      continue;
    }
    found.set(repo, { file, value });
  }
  if (errors.length) {
    const file = culprits.size === 1 ? [...culprits][0] : null;
    const list = errors.map(({ file, what }) => (file ? `${file}: ${what}` : what));
    throw new GrantsError(`grants: ${list.join("; ")}`, file);
  }
  const base = defaults?.limits ?? config.limits;
  const repos = new Map();
  for (const [repo, { file, value }] of found) {
    let result = null;
    const load = () => {
      if (!result) {
        try {
          result = { grant: parseGrant(text(value), file, base) };
        } catch (error) {
          const message = `grants: ${error instanceof GrantsError ? error.message : `${file}: ${error.message}`}`;
          result = { error: new GrantsError(message, file) };
        }
      }
      if (result.error) throw result.error;
      return result.grant;
    };
    repos.set(repo, { file, load });
  }
  return { defaults, repos, config };
}

// GRANTS_DIR, scanned: { files, problems } for grantsFrom(). Dot entries (.git, .github) and
// files that aren't YAML (README.md, CODEOWNERS) are skipped. Symlinks are followed only when
// they stay in the folder (a mounted git checkout can hold any): a repo file leading out is
// that repo's error, a folder leading out everyone's.
function scanGrants(dir, read) {
  let top;
  try {
    top = realpathSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return { files: {}, problems: [] };
    throw new GrantsError(`grants: GRANTS_DIR ${dir}: ${error.code ?? error.message}`);
  }
  if (!statSync(top).isDirectory()) {
    throw new GrantsError(`grants: GRANTS_DIR ${dir}: expected a folder`);
  }
  const files = {};
  const problems = [];
  const seen = new Set([top]);
  const refuse = (file, what) => () => {
    throw new GrantsError(`grants: ${file}: ${what}`, file);
  };
  const walk = (real, rel) => {
    let entries;
    try {
      entries = readdirSync(real, { withFileTypes: true });
    } catch (error) {
      problems.push({ file: rel, what: `can't be read (${error.code ?? error.message})` });
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      const yaml = /\.ya?ml$/i.test(entry.name);
      let path = join(real, entry.name);
      let folder = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        let resolved = null;
        try {
          resolved = realpathSync(path);
          folder = statSync(resolved).isDirectory();
        } catch {
          // Leads nowhere: an error for a grant, nothing for anything else.
        }
        if (!resolved || !within(resolved, top)) {
          const what = resolved
            ? "a symlink leading outside the grants folder"
            : "a broken symlink";
          if (yaml && !folder) files[file] = refuse(file, what);
          else if (folder) problems.push({ file, what });
          continue;
        }
        path = resolved;
      }
      if (folder) {
        if (seen.has(path)) continue;
        seen.add(path);
        walk(path, file);
      } else if (yaml && (entry.isFile() || entry.isSymbolicLink())) {
        files[file] = () => {
          try {
            return read(path);
          } catch (error) {
            return refuse(file, `can't be read (${error.code ?? error.message})`)();
          }
        };
      }
    }
  };
  walk(top, "");
  return { files, problems };
}

// The grants folder, read now: throws a GrantsError when its layout or default.yaml has
// errors (no run starts); a repo's file is read when grantFor() asks for it. No folder: no
// grants. `read(path)`: a file's text.
export function loadGrants(config, read = (path) => readFileSync(path, "utf8")) {
  const { files, problems } = scanGrants(config.grantsDir, read);
  return grantsFrom(files, config, problems);
}

// Every repo file's error: the listener starts without them (they stop that repo's runs
// only), but says so at start.
export function grantErrors(grants) {
  const errors = [];
  for (const { load } of grants.repos.values()) {
    try {
      load();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

// What one repo gets: default.yaml's grants and its own file's, else nothing extra and the
// operator's limits. Each flag is what its own file says, or else default.yaml, or else
// false; hosts add up; limits are its own over default.yaml's over SANDBOX_*. `files`: where
// it comes from; `hostFiles` and `limitsFile` too, for the dashboard. Throws its file's
// GrantsError when that file has errors.
export function grantFor(grants, config, repo) {
  const defaults = grants.defaults;
  const entry = grants.repos.get(repo.toLowerCase());
  const own = entry?.load() ?? null;
  const hostFiles = {};
  for (const [file, grant] of [
    [DEFAULT_FILE, defaults],
    [entry?.file, own],
  ]) {
    for (const host of grant?.hosts ?? []) hostFiles[host] ??= file;
  }
  const flags = Object.fromEntries(
    Object.values(FLAGS).map((f) => [f, own?.[f] ?? defaults?.[f] ?? false]),
  );
  return {
    hosts: Object.keys(hostFiles),
    ...flags,
    mounts: own?.mounts ?? [],
    limits: own?.limits ?? defaults?.limits ?? config.limits,
    files: [defaults && DEFAULT_FILE, entry?.file].filter(Boolean),
    hostFiles,
    limitsFile: own?.limits ? entry.file : defaults?.limits ? DEFAULT_FILE : null,
  };
}

// What the repo's config asks for that only a grant allows: a preview hook (run with the
// Docker socket, so root on the host) and a Dockerfile (built on the host's Docker, with its
// network). One line each, naming the grant to add; they stop its runs and preview hooks
// like errors in the config.
export function ungranted(grant, settings) {
  const missing = [];
  if (settings.preview && !grant.allowPreview) {
    missing.push(
      "preview: the operator's grants don't set `allow_preview: true` for this repository",
    );
  }
  if (settings.dockerfile && !grant.allowDockerfile) {
    missing.push(
      "dockerfile: the operator's grants don't set `allow_dockerfile: true` for this repository",
    );
  }
  return missing;
}

// What the operator's grants refuse in a repo's settings, checked as a run checks them before
// it starts: { error } when its grants have errors (a GrantsError), else { grant, hosts,
// missing, mounts } (refusedRepoHosts(), ungranted(), resolveMounts()). Shared by the run's preflight and the
// dashboard's repo list, so the list can't call a repo configured when no run starts there.
// `load`: the grants folder (loadGrants(); throws when its layout has errors); `fs`: realpath
// and stat.
export function grantCheck(
  config,
  repo,
  settings,
  { load = () => loadGrants(config), fs = {} } = {},
) {
  let grant;
  try {
    grant = grantFor(load(), config, repo);
  } catch (error) {
    return { error };
  }
  return {
    error: null,
    grant,
    hosts: refusedRepoHosts(config, grant, settings),
    missing: ungranted(grant, settings),
    mounts: resolveMounts(settings.mounts, grant, { caches: settings.caches, ...fs }),
  };
}

// Whether grantCheck() found anything that stops every run.
export const refusedByGrants = (check) =>
  !!check.error || check.hosts.length + check.missing.length + check.mounts.refused.length > 0;

function within(path, root) {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

// Whether the sandbox's user can add, remove or rename entries in a directory. ACLs aren't
// read: docs/security.md says so.
function writableBySandbox({ mode, uid, gid }) {
  return (
    Boolean(mode & 0o002) ||
    (uid === SANDBOX_UID && Boolean(mode & 0o200)) ||
    (gid === SANDBOX_GID && Boolean(mode & 0o020))
  );
}

// Whether the sandbox's user can rename or remove `entry` from `dir`: it can write `dir` and,
// when `dir` is sticky (/tmp), owns `dir` or the entry.
function rewritableEntry(dir, entry) {
  if (!writableBySandbox(dir)) return false;
  return !(dir.mode & 0o1000) || dir.uid === SANDBOX_UID || entry.uid === SANDBOX_UID;
}

// The first directory from / down to `real` (excluded) in which a sandbox could rename the
// next entry on the way, or null. Docker resolves the bind source again when the container
// starts: a sandbox that can rename an entry on the way (through any read-write mount,
// another repo's included) could swap it for a symlink in between. Checked from / rather
// than from this repo's roots: another repo's root may hold them. `real` itself may be
// writable: its own entry is in its parent.
function rewritableParent(real, stat) {
  const parts = real.split("/").filter(Boolean);
  let dir = "/";
  let info;
  try {
    info = stat(dir);
  } catch {
    return dir;
  }
  for (const part of parts) {
    const next = posix.join(dir, part);
    let entry;
    try {
      entry = stat(next);
    } catch {
      return dir; // gone meanwhile: refuse rather than guess
    }
    if (rewritableEntry(info, entry)) return dir;
    dir = next;
    info = entry;
  }
  return null;
}

// A repo's mount requests ({ path, readOnly }) checked against its grant's roots, after
// resolving `..` and symlinks with `realpath` in the listener's own filesystem, where the
// operator mounts each root at the same path. → { mounts: [{ source, target, readOnly }],
// refused: [why], notes: [what was narrowed] }. Mounted from the resolved path; a read-write
// one only when no directory on its way from / can be rewritten by the sandbox's user, so
// another sandbox can't swap a part of it for a symlink before Docker mounts it.
export function resolveMounts(
  requests,
  grant,
  { caches = [], realpath = realpathSync, stat = statSync } = {},
) {
  const mounts = [];
  const refused = [];
  const notes = [];
  const roots = [];
  for (const root of grant.mounts) {
    try {
      roots.push({ ...root, real: realpath(root.root) });
    } catch {
      roots.push({ ...root, real: null });
    }
  }
  for (const { path, readOnly } of requests) {
    const refuse = (why) => refused.push(`\`${path}\`: ${why}`);
    if (!PLAIN_PATH.test(path)) {
      refuse("only letters, digits and ./@+-_ are supported in mount paths");
      continue;
    }
    const target = posix.normalize(path).replace(/(.)\/$/, "$1");
    const clash = [...RESERVED, ...caches].find((r) => within(target, r) || within(r, target));
    if (clash) {
      refuse(`the sandbox uses ${clash} itself`);
      continue;
    }
    if (!grant.mounts.length) {
      refuse("the operator grants this repository no host paths");
      continue;
    }
    const outside = (where) => {
      const unseen = roots.filter((r) => !r.real).map((r) => r.root);
      refuse(
        `resolves to ${where}, outside the roots the operator grants this repository (${grant.mounts.map((m) => m.root).join(", ")})` +
          (unseen.length ? `; the listener can't see ${unseen.join(", ")}` : ""),
      );
    };
    let real;
    try {
      real = realpath(path);
    } catch {
      if (!grant.mounts.some((m) => within(target, m.root))) outside(target);
      else refuse("doesn't exist, or the listener can't see it");
      continue;
    }
    // A read-write root wins over a read-only one holding the same path.
    const root = roots
      .filter((r) => r.real && within(real, r.real))
      .sort((a, b) => Number(a.readOnly) - Number(b.readOnly))[0];
    if (!root) {
      outside(real);
      continue;
    }
    if (!PLAIN_PATH.test(real)) {
      refuse(`resolves to a path with unsupported characters`);
      continue;
    }
    if (!readOnly && root.readOnly) {
      notes.push(`${path} mounted read-only: the operator grants ${root.root} read-only`);
    }
    if (!readOnly && !root.readOnly) {
      const open = rewritableParent(real, stat);
      if (open) {
        refuse(
          `read-write, but the sandbox's user (uid ${SANDBOX_UID}) can write \`${open}\` on its way, so a sandbox could redirect it; make the directories above it read-only for that user, or ask for it read-only`,
        );
        continue;
      }
    }
    mounts.push({ source: real, target, readOnly: readOnly || root.readOnly });
  }
  return { mounts, refused, notes };
}

export function mountArgs(mounts) {
  return mounts.flatMap(({ source, target, readOnly }) => [
    "--mount",
    `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`,
  ]);
}

// No capabilities, no privilege gain through setuid binaries, and the repo's limits (no swap
// beyond its memory).
export function hardeningArgs(limits) {
  return [
    ...["--cap-drop", "ALL", "--security-opt", "no-new-privileges"],
    ...["--cpus", limits.cpus, "--memory", limits.memory, "--memory-swap", limits.memory],
    ...["--pids-limit", String(limits.pids)],
  ];
}
