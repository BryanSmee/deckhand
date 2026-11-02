// What the operator grants each repo, beyond what every sandbox gets: the hosts its sandboxes
// may reach (the only place they are listed), the organization projects its runs and the
// listener may write (github-writes.mjs, projects.mjs), host mounts under allowed roots, and its
// CPU, memory and pids limits. It lives in the operator's GRANTS_DIR, never in a repo: a repo's
// .deckhand.yaml may request a mount, but only a grant here makes it happen. One file per repo,
// so a team can own its repos' files (CODEOWNERS), and a mistake in one stops that repo's runs
// only. Read again at each run, so an edit applies without a restart. Format: ../docs/security.md.
//
// The yes-or-no grants (its Dockerfile and its pull requests' branches', a container engine,
// research runs, pushes that change workflows, auto-merge) are the operator's policies' since
// #498: `allow_grant` rules in GRANTS_DIR/policy/, asked per repository (GRANTS, grantsOf()).
// The keys they had here are errors that say what to write instead, but the preview hook's,
// gone (#574): a warning, so that a file that still has them loads.
//
//   grants/
//     default.yaml       # every repo: hosts added to each repo's, base limits
//       hosts: [pypi.org]
//       cached_hosts: [deb.debian.org]  # kept by the egress proxy, HTTPS too
//       limits: { memory: 8g }   # over the built-in 2 CPUs, 4g, 2048 pids
//     acme/api.yaml      # acme/api, matched case-insensitively
//       hosts: ["*.example.com"]
//       allow_projects: [acme/3] # its issues and pull requests on these projects (per repo only)
//       limits: { cpus: 4 }      # over default.yaml's, over the built-in ones
//       mounts:                  # per repo only
//         - root: /nfs/work
//           read_only: false     # default: read-only
//     policy/grants.rego # the yes-or-no grants, for each repository (GRANTS)
//       allow_grant if {
//         input.repo.name == "acme/api"
//         input.grant in {"dockerfile", "docker"}
//       }
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { ConfigError, parseLimits } from "./config.mjs";
import { hostProblem } from "./egress.mjs";
import { PLAIN_PATH, projectName, RESERVED } from "./repo-config.mjs";
import { isMap, parseYaml } from "../lib/yaml.mjs";

// The sandbox's user (sandbox/Dockerfile): who must not be able to rewrite a read-write
// mount's path.
const SANDBOX_UID = 1000;
const SANDBOX_GID = 1000;

const DEFAULT_FILE = "default.yaml";

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

// The yes-or-no grants (#498), each a name `allow_grant` rules give a repository (input.grant):
// the field of the grant (grantFor()) it sets, and what it lets the repository's config do. All
// refused unless the operator's policies allow them; a deny rule of theirs (`deny_grant`) wins.
// A repository's own policies never decide them (policies.mjs OPERATOR_ONLY).
export const GRANTS = {
  // Its .deckhand.yaml's `dockerfile`, built on the host's Docker (capabilities.mjs `image:repo`).
  dockerfile: "allowDockerfile",
  // Its pull requests' runs build their branch's Dockerfile (`image:branch`).
  branch_docker_images: "allowBranchDockerImages",
  // Its `docker`: a container engine next to its sandboxes (`docker`, runner/engine.mjs).
  docker: "allowDocker",
  // `/mode research`: the open internet, without its code (`internet`).
  research: "allowResearch",
  // Its pushes may change .github/workflows/ (git-gateway.mjs).
  workflows: "allowWorkflows",
  // Its `review.merge` merges Deckhand's pull requests on a private repository (reviews.mjs).
  auto_merge: "allowAutoMerge",
  // On a public one too: the field then says "public".
  auto_merge_public: "allowAutoMerge",
};

// The grants a rule must give one repository at a time, never all of them (it names
// input.repo.name): an engine runs that repo's code with more of the kernel exposed
// (runner/engine.mjs), a workflow file a sandbox pushes runs with the repo's Actions secrets, and
// an auto-merge puts model output on the default branch with no human reading it (reviews.mjs),
// so every repo at once would be too broad by accident. Asked again for repositories no one has,
// anywhere (ANY_REPO) and under the asked one's owner (ownerProbe()): a rule that gives it there
// (to every repository, or to all of an owner's: `startswith`, `glob.match`) gives it nowhere
// (policies.mjs grants()). Best effort: a wide rule that misses both names (a `regex.match`, an
// `endswith`) isn't caught. A rule listing names one by one passes.
export const REPO_ONLY = new Set(["docker", "workflows", "auto_merge", "auto_merge_public"]);

