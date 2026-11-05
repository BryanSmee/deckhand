// What a work run that isn't a fork's may fetch of GitHub (issue #409). A fork's run (a comment
// from a fork's pull request started it: preparation.mjs) gets no caches, no container engine
// and read-only mounts, as its code may run; a work run started anywhere else gets them all,
// and could still bring a fork's code in itself (`gh pr checkout`, `git fetch origin
// refs/pull/<n>/head`, an archive, raw files), a prompt injection asking for it. So the GitHub
// gateway (github-gateway.mjs) refuses such a run what would bring it, saying why:
//
// - a fork in its repository's network (one whose source is the same repository), by name or
//   id: its git, its API, its pages and raw files, all of it;
// - in its repository (and its parent, when the repository is itself a fork), a pull request's
//   head or merge from a fork (`refs/pull/<n>/…`), and a commit that isn't the repository's:
//   in a fetch's `want`s, an archive, a commit or comparison (their patches), raw files and
//   web pages, any call's `ref`, `sha`, `head` or `base` parameter (contents, readme, license,
//   whatever takes one), and a fork's pull request's diff and files. A commit is the
//   repository's when a ref of its own pointed at it in what GitHub advertised to the run's
//   git, when its default branch has it, or when it is a branch's head; a branch or tag name
//   always is. Anything else (a commit a branch dropped, one reachable only from a tag, a blob
//   or tree wanted on its own) is refused rather than looked for;
// - a blob read by its id (`git/blobs/<sha>`, or a fetch's `want`): whoever wrote a fork can
//   name its blobs, and nothing says where one comes from. So such a run's clone is whole
//   (sandbox-spec.mjs SANDBOX_FULL_CLONE), and never fetches a blob on its own. git LFS's
//   objects (its batch API, `info/lfs/`), named by their sha256, likewise;
// - over GraphQL (checkGraphql(), for github-graphql.mjs): a file's content (`... on Blob`),
//   CODEOWNERS at a ref, a fork's repository named by `repository(owner:, name:)` whatever is
//   read of it, and of a repository reached otherwise anything but its metadata.
//
// What GitHub answers for the lookups is kept a while: whether a pull request or repository is
// a fork's doesn't change, and a commit stays on a branch it was found on.
import { gunzipSync } from "node:zlib";
import { keepLast } from "../lib/capped.mjs";
import { headInRepo } from "./events.mjs";
import { pktLines, pktReader } from "./pkt-line.mjs";

// How long a pull request's, repository's or commit's answer is kept, and how many of each.
export const LOOKUP_MS = 10 * 60_000;
const MAX_KEPT = 10_000;
// The advertised objects a run's memory keeps, per repository; past it, the oldest go, and
// what they named is looked up again.
export const MAX_REFS = 100_000;
// The most of a fetch's request read (inflated).
export const MAX_FETCH = 16 * 1024 * 1024;
// The wants of a fetch looked up on GitHub (no ref advertised them), at most: a fetch of many
// such objects is a partial clone's, never one of a ref's, and is refused at once.
export const MAX_LOOKUPS = 20;

// A SHA-1 or SHA-256 object id, as git reads it: any case.
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
// The path segments a ref spelled like a commit id may span, as a branch's name (`2024/q4`).
const MAX_SEGMENTS = 20;
// How long a commit found nowhere in the repository stays refused without asking GitHub again:
// briefly, as a run may push it meanwhile.
export const REFUSED_MS = 60_000;
// The GitHub lookups a run's calls may cause in a minute (createForkChecks() ask()).
export const RUN_LOOKUPS = 120;
// What may be a commit's id, abbreviated as git allows (4 digits and up).
const HEX = /^[0-9a-f]{4,64}$/i;
// The parameters GitHub reads a ref or commit from, on any of its calls that takes one (`ref`
// on contents, readme, license, codeowners…; `sha`, `head`, `base`): all of them are checked,
// whatever the path, rather than a list of the calls that would serve a file. A pull request
// list's `head` and `base` only filter it, by branch: not checked there.
const REF_PARAMS = ["ref", "sha", "head", "base"];
// A repository's web pages that show no file's content: its home, issues, pull request lists,
// releases (their assets the maintainers' uploads; their source archives are archive/ links,
// checked), tags, branches, labels, milestones, the Actions and workflow lists (a run's own
// pages are its run's: callTargets()), discussions, the wiki, pulse, graphs, stargazers,
// watchers, forks and settings. Not git's calls, which the GitHub gateway checks as fetches
// first (any other spelling of them lands here, refused), nor security's (code scanning quotes
// a pull request's code), nor any other.
const WEB_PAGES = new RegExp(
  String.raw`^(?:|actions(?:\/workflows\/[^/]+)?|pulls(?:\/[a-z-]+)?|(?:issues|releases|tags|branches|labels|milestones?|discussions|wiki|pulse|graphs|stargazers|watchers|forks|settings)(?:\/.*)?)$`,
  "i",
);
// Where a commit's metadata is read, not its patch: its statuses, checks, pull requests.
const COMMIT_METADATA =
  /\/(?:status|statuses|check-runs|check-suites|pulls|comments|branches-where-head)$/i;

