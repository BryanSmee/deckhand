// What the operator grants each repo, beyond what every sandbox gets: extra hosts, host
// mounts under allowed roots, and its own CPU, memory and pids limits. It lives in the
// operator's GRANTS_FILE, never in a repo: a repo's .deckhand.yaml may request a mount, but
// only a root granted here makes it happen. Read again at each run, so an edit applies
// without a restart. Format: ../docs/security.md.
//
//   org/repo:
//     hosts: ["*.example.com"]
//     limits: { cpus: 4, memory: 8g, pids: 4096 }
//     mounts:
//       - root: /nfs/work
//         read_only: false     # default: read-only
import { readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { ConfigError, parseLimits } from "./config.mjs";
import { hostProblem } from "./egress.mjs";
import { RESERVED } from "./repo-config.mjs";
import { parseYaml } from "./yaml.mjs";

// Docker's --mount is comma-separated: paths stay within these characters.
const PLAIN_PATH = /^\/[\w./@+-]*$/;

function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The file's text → Map of lowercase "owner/repo" → { hosts, mounts, limits }. Any error
// throws a ConfigError listing them all: a broken grants file grants nothing.
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
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      fail("expected an owner/repo key");
      continue;
    }
    const grant = { hosts: [], mounts: [], limits: config.limits };
    for (const [key, v] of Object.entries(value ?? {})) {
      if (key === "hosts") {
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
      } else fail(`${key}: unknown (hosts, limits or mounts)`);
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
export function grantFor(grants, config, repo) {
  return grants.get(repo.toLowerCase()) ?? { hosts: [], mounts: [], limits: config.limits };
}

function within(path, root) {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

// A repo's mount requests ({ path, readOnly }) checked against its grant's roots, after
// resolving `..` and symlinks with `realpath` in the listener's own filesystem, where the
// operator mounts each root at the same path. → { mounts: [{ source, target, readOnly }],
// refused: [why], notes: [what was narrowed] }. Mounted from the resolved path, so a symlink
// can't point it elsewhere between the check and the run.
export function resolveMounts(requests, grant, { caches = [], realpath = realpathSync } = {}) {
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