// A repository's name no repository has: what a rule that gives a grant to every repository
// gives it to too.
export const ANY_REPO = "*/*";

// The same under `repo`'s owner ("acme/*": GitHub names have no `*`): what a rule that gives a
// grant to all of an owner's repositories gives it to too.
export const ownerProbe = (repo) => `${String(repo).toLowerCase().split("/")[0]}/*`;

// Why the repository doesn't get the grant `name` (GRANTS), as replies and the config page say it.
export const notGranted = (name) =>
  `the operator's policies don't grant \`${name}\` to this repository (\`allow_grant\`)`;

// The grant's fields with nothing granted (grantFor(), until withGrants()).
export const NO_GRANTS = Object.freeze(
  Object.fromEntries(Object.values(GRANTS).map((field) => [field, false])),
);

// The names the operator's policies gave (policies.mjs grants()) → the grant's fields.
export function grantFields(names) {
  const fields = { ...NO_GRANTS };
  for (const name of names) {
    if (Object.hasOwn(GRANTS, name)) fields[GRANTS[name]] = true;
  }
  if (names.has?.("auto_merge_public") ?? names.includes("auto_merge_public")) {
    fields.allowAutoMerge = "public";
  }
  return fields;
}

// The keys a grants file had for them before #498: an error saying what to write instead, so
// that nothing granted is lost without a word (nor anything granted by mistake).
const MOVED = {
  allow_dockerfile: "dockerfile",
  allow_branch_docker_images: "branch_docker_images",
  allow_docker: "docker",
  allow_research: "research",
  allow_workflows: "workflows",
  allow_auto_merge: "auto_merge",
};

// The preview hook's keys, from before #498: the hook is gone (#574), so they grant nothing
// whatever their value, and a grants file that still has them loads, with a warning.
const REMOVED = ["allow_preview", "acknowledge_automerge_and_preview_is_highly_dangerous"];
const removed = (key) =>
  `${key}: the preview hook is gone (#574), ignored: remove it (docs/setup.md#upgrading-the-preview-hook-is-gone-574)`;
// What a grants file's former key (`key`: `value`, in `file`) says to do now. Its value
// decides: `false` granted nothing, and nothing is granted by default now, so the key goes (in a
// repository's file, a `deny_grant` keeps out what a rule for every repository would give it);
// a REPO_ONLY key in default.yaml was never valid there; any other value, the rule granting it.
function moved(key, file, value) {
  const publicMerge = key === "allow_auto_merge" && value === "public";
  const name = publicMerge ? "auto_merge_public" : MOVED[key];
  const repo = REPO_FILE.exec(file);
  const own = repo && `${repo[1]}/${repo[2]}`.toLowerCase();
  const where = "in policy/ of the grants folder (docs/security.md#the-grants)";
  // Neither true, false nor (auto-merge's) public: never valid, and no rule to copy from it.
  if (value !== true && value !== false && !publicMerge) {
    const allowed = key === "allow_auto_merge" ? "true, false or public" : "true or false";
    return `${key}: gone (#498), and its value ${JSON.stringify(value)} never was valid (${allowed}): remove it, and grant what the repository needs ${where}`;
  }
  if (value === false) {
    // Either auto-merge grant merges on a private repository: keeping it out takes both.
    const which =
      key === "allow_auto_merge"
        ? 'input.grant in {"auto_merge", "auto_merge_public"}'
        : `input.grant == "${name}"`;
    const keep = own
      ? `; to keep from ${own} a grant your policies give every repository, \`deny_grant contains "…" if { input.repo.name == "${own}"; ${which} }\` ${where}`
      : "";
    return `${key}: gone (#498), remove it: nothing is granted unless the operator's policies grant it${keep}`;
  }
  if (!own && REPO_ONLY.has(name)) {
    return `${key}: gone (#498), and never valid in default.yaml: grant \`${name}\` one repository at a time, \`allow_grant if { input.repo.name == "<owner>/<repo>"; input.grant == "${name}" }\` ${where}`;
  }
  const which = own ? `input.repo.name == "${own}"; ` : "";
  return `${key}: moved to the operator's policies (#498): \`allow_grant if { ${which}input.grant == "${name}" }\` ${where}`;
}

