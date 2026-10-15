// What the operator grants each repo, beyond what every sandbox gets: extra hosts, whether
// its own .deckhand.yaml may add hosts, host mounts under allowed roots, and its own CPU,
// memory and pids limits. It lives in the operator's GRANTS_FILE, never in a repo: a repo's
// .deckhand.yaml may request a mount or a host, but only a grant here makes it happen. Read
// again at each run, so an edit applies without a restart. Format: ../docs/security.md.
//
//   "*":
//     allow_repo_hosts: true   # every repo's own `hosts` count (default: false)
//   org/repo:
//     hosts: ["*.example.com"]
//     allow_repo_hosts: false  # overrides "*" for this repo
//     limits: { cpus: 4, memory: 8g, pids: 4096 }
//     mounts:
//       - root: /nfs/work
//         read_only: false     # default: read-only
import { readFileSync, realpathSync, statSync } from "node:fs";
import { posix } from "node:path";
import { ConfigError, parseLimits } from "./config.mjs";
import { hostProblem } from "./egress.mjs";
import { RESERVED } from "./repo-config.mjs";
import { parseYaml } from "./yaml.mjs";

// The sandbox's user (sandbox/Dockerfile): who must not be able to rewrite a read-write
// mount's path.
export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;

// Docker's --mount is comma-separated: paths stay within these characters.
const PLAIN_PATH = /^\/[\w./@+-]*$/;

function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The file's text → Map of lowercase "owner/repo" (or "*", every repo) → { hosts,
// allowRepoHosts, mounts, limits }; allowRepoHosts is null when the entry doesn't say, so
// "*" decides (grantFor). Any error throws a ConfigError listing them all: a broken grants
// file grants nothing.
export function parseGrants(text, config) {
  const errors = [];
  const grants = new Map();
  let raw;
  try {
    raw = parseYaml(text) ?? {};
  } catch (error) {
    throw new ConfigError(`grants: ${error.message}`);
  }
  if (!isMap(raw)) throw new ConfigError("grants: expected owner/repo keys at the top level");
  for (const [repo, value] of Object.entries(raw)) {
    const fail = (what) => errors.push(`${repo}: ${what}`);
    const everyRepo = repo === "*";
    if (!everyRepo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      fail('expected an owner/repo key (or "*" for every repo)');
      continue;
    }
    const grant = { hosts: [], allowRepoHosts: null, mounts: [], limits: config.limits };
    for (const [key, v] of Object.entries(value ?? {})) {
      if (key === "allow_repo_hosts") {
        if (typeof v === "boolean") grant.allowRepoHosts = v;
        else fail("allow_repo_hosts: expected true or false");
      } else if (everyRepo) {
        // Hosts and limits for every repo are ALLOWED_HOSTS and SANDBOX_*; mounts for every
        // repo would be too broad to grant by accident.
        fail(`${key}: only allow_repo_hosts applies to every repo`);
      } else if (key === "hosts") {
        if (!Array.isArray(v)) fail("hosts: expected a list of host names");
        else
          for (const host of v) {
            if (hostProblem(host)) fail(`hosts: ${JSON.stringify(host)}: ${hostProblem(host)}`);
            else grant.hosts.push(host.toLowerCase());
          }
      } else if (key === "limits") {
        try {
          if (!isMap(v)) throw new ConfigError(`${repo}: limits: expected cpus, memory, pids`);
          grant.limits = parseLimits(v, config.limits, (k) => `${repo}: limits.${k}`);
        } catch (error) {
          errors.push(error.message);
        }
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
      } else fail(`${key}: unknown (hosts, allow_repo_hosts, limits or mounts)`);
    }
    grants.set(repo.toLowerCase(), grant);
  }
  if (errors.length) throw new ConfigError(`grants: ${errors.join("; ")}`);
  return grants;
}

// The grants file, or no grants when there is none.
export function loadGrants(config, read = (path) => readFileSync(path, "utf8")) {
  let text;
  try {
    text = read(config.grantsFile);
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw new ConfigError(`grants: reading ${config.grantsFile}: ${error.message}`);
  }
  return parseGrants(text, config);
}

// What one repo gets: nothing extra and the operator's limits, unless it is granted more.
// Its own config's hosts count when its entry, or else "*", says allow_repo_hosts: true.
export function grantFor(grants, config, repo) {
  const own = grants.get(repo.toLowerCase()) ?? {
    hosts: [],
    allowRepoHosts: null,
    mounts: [],
    limits: config.limits,
  };
  const allowRepoHosts = own.allowRepoHosts ?? grants.get("*")?.allowRepoHosts ?? false;
  return { ...own, allowRepoHosts };
}

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

// The first directory between `top` (included) and `real` (excluded) that a sandbox could
// write, or null. Docker resolves the bind source again when the container starts: a sandbox
// that can rename an entry on the way (through another read-write mount) could swap it for a
// symlink in between. `real` itself may be writable: its own entry is in its parent.
function rewritableParent(real, top, stat) {
  if (real === top) return null;
  const dirs = [];
  for (let dir = posix.dirname(real); within(dir, top); dir = posix.dirname(dir)) {
    dirs.unshift(dir);
    if (dir === top || dir === "/") break;
  }
  for (const dir of dirs) {
    try {
      if (writableBySandbox(stat(dir))) return dir;
    } catch {
      return dir; // gone meanwhile: refuse rather than guess
    }
  }
  return null;
}

// A repo's mount requests ({ path, readOnly }) checked against its grant's roots, after
// resolving `..` and symlinks with `realpath` in the listener's own filesystem, where the
// operator mounts each root at the same path. → { mounts: [{ source, target, readOnly }],
// refused: [why], notes: [what was narrowed] }. Mounted from the resolved path; a read-write
// one only when no directory on its way below the root can be written by the sandbox's user,
// so another sandbox can't swap a part of it for a symlink before Docker mounts it.
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
      // From the outermost root holding it: a sandbox may write anywhere under that one.
      const top = roots
        .filter((r) => r.real && within(real, r.real))
        .sort((a, b) => a.real.length - b.real.length)[0].real;
      const open = rewritableParent(real, top, stat);
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