// What a fork's code comes in, and how to get it: one sentence for every refusal.
export const FORK_RUN =
  "a fork's code only comes in a fork's run, which a comment on its pull request from an allowed user starts";

// An upload-pack request (protocol v0's or v2's) → { command, wants, refs }: the command (v2's
// `fetch` or `ls-refs`; null for v0, whose requests only fetch), the objects it asks for
// (lowercased: git reads an id in any case) and the refs it asks for by name (v2's
// `want-ref`). Throws on what isn't one, and on a `want` line it can't read: fail closed.
export function fetchRequest(body) {
  const lines = pktLines(body).map((line) => line.toString("latin1").replace(/\n$/, ""));
  if (!lines.length) throw new Error("not a git fetch");
  let command = null;
  const wants = [];
  const refs = [];
  for (const line of lines) {
    const named = /^command=(\S+)$/.exec(line);
    if (named) command = named[1];
    if (!/^want/i.test(line)) continue;
    const want = /^want ([0-9a-f]+)(?:\s|$)/i.exec(line);
    const ref = /^want-ref (\S+)$/.exec(line);
    if (want && OID.test(want[1])) wants.push(want[1].toLowerCase());
    else if (ref) refs.push(ref[1]);
    else throw new Error("a fetch line Deckhand can't read");
  }
  return { command, wants, refs };
}

// An upload-pack request's body as read: inflated when git sent it compressed (a long
// negotiation), up to MAX_FETCH. Throws past it, or on an encoding it doesn't read.
export function fetchBody(body, encoding = "identity") {
  const coding = String(encoding).trim().toLowerCase();
  if (coding === "identity" || coding === "") return body;
  if (coding !== "gzip" && coding !== "x-gzip") throw new Error(`a ${coding}-encoded fetch`);
  return gunzipSync(body, { maxOutputLength: MAX_FETCH });
}

// The refs an advertisement names (v0's info/refs, v2's ls-refs answer), read as it streams:
// push(chunk) each chunk, refs() → [{ oid, ref }], a peeled tag's commit under its tag's name
// too, MAX_REFS of them at most (pkt-line.mjs pktReader(): only a line being cut is held).
export function advertisementReader() {
  const refs = [];
  const add = (oid, ref) => refs.length < MAX_REFS && refs.push({ oid: oid.toLowerCase(), ref });
  const reader = pktReader((payload) => {
    const text = payload.toString("latin1").split("\0")[0].replace(/\n$/, "");
    const match = /^([0-9a-f]+) (\S+)(.*)$/i.exec(text);
    if (!match || !OID.test(match[1]) || /^0+$/.test(match[1])) return;
    const ref = match[2].replace(/\^\{\}$/, "");
    add(match[1], ref);
    const peeled = /\bpeeled:([0-9a-f]+)/i.exec(match[3]);
    if (peeled && OID.test(peeled[1])) add(peeled[1], ref);
  });
  return { push: reader.push, refs: () => refs };
}

// advertisementReader()'s refs of a whole advertisement.
export function advertisedRefs(buffer) {
  const reader = advertisementReader();
  reader.push(buffer);
  return reader.refs();
}