// The keys listing hosts: what a run may reach, and of those, what the egress proxy may keep
// in its cache, HTTPS too (proxy/cache.mjs, proxy/authority.mjs).
const HOST_LISTS = { hosts: "hosts", cached_hosts: "cachedHosts" };

// One file's text → { hosts, cachedHosts, mounts, allowProjects, limits, warnings }, limits null
// unless it sets them; warnings, what it has that is ignored (REMOVED). `file` names it
// in errors; `base`: the limits its own start from. Throws a GrantsError listing every error.
function parseGrant(text, file, base, { isDefault = false } = {}) {
  const errors = [];
  const fail = (what) => errors.push(what);
  let value;
  try {
    value = parseYaml(text) ?? {};
  } catch (error) {
    throw new GrantsError(`${file}: ${error.message}`, file);
  }
  if (!isMap(value)) throw new GrantsError(`${file}: expected a mapping of grants`, file);
  const grant = {
    hosts: [],
    cachedHosts: [],
    mounts: [],
    allowProjects: [],
    limits: null,
    warnings: [],
  };
  for (const [key, v] of Object.entries(value)) {
    if (REMOVED.includes(key)) {
      grant.warnings.push(`${file}: ${removed(key)}`);
    } else if (key === "allow_repo_hosts") {
      // Ignoring it would quietly take away the hosts the repo's .deckhand.yaml added.
      fail(`${key}: gone, list the hosts its sandboxes may reach under hosts here`);
    } else if (Object.hasOwn(MOVED, key)) {
      fail(moved(key, file, v));
    } else if (Object.hasOwn(HOST_LISTS, key)) {
      parseHosts(key, v, grant[HOST_LISTS[key]], fail);
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
      parseMounts(v, grant.mounts, fail);
    } else if (key === "allow_projects" && isDefault) {
      // A project is outside every repository: which repo's runs write it is the operator's
      // choice, one repo at a time.
      fail("allow_projects: only a repository's own file grants projects");
    } else if (key === "allow_projects") {
      parseProjects(v, grant.allowProjects, fail);
    } else {
      const keys = [
        "hosts",
        "cached_hosts",
        "limits",
        ...(isDefault ? [] : ["mounts", "allow_projects"]),
      ];
      fail(`${key}: unknown (${keys.join(", ")})`);
    }
  }
  if (errors.length) throw new GrantsError(`${file}: ${errors.join("; ")}`, file);
  return grant;
}

// A grant's list of hosts (`key`: hosts or cached_hosts), lowercased into `list`; `fail`
// collects what's wrong, so one file's errors all show at once.
function parseHosts(key, v, list, fail) {
  if (!Array.isArray(v)) return fail(`${key}: expected a list of host names`);
  for (const host of v) {
    if (hostProblem(host)) fail(`${key}: ${JSON.stringify(host)}: ${hostProblem(host)}`);
    else list.push(host.toLowerCase());
  }
}

// A repo grant's projects, ["acme/3"], into `list` (projectName()).
function parseProjects(v, list, fail) {
  if (!Array.isArray(v)) return fail("allow_projects: expected a list of <organization>/<number>");
  for (const project of v) {
    const name = projectName(project);
    if (!name) fail(`allow_projects: ${JSON.stringify(project)}: expected <organization>/<number>`);
    else if (!list.includes(name)) list.push(name);
  }
}

// A repo grant's mount roots, a path or { root, read_only }, into `mounts` as
// { root, readOnly }: read-only unless the grant says read_only: false.
function parseMounts(v, mounts, fail) {
  if (!Array.isArray(v)) return fail("mounts: expected a list of { root, read_only }");
  for (const mount of v) {
    const root = isMap(mount) ? mount.root : mount;
    const clean = typeof root === "string" ? root.replace(/(.)\/$/, "$1") : null;
    if (!clean || !PLAIN_PATH.test(clean) || posix.normalize(clean) !== clean) {
      fail(`mounts: expected a plain absolute root, got ${JSON.stringify(root)}`);
    } else if (isMap(mount) && ![undefined, true, false].includes(mount.read_only)) {
      fail(`mounts: ${clean}: read_only: expected true or false`);
    } else {
      mounts.push({
        root: clean,
        readOnly: !isMap(mount) || mount.read_only !== false,
      });
    }
  }
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
  const scan = { top, read, files: {}, problems: [], seen: new Set([top]) };
  walkGrants(scan, top, "");
  return { files: scan.files, problems: scan.problems };
}

// A grant file's reader that throws `what` instead: the error is that repo's alone, met when
// a run needs its grant.
function refuseGrant(file, what) {
  return () => {
    throw new GrantsError(`grants: ${file}: ${what}`, file);
  };
}

// One folder of scanGrants()'s: `real` its resolved path, `rel` its path in the grants folder.
function walkGrants(scan, real, rel) {
  let entries;
  try {
    entries = readdirSync(real, { withFileTypes: true });
  } catch (error) {
    scan.problems.push({ file: rel, what: `can't be read (${error.code ?? error.message})` });
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    scanEntry(scan, real, rel ? `${rel}/${entry.name}` : entry.name, entry);
  }
}

// One entry of a grants folder: a subfolder is walked, a YAML file read when asked for, and a
// symlink followed only when it stays in the folder.
function scanEntry(scan, real, file, entry) {
  const { top, read, files, problems, seen } = scan;
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
    if (!resolved || !inFolder(resolved, top)) {
      const what = resolved ? "a symlink leading outside the grants folder" : "a broken symlink";
      if (yaml && !folder) files[file] = refuseGrant(file, what);
      else if (folder) problems.push({ file, what });
      return;
    }
    path = resolved;
  }
  if (folder) {
    if (seen.has(path)) return;
    seen.add(path);
    walkGrants(scan, path, file);
  } else if (yaml && (entry.isFile() || entry.isSymbolicLink())) {
    files[file] = () => {
      try {
        return read(path);
      } catch (error) {
        return refuseGrant(file, `can't be read (${error.code ?? error.message})`)();
      }
    };
  }
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

// What the grants folder has that is ignored (parseGrant()'s warnings), for the listener to say
// at start: default.yaml's and each repo file's that loads (grantErrors() says the others').
export function grantWarnings(grants) {
  const warnings = [...(grants.defaults?.warnings ?? [])];
  for (const { load } of grants.repos.values()) {
    try {
      warnings.push(...load().warnings);
    } catch {
      // grantErrors()'.
    }
  }
  return warnings;
}

// The operator's policy files (name → text) that name an auto-merge grant, for the warning at
// start: a rule may give it to some repository. Only read, not evaluated: loud rather than exact.
export function autoMergeFiles(files) {
  return [...files]
    .filter(([, text]) => /^\s*allow_grant\b/m.test(text) && /"auto_merge(_public)?"/.test(text))
    .map(([name]) => name);
}

// What one repo gets: default.yaml's grants and its own file's, else nothing extra and the
// operator's limits: hosts add up, and cached hosts too; limits are its own over default.yaml's
// over the built-in ones. `files`: where it comes from; `hostFiles` and `limitsFile` too, for the
// dashboard. The yes-or-no grants (GRANTS) all false: the policies' (withGrants()). Throws its
// file's GrantsError when that file has errors.
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
  const cachedHosts = [...new Set([...(defaults?.cachedHosts ?? []), ...(own?.cachedHosts ?? [])])];
  return {
    hosts: Object.keys(hostFiles),
    cachedHosts,
    ...NO_GRANTS,
    grantFiles: [],
    mounts: own?.mounts ?? [],
    allowProjects: own?.allowProjects ?? [],
    limits: own?.limits ?? defaults?.limits ?? config.limits,
    files: [defaults && DEFAULT_FILE, entry?.file].filter(Boolean),
    hostFiles,
    limitsFile: own?.limits ? entry.file : defaults?.limits ? DEFAULT_FILE : null,
  };
}

// `grant` (grantFor()'s) with the yes-or-no grants the operator's policies give (policies.mjs
// grants(): { granted, files }, null: none).
export function withGrants(grant, said) {
  if (!said) return grant;
  return { ...grant, ...grantFields(said.granted), grantFiles: said.files ?? [] };
}

// What grantOf() asks the operator's policies with: `policies` (policies.mjs createPolicies()),
// null when there are none (nothing granted).
export const grantsBy = (policies) => (policies ? (repo) => policies.grants(repo) : null);