// Whether `text` is spelled as git names refs (git check-ref-format), so that GitHub can't read
// past what the checks read: a branch name that isn't one isn't taken for the repository's own.
// No component may start with "." (`refs/./pull/7/head`, `.x`), nor the whole with "^" or "~"
// (a revision's syntax), nor hold control characters, a backslash or "//". `path`: it is a ref
// followed by a file's path (raw files, `blob/`, `tree/`), whose own name may hold "..", "@{",
// spaces or a dotfile (`.github/`): only its first segment, where the ref starts, is held to
// them (the URL parser has resolved its "." and ".." segments).
function readableRef(text, path = false) {
  if (!text || /^[\s/:.^~-]/.test(text) || /[\x00-\x1f\x7f\\]|\/\//.test(text)) return false;
  const segments = text.split("/");
  const ref = path ? segments.slice(0, 1) : segments;
  if (ref.some((segment) => segment.startsWith("."))) return false;
  return !/\.\.|@\{/.test(ref.join("/")) && !/[\s?*[]/.test(segments[0]);
}

// What a ref, branch or commit names, as a path or parameter spells it (with what follows it in a
// path, a revision's suffix; `path`: a file's path follows, readableRef()): { pull } for a pull
// request's refs (`refs/pull/<n>/head`, `pull/<n>/merge`), { sha, first, names } for what may be a
// commit (its first segment's hex digits as spelled, and the branch or tag names it may be
// instead), { owner, name, ref } for a ref named with its repository's owner (compare's
// `owner:ref`, `owner:repo:ref`), { invalid } for what git wouldn't take for a ref's name
// (readableRef()), else {}: a branch or tag, the repository's own.
export function refKind(spec, { path = false } = {}) {
  const text = String(spec ?? "");
  if (!readableRef(text, path)) return { invalid: true };
  // compare's `owner:ref` or `owner:repo:ref`: the ref after it is read as any other.
  const other = /^([^/:]+):(?:([^/:]+):)?(.*)$/.exec(text);
  if (other) return { owner: other[1], name: other[2] ?? null, ref: other[3] };
  const pull = /^(?:refs\/)?pull\/(\d+)(?:[/~^@.]|$)/i.exec(text);
  if (pull) return { pull: Number(pull[1]) };
  const segments = text.split("/");
  const first = segments[0].split(/[~^@.]/)[0];
  if (!HEX.test(first)) return {};
  // `names`: the branch or tag it may be instead, which starts like a commit id (`2024.1`, a
  // tag; `2024/q4`, a branch): each prefix of its path, a parameter's whole value the longest.
  const prefixes = segments
    .slice(0, MAX_SEGMENTS)
    .map((_, i) => segments.slice(0, i + 1).join("/"));
  return { sha: first.toLowerCase(), first, names: [...new Set([...prefixes, first])] };
}

// The repository a call names, and what in it may be a fork's: { repo } (owner/name) or { id }, and
// { refs, paths, pulls, actions, analyses, blob, lfs, page } (refKind()'s specs: whole refs, and
// refs followed by a file's path; pull request numbers; the workflow runs, jobs or artifacts whose
// output it downloads; the code scanning analyses it downloads as SARIF; whether it reads a blob by
// its id, git LFS's objects, or a web page these checks don't read); null for a call that names
// none. `kind`: "api" (REST, its path under the API's base), "web" (the web host's path, and
// patch-diff.githubusercontent.com's) or "raw" (raw.githubusercontent.com's, and
// media.githubusercontent.com's); `query`, its URLSearchParams; `accept`, its header. Trees and a
// commit's metadata (`git/trees`, `git/commits`) hold no file's content: not checked.
export function callTargets(kind, path, query = new URLSearchParams(), accept = "") {
  let repo = null;
  let id = null;
  let rest = "";
  if (kind === "api") {
    const named = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(path);
    const numbered = /^repositories\/(\d+)(?:\/(.*))?$/i.exec(path);
    if (named) [repo, rest] = [`${named[1]}/${named[2]}`, named[3] ?? ""];
    else if (numbered) [id, rest] = [Number(numbered[1]), numbered[2] ?? ""];
    else return null;
  } else {
    const named = /^([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!named) return null;
    repo = `${named[1]}/${named[2].replace(/\.git$/i, "")}`;
    rest = named[3] ?? "";
  }
  const refs = [];
  const paths = [];
  const pulls = [];
  const actions = [];
  const analyses = [];
  let blob = false;
  let lfs = false;
  let page = false;
  // Any call's ref parameters, every value of each (GitHub may read the last), whatever their
  // case or brackets (`ref[]`, read as `ref` too).
  for (const [key, value] of query) {
    const name = key.toLowerCase().replace(/\[.*$/, "");
    if (!REF_PARAMS.includes(name)) continue;
    if (kind === "api" && /^pulls\/?$/i.test(rest) && name !== "ref" && name !== "sha") continue;
    refs.push(value);
  }
  const strip = (ref) => ref.replace(/\.(?:tar\.gz|tgz|zip|diff|patch)$/i, "");
  // A comparison's sides: `a...b` or `a..b`; one with more dots is no comparison git reads, and
  // goes whole to the checks, which refuse its `..`.
  const sides = (spec) =>
    /\.{4,}/.test(spec)
      ? [spec]
      : strip(spec)
          .split(/\.{2,3}/)
          .filter(Boolean);
  let m;
  if (kind === "raw") {
    if (rest) paths.push(rest);
  } else if (kind === "api") {
    if ((m = /^(?:tarball|zipball)\/(.+)$/i.exec(rest))) refs.push(m[1]);
    else if (/^git\/blobs(?:\/|$)/i.test(rest)) blob = true;
    else if ((m = /^commits\/(.+)$/i.exec(rest)) && !COMMIT_METADATA.test(rest)) refs.push(m[1]);
    else if ((m = /^compare\/(.+)$/i.exec(rest))) refs.push(...sides(m[1]));
    else if ((m = /^pulls\/(\d+)\/files$/i.exec(rest))) pulls.push(Number(m[1]));
    else if ((m = /^pulls\/(\d+)$/i.exec(rest)) && /diff|patch/i.test(accept)) {
      pulls.push(Number(m[1]));
    }
    // What a workflow run made, which a fork's pull request's workflow writes: its artifacts
    // (the fork's tree zipped, if it chose) and its logs.
    else if ((m = /^actions\/artifacts\/(\d+)\/.+$/i.exec(rest))) {
      actions.push({ artifact: Number(m[1]) });
    } else if ((m = /^actions\/runs\/(\d+)\/(?:attempts\/\d+\/)?logs$/i.exec(rest))) {
      actions.push({ run: Number(m[1]) });
    } else if ((m = /^actions\/jobs\/(\d+)\/logs$/i.exec(rest))) {
      actions.push({ job: Number(m[1]) });
    }
    // A code scanning analysis as SARIF, which may quote the code it analysed (a pull request's).
    else if ((m = /^code-scanning\/analyses\/(\d+)$/i.exec(rest)) && /sarif/i.test(accept)) {
      analyses.push(Number(m[1]));
    }
  } else if ((m = /^(?:archive|tarball|zipball|commit|commits)\/(.+)$/i.exec(rest))) {
    refs.push(strip(m[1]));
  } else if ((m = /^(?:raw|blob|tree|blame)\/(.+)$/i.exec(rest))) paths.push(m[1]);
  // A workflow run's pages, all of them: its artifacts, its jobs' logs, its workflow file (for
  // a fork's pull request, the fork's), its summaries.
  else if ((m = /^actions\/runs\/(\d+)(?:\/|$)/i.exec(rest))) {
    actions.push({ run: Number(m[1]) });
  } else if ((m = /^pull\/(\d+)(?:[./]|$)/i.exec(rest))) pulls.push(Number(m[1]));
  // git LFS's batch API (`<repo>.git/info/lfs/…`): its objects are named by their sha256, which
  // whoever wrote a fork knows, as a blob's id.
  else if (/^info\/lfs(?:\/|$)/i.test(rest)) lfs = true;
  else if ((m = /^compare\/(.+)$/i.exec(rest))) refs.push(...sides(m[1]));
  // Any other page: refused unless it is one of those that show no file (fail closed: GitHub's
  // pages are many, `blob_excerpt/<id>` serves a blob's lines by its id).
  else if (kind === "web" && !WEB_PAGES.test(rest)) page = true;
  return { repo, id, refs, paths, pulls, actions, analyses, blob, lfs, page };
}

// What a repository reached through anything but `repository(owner:, name:)` (a pull request's
// `headRepository`, `node`, `search`, `forks`, `parent`…) may be asked: it may be a fork, and
// can't be checked before GitHub answers. Its metadata only: the RepositoryInfo interface's
// fields, ids, settings and the viewer's. Not, say, its CODE_OF_CONDUCT, CODEOWNERS, templates,
// contributing guidelines, contact or funding links (its files), `object`, `ref`, `refs`,
// `releases`, `submodules` or `dependencyGraphManifests` (its tree): an allowlist, as the
// schema's fields are many and grow (checked against vendor/github.graphql's Repository).
const UNNAMED_REPOSITORY = new Set([
  "__typename",
  // RepositoryInfo.
  ...["archivedAt", "createdAt", "description", "descriptionHTML", "forkCount"],
  ...["hasDiscussionsEnabled", "hasIssuesEnabled", "hasProjectsEnabled"],
  ...["hasPullRequestsEnabled", "hasSponsorshipsEnabled", "hasWikiEnabled", "homepageUrl"],
  ...["isArchived", "isFork", "isInOrganization", "isLocked", "isMirror", "isPrivate"],
  ...["isTemplate", "issueCreationPolicy", "licenseInfo", "lockReason", "mirrorUrl", "name"],
  ...["nameWithOwner", "openGraphImageUrl", "owner", "pullRequestCreationPolicy", "pushedAt"],
  ...["resourcePath", "shortDescriptionHTML", "updatedAt", "url", "usesCustomOpenGraphImage"],
  "visibility",
  // Ids, settings, the viewer's.
  ...["id", "databaseId", "fullDatabaseId", "isEmpty", "isDisabled", "sshUrl", "stargazerCount"],
  ...["primaryLanguage", "repositoryTopics", "defaultBranchRef", "parent", "diskUsage"],
  ...["isUserConfigurationRepository", "isSecurityPolicyEnabled", "securityPolicyUrl"],
  ...["mergeCommitAllowed", "squashMergeAllowed", "rebaseMergeAllowed", "autoMergeAllowed"],
  ...["allowUpdateBranch", "deleteBranchOnMerge", "webCommitSignoffRequired"],
  ...["viewerPermission", "viewerCanAdminister", "viewerCanSubscribe", "viewerHasStarred"],
  ...["viewerSubscription", "viewerDefaultMergeMethod"],
]);
const REPOSITORY_TYPES = new Set(["Repository", "RepositoryInfo"]);

// What operation `op` of `doc` (a parsed GraphQL document validated against `schema`,
// `variables` its coerced variables) reads that may be a fork's → [{ blob } | { repo } |
// { field, ref } | { field, unnamed }]: a fragment on `Blob` (the only type that holds a whole
// file: an expression such as `refs/pull/7/head:a.js` names any); each repository it names with
// `repository(owner:, name:)` (owner/name, variables resolved), all of which it may read if it
// isn't a fork's; `codeowners(refName:)`, CODEOWNERS' lines at any ref; and each field of a
// repository reached otherwise that UNNAMED_REPOSITORY doesn't hold. Fields are followed with
// their types, through fragments, as GraphQL resolves them.
export function graphqlReads(schema, doc, op, variables = {}) {
  const fragments = new Map(
    doc.definitions.filter((d) => d.kind === "FragmentDefinition").map((d) => [d.name.value, d]),
  );
  const value = (node) => (node?.kind === "Variable" ? variables?.[node.name.value] : node?.value);
  const named = (type) => {
    let t = type;
    while (t?.ofType) t = t.ofType;
    return t;
  };
  const reads = [];
  const seen = new Set();
  // `type`: the object's type as selected; `unnamed`: whether it is a repository reached through
  // anything but `repository(owner:, name:)`.
  function walk(set, type, unnamed) {
    for (const selection of set?.selections ?? []) {
      if (selection.kind === "Field") {
        const name = selection.name.value;
        const args = new Map((selection.arguments ?? []).map((a) => [a.name.value, a.value]));
        if (unnamed && REPOSITORY_TYPES.has(type?.name) && !UNNAMED_REPOSITORY.has(name)) {
          reads.push({ field: name, unnamed: true });
        }
        if (name === "codeowners" && args.has("refName")) reads.push({ field: name, ref: true });
        const child = named(type?.getFields?.()[name]?.type);
        const [owner, repoName] = [value(args.get("owner")), value(args.get("name"))];
        const root =
          type === schema.getQueryType() &&
          name === "repository" &&
          typeof owner === "string" &&
          typeof repoName === "string";
        if (root) reads.push({ repo: `${owner}/${repoName}` });
        walk(selection.selectionSet, child, !root);
      } else {
        const def =
          selection.kind === "FragmentSpread" ? fragments.get(selection.name.value) : selection;
        const key = selection.kind === "FragmentSpread" && `${selection.name.value}\0${unnamed}`;
        if (!def || (key && seen.has(key))) continue;
        if (key) seen.add(key);
        const condition = def.typeCondition?.name.value;
        if (condition === "Blob") reads.push({ blob: true });
        walk(def.selectionSet, condition ? schema.getType(condition) : type, unnamed);
      }
    }
  }
  const roots = { query: "getQueryType", mutation: "getMutationType" };
  walk(op.selectionSet, schema[roots[op.operation]]?.call(schema), true);
  return reads;
}

// A Map that keeps `max` entries, each `ms` at most.
function kept(ms, max, now) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ms) return (map.delete(key), undefined);
      return entry.value;
    },
    set(key, value) {
      keepLast(map, key, { value, at: now() }, max);
    },
  };
}

// Whether `run`'s calls are checked: one that isn't a fork's and gets what the repo's later runs
// trust: a work run (`push`, from its mode), or the capabilities (capabilities.mjs) that leave
// something behind: `push`, `setup` (caches) or `docker` (an engine).
const TRUSTED = ["push", "setup", "docker"];
export const restricted = (run) =>
  !!run &&
  run.fork !== true &&
  (run.push === true || (run.caps ?? []).some((c) => TRUSTED.includes(c)));

export function createForkChecks({
  // (repo, path, expected) → GitHub's JSON for a GET, with the App's token for `repo`, or null
  // for a status in `expected` (github.mjs getJson()).
  get,
  // What GitHub advertised to a run's git, shared with the other copies of the github service
  // (../github/runs.mjs): { save(run, repo, entries), load(run, repo) → entries }, each entry
  // [oid, OWN_REF or the pull requests' numbers]. A fetch's pack request may reach another copy
  // than its advertisement did. None: this process's memory only.
  shared = null,
  log = () => {},
  now = Date.now,
}) {
  // run → { since, count }: the lookups it caused in the current minute (ask()).
  const budgets = new WeakMap();

  // A lookup on GitHub for `run`, with the App's token for its repository: RUN_LOOKUPS a minute
  // at most, whatever calls it (a file host's included, which aren't counted in flight), so that
  // no run can spend the installation's rate limit, which the repository's other runs and the
  // listener share. Past it, throws (checked() answers 429).
  function ask(run, path, expected) {
    const budget = budgets.get(run);
    if (!budget || now() - budget.since >= 60_000) budgets.set(run, { since: now(), count: 1 });
    else if (++budget.count > RUN_LOOKUPS) {
      throw Object.assign(new Error("over its lookups"), { budget: true });
    }
    return get(run.repo, path, expected);
  }

  const repos = kept(LOOKUP_MS, MAX_KEPT, now);
  const pulls = kept(LOOKUP_MS, MAX_KEPT, now);
  const commits = kept(LOOKUP_MS, MAX_KEPT, now);
  const refusedCommits = kept(REFUSED_MS, MAX_KEPT, now);
  const named = kept(LOOKUP_MS, MAX_KEPT, now);
  const workflows = kept(LOOKUP_MS, MAX_KEPT, now);
  // run → repository → oid → what GitHub advertised it as, to the run's git: OWN_REF (a ref of
  // the repository's own: a branch, a tag) or the numbers of the pull requests whose refs it is.
  const advertised = new WeakMap();
  const OWN_REF = "own";

  // A repository by name or id, as GitHub has it (cached), or null when it has none.
  async function repoOf(run, { repo, id }) {
    const key = repo ? repo.toLowerCase() : `#${id}`;
    let info = repos.get(key);
    if (info === undefined) {
      info = await ask(run, repo ? `/repos/${repo}` : `/repositories/${id}`, [404, 410]);
      repos.set(key, info);
    }
    return info;
  }

  // Which repository a call's checks apply to: { repo } (owner/name) for the run's own or its
  // network's source, { refused } for a fork in its network, null for any other.
  async function scope(run, target) {
    if (target.repo?.toLowerCase() === run.repo) return { repo: run.repo };
    const info = await repoOf(run, target);
    if (!info?.full_name) return null;
    const name = info.full_name.toLowerCase();
    if (name === run.repo) return { repo: run.repo };
    const own = await repoOf(run, { repo: run.repo });
    if (!own) return null;
    const root = own.source?.id ?? own.id;
    if ((info.source?.id ?? info.id) !== root) return null;
    if (info.id === root) return { repo: name };
    return {
      refused: `${info.full_name} is a fork of ${run.repo}'s network: ${FORK_RUN}`,
    };
  }

  // Why pull request #n of `repo` can't be fetched (its head is a fork's), or null.
  async function pullRefusal(run, repo, n) {
    const key = `${repo}#${n}`;
    let pr = pulls.get(key);
    if (pr === undefined) {
      pr = await ask(run, `/repos/${repo}/pulls/${n}`, [404, 410]);
      pulls.set(key, pr);
    }
    if (!pr) return `${repo} has no pull request #${n} Deckhand could check`;
    if (headInRepo(pr, repo) || headInRepo(pr, run.repo)) return null;
    const head = pr.head?.repo?.full_name ?? "a deleted fork";
    return `pull request #${n} is from a fork (${head}): ${FORK_RUN}`;
  }

  // Why commit `sha` of `repo` can't be fetched (it may be a fork's), or null: an own ref's in
  // what GitHub advertised to the run, on the default branch, a branch's head, or in a pull
  // request from one of its branches.
  async function commitRefusal(run, repo, sha) {
    const as = advertised.get(run)?.get(repo)?.get(sha);
    if (as) return advertisedRefusal(run, repo, as);
    const key = `${repo}@${sha}`;
    if (commits.get(key)) return null;
    const known = refusedCommits.get(key);
    if (known) return known;
    const info = await repoOf(run, { repo });
    const base = info?.default_branch;
    if (base) {
      const compared = await ask(
        run,
        `/repos/${repo}/compare/${sha}...${encodeURIComponent(base)}?per_page=1`,
        [404, 410, 422],
      );
      if (compared?.status === "ahead" || compared?.status === "identical") {
        commits.set(key, true);
        return null;
      }
    }
    const heads = await ask(
      run,
      `/repos/${repo}/commits/${sha}/branches-where-head`,
      [404, 410, 422],
    );
    if (Array.isArray(heads) && heads.length) {
      commits.set(key, true);
      return null;
    }
    // A commit of a pull request from one of its branches (an earlier one, or one whose branch
    // is gone since it was squash-merged): pushed there by someone who may. A fork's commit only
    // lists the fork's pull request.
    const pullsOf = await ask(
      run,
      `/repos/${repo}/commits/${sha}/pulls?per_page=100`,
      [404, 410, 422],
    );
    if (Array.isArray(pullsOf) && pullsOf.some((pr) => headInRepo(pr, repo))) {
      commits.set(key, true);
      return null;
    }
    const why = `${sha.slice(0, 12)} isn't a commit on ${repo}'s default branch, a branch's head nor a pull request from one of its branches, so it may be a fork's (a blob or tree isn't fetched on its own here: the clone is whole); fetch a branch of ${repo} instead, or: ${FORK_RUN}`;
    refusedCommits.set(key, why);
    return why;
  }

  // An advertised commit: fine when a ref of the repository's own named it (a branch, a tag), or
  // a pull request's from one of its branches.
  async function advertisedRefusal(run, repo, as) {
    if (as === OWN_REF) return null;
    let why = null;
    for (const pull of as) {
      why = await pullRefusal(run, repo, pull);
      if (!why) return null;
    }
    return why;
  }

  // Why `spec` (refKind()'s) of `repo` can't be read, or null.
  async function refRefusal(run, repo, spec, path = false) {
    const kind = refKind(spec, { path });
    if (kind.owner !== undefined) {
      const [owner, name] = repo.split("/");
      // The repository's own owner (and name): what follows is checked as any ref of it.
      if (kind.owner.toLowerCase() === owner && (kind.name ?? name).toLowerCase() === name) {
        return refRefusal(run, repo, kind.ref);
      }
      return `${kind.owner}'s ${kind.ref} is another repository's, maybe a fork's: ${FORK_RUN}`;
    }
    if (kind.invalid) {
      return `${JSON.stringify(String(spec).slice(0, 80))} isn't spelled as git names a ref (whitespace, a control character, "//", "..", "@{", a component starting with ".", a leading "-", "/", ":", "^" or "~"): name a branch, a tag or a commit of ${repo}`;
    }
    if (kind.pull !== undefined) return pullRefusal(run, repo, kind.pull);
    if (kind.sha !== undefined) {
      // Abbreviated: a branch or tag of the repository named so is what GitHub reads.
      if (kind.sha.length < 40 && (await namedRef(run, repo, kind))) return null;
      return commitRefusal(run, repo, kind.sha);
    }
    return null;
  }

  // Why what a workflow run of `repo` made (`run`, `job` or `artifact`, by id) can't be
  // downloaded, or null: its head is the repository's own. A fork's pull request runs the
  // fork's workflow, which writes its logs and artifacts as it likes (cached).
  async function workflowRefusal(run, repo, { run: runId, job, artifact }) {
    const key = `${repo}/actions/${runId ?? ""}/${job ?? ""}/${artifact ?? ""}`;
    let head = workflows.get(key);
    if (head === undefined) {
      const path = `/repos/${repo}/actions`;
      let id = runId;
      head = null;
      if (artifact !== undefined) {
        const found = await ask(run, `${path}/artifacts/${artifact}`, [404, 410]);
        head = found?.workflow_run?.head_repository_id ?? null;
        id = found?.workflow_run?.id;
      } else if (job !== undefined) {
        id = (await ask(run, `${path}/jobs/${job}`, [404, 410]))?.run_id;
      }
      if (head === null && id !== undefined) {
        head = (await ask(run, `${path}/runs/${id}`, [404, 410]))?.head_repository?.id ?? null;
      }
      workflows.set(key, head);
    }
    const own = (await repoOf(run, { repo }))?.id;
    if (head !== null && head === own) return null;
    return `this workflow run's head isn't ${repo}'s own (a fork's pull request runs the fork's workflow): what it shows and made (its workflow file, summaries, logs, artifacts) may be the fork's code; ${FORK_RUN}`;
  }

  // Whether one of `names` (refKind()'s) is a branch or a tag of `repo`: those whose names
  // start with its `first` digits, one call for each kind, kept a while either way.
  async function namedRef(run, repo, { first, names }) {
    const key = `${repo}@refs:${first}`;
    let found = named.get(key);
    if (found === undefined) {
      found = [];
      for (const kind of ["heads", "tags"]) {
        const refs = await ask(
          run,
          `/repos/${repo}/git/matching-refs/${kind}/${encodeURIComponent(first)}?per_page=100`,
          [404, 409, 410, 422],
        );
        for (const { ref } of Array.isArray(refs) ? refs : []) {
          found.push(String(ref).replace(/^refs\/(?:heads|tags)\//, ""));
        }
      }
      named.set(key, found);
    }
    return names.some((name) => found.includes(name));
  }

  // Fails closed: what can't be looked up is refused, as a 502.
  async function checked(run, what, fn) {
    try {
      const why = await fn();
      return why && { status: 403, message: why };
    } catch (error) {
      return failed(run, what, error);
    }
  }

  // What a check that couldn't look something up answers: 429 past the run's lookups, else 502.
  function failed(run, what, error) {
    if (error.budget) {
      return {
        status: 429,
        message: `this run's calls needed over ${RUN_LOOKUPS} lookups on GitHub in a minute to check them; wait a minute`,
      };
    }
    log(`GitHub gateway: ${run.repo}: checking ${what}: ${error.message ?? error}`);
    return { status: 502, message: `couldn't check whether ${what} is a fork's; try again` };
  }

  // A REST, web or raw call of a restricted run → null when it may go on, else { status,
  // message }.
  function checkCall(run, { kind, path, query, accept }) {
    const target = callTargets(kind, path, query, accept);
    if (!target) return null;
    return checked(run, target.repo ?? `repository ${target.id}`, async () => {
      const where = await scope(run, target);
      if (!where) return null;
      if (where.refused) return where.refused;
      if (target.blob) {
        return `a blob read by its id may be a fork's (whoever wrote one can name its blobs): read the file with contents/<path>?ref=<branch>, or from the clone; ${FORK_RUN}`;
      }
      if (target.page) {
        return `${where.repo}'s ${path.split("/").slice(2).join("/").slice(0, 80)} is a page Deckhand doesn't check, which may show a fork's code: read the repository through git, the API or its raw files; ${FORK_RUN}`;
      }
      if (target.lfs) {
        return `git LFS's objects are named by their sha256, which may be a fork's (whoever wrote one knows it): read an LFS file by its branch from media.githubusercontent.com/media/<owner>/<repo>/<branch>/<path>; ${FORK_RUN}`;
      }
      for (const n of target.pulls) {
        const why = await pullRefusal(run, where.repo, n);
        if (why) return why;
      }
      for (const spec of target.refs) {
        const why = await refRefusal(run, where.repo, spec);
        if (why) return why;
      }
      for (const spec of target.paths) {
        const why = await refRefusal(run, where.repo, spec, true);
        if (why) return why;
      }
      for (const action of target.actions) {
        const why = await workflowRefusal(run, where.repo, action);
        if (why) return why;
      }
      for (const analysis of target.analyses) {
        const path = `/repos/${where.repo}/code-scanning/analyses/${analysis}`;
        const ref = (await ask(run, path, [404, 410]))?.ref;
        if (typeof ref !== "string") {
          return `code scanning analysis ${analysis} names no ref Deckhand can check`;
        }
        const why = await refRefusal(run, where.repo, ref);
        if (why) return why;
      }
      return null;
    });
  }

  // Whether a restricted run's git call to `repo` (owner/name, from the web host's path) has its
  // fetches checked: { repo }, the repository of its network to check their wants against,
  // { refused } ({ status, message }), or null: another repository's, unchecked.
  async function fetchScope(run, repo) {
    try {
      const where = await scope(run, { repo });
      if (where?.refused) return { refused: { status: 403, message: where.refused } };
      return where;
    } catch (error) {
      return { refused: failed(run, repo, error) };
    }
  }

  // A fetch's request (fetchRequest()) of `repo` → null when it may go on, else { status,
  // message }: each object it wants is the repository's own, and each ref it names too. Those
  // no ref advertised are looked up, MAX_LOOKUPS at most: more is a partial clone's lazy fetch
  // of blobs, refused without asking GitHub.
  function checkFetch(run, repo, { wants, refs }) {
    return checked(run, repo, async () => {
      const missing = () =>
        [...new Set(wants)].filter((oid) => !advertised.get(run)?.get(repo)?.has(oid));
      let unknown = missing();
      // Advertised through another copy, maybe.
      if (unknown.length && shared) {
        merge(run, repo, await shared.load(run, repo));
        unknown = missing();
      }
      if (unknown.length > MAX_LOOKUPS) {
        return `this fetch wants ${unknown.length} objects no ref of ${repo} points at, which may be a fork's (a blob or tree isn't fetched on its own here: the clone is whole); fetch a branch of ${repo} instead, or: ${FORK_RUN}`;
      }
      for (const oid of new Set(wants)) {
        const why = await commitRefusal(run, repo, oid);
        if (why) return why;
      }
      for (const ref of refs) {
        const why = await refRefusal(run, repo, ref);
        if (why) return why;
      }
      return null;
    });
  }

  // What GitHub advertised to the run's git for `repo` (advertisementReader()'s refs), kept for
  // its wants: for each object, whether a ref of the repository's own named it, else the pull
  // requests whose refs did.
  // Resolves once `shared` has it too.
  async function remember(run, repo, refs) {
    const changed = merge(
      run,
      repo,
      refs.map(({ oid, ref }) => {
        const { pull } = refKind(ref);
        return [oid, pull === undefined ? OWN_REF : [pull]];
      }),
    );
    if (shared && changed.length) await shared.save(run, repo, changed);
  }

  // Entries ([oid, OWN_REF or pull request numbers]) into the run's memory of `repo` → those
  // that changed it, as they are now.
  function merge(run, repo, entries) {
    const byRepo = advertised.get(run) ?? new Map();
    advertised.set(run, byRepo);
    const oids = byRepo.get(repo) ?? new Map();
    byRepo.set(repo, oids);
    const changed = [];
    for (const [oid, kind] of entries) {
      const before = oids.get(oid);
      if (before === OWN_REF) continue;
      if (before === undefined && oids.size >= MAX_REFS) oids.delete(oids.keys().next().value);
      const now = kind === OWN_REF ? OWN_REF : [...new Set([...(before ?? []), ...kind])];
      if (now !== OWN_REF && before?.length === now.length) continue;
      oids.set(oid, now);
      changed.push([oid, now]);
    }
    return changed;
  }

  // A restricted run's GraphQL operation (graphqlReads()) → null when it may go on, else
  // { status, message }: no blob, no CODEOWNERS at a ref, no fork's repository it names, and
  // of a repository reached otherwise, its metadata only.
  async function checkGraphql(run, { schema, doc, op, variables }) {
    if (!restricted(run)) return null;
    const read = (what) => ({
      status: 403,
      message: `${what} over GraphQL may read a fork's: read the repository's files from its clone, or ask them of repository(owner:, name:) naming ${run.repo}; ${FORK_RUN}`,
    });
    for (const { blob, repo, field, ref, unnamed } of graphqlReads(schema, doc, op, variables)) {
      if (blob) return read("reading a file's content (Blob)");
      if (ref) return read(`reading ${field} at a ref`);
      if (unnamed) {
        return read(`${field} of a repository not named by repository(owner:, name:)`);
      }
      const refused = await checked(run, repo, async () => (await scope(run, { repo }))?.refused);
      if (refused) return refused;
    }
    return null;
  }

  return { restricted, checkCall, fetchScope, checkFetch, remember, checkGraphql };
}