// What one repo gets (grantFor()) with what the operator's policies grant it (withGrants()):
// `granted(repo)`, policies.mjs grants(), absent: nothing (fail closed). Throws a GrantsError when
// its grants file has errors or the policies can't decide.
export async function grantOf(
  config,
  repo,
  { load = () => loadGrants(config), granted = null } = {},
) {
  const grant = grantFor(load(), config, repo);
  if (!granted) return grant;
  const said = await granted(repo);
  if (said.error) {
    throw new GrantsError(`grants: the operator's policies can't decide ${repo}'s: ${said.error}`);
  }
  return withGrants(grant, said);
}

// What the repo's config asks for that only a grant allows: a Dockerfile (built on the host's
// Docker, with its network) and a container engine (runner/engine.mjs). One line each, naming
// the grant to add; they stop its runs like errors in the config.
export function ungranted(grant, settings) {
  const missing = [];
  if (settings.dockerfile && !grant.allowDockerfile) {
    missing.push(`dockerfile: ${notGranted("dockerfile")}`);
  }
  if (settings.docker && !grant.allowDocker) {
    missing.push(`docker: ${notGranted("docker")}`);
  }
  return missing;
}

// Why the repo's `review.merge` merges nothing, one line each (empty: auto-merge is on). Not
// in ungranted(): the reviews still run, only the merge waits for a human. `isPrivate`: what
// GitHub says, null when unknown (the merge checks it again, reviews.mjs).
export function autoMergeProblems(grant, settings, isPrivate = null) {
  if (!settings?.review?.merge) return [];
  const problems = [];
  if (!grant?.allowAutoMerge) {
    problems.push(`review.merge: ${notGranted("auto_merge")}, nothing is merged`);
  } else if (isPrivate === false && grant.allowAutoMerge !== "public") {
    problems.push(
      "review.merge: the repository is public and the operator's policies grant it `auto_merge`, not `auto_merge_public`: nothing is merged",
    );
  }
  if (settings.review.on !== "ready") {
    problems.push("review.merge: needs `review.on: ready`, nothing is merged");
  }
  return problems;
}

// What the operator's grants refuse in a repo's settings, checked as a run checks them before
// it starts: { error } when its grants have errors or its policies can't decide them (a
// GrantsError), else { grant, missing, mounts } (ungranted(), resolveMounts()). Shared by the
// run's preflight and the dashboard's repo list, so the list can't call a repo configured when
// no run starts there. `load`: the grants folder (loadGrants(); throws when its layout has
// errors); `granted(repo)`: the policies' grants (grantOf()); `fs`: realpath and stat.
export async function grantCheck(
  config,
  repo,
  settings,
  { load = () => loadGrants(config), granted = null, fs = {} } = {},
) {
  let grant;
  try {
    grant = await grantOf(config, repo, { load, granted });
  } catch (error) {
    return { error };
  }
  return {
    error: null,
    grant,
    missing: ungranted(grant, settings),
    mounts: resolveMounts(settings.mounts, grant, { caches: settings.caches, ...fs }),
  };
}

// Whether grantCheck() found anything that stops every run.
export const refusedByGrants = (check) =>
  !!check.error || check.missing.length + check.mounts.refused.length > 0;

// Whether `path` is the grants folder `dir` or under it, in the host's own paths: unlike the
// mounts' (Linux's, within()), `\` on Windows, where the tests run too (#565).
function inFolder(path, dir) {
  const rel = relative(dir, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function within(path, root) {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

// Whether the sandbox's user can add, remove or rename entries in a directory. Owning it is
// enough, write bit or not: an owner can chmod it back (no capability needed). ACLs aren't
// read: docs/security.md says so.
function writableBySandbox({ mode, uid, gid }) {
  return (
    Boolean(mode & 0o002) || uid === SANDBOX_UID || (gid === SANDBOX_GID && Boolean(mode & 0o020))
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
          `read-write, but the sandbox's user (uid ${SANDBOX_UID}) can write \`${open}\` on its way, so a sandbox could redirect it; make the directories above it read-only for that user and owned by another, or ask for it read-only`,
        );
        continue;
      }
    }
    mounts.push({ source: real, target, readOnly: readOnly || root.readOnly });
  }
  return { mounts, refused, notes };
}
