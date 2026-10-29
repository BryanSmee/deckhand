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
// - reading a file's content over GraphQL (`... on Blob`): github-graphql.mjs, with blobs().
//
// What GitHub answers for the lookups is kept a while: whether a pull request or repository is
// a fork's doesn't change, and a commit stays on a branch it was found on.
import { gunzipSync } from "node:zlib";
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
const HEX = /^[0-9a-f]{7,64}$/i;
// The parameters GitHub reads a ref or commit from, on any of its calls that takes one (`ref`
// on contents, readme, license, codeowners…; `sha`, `head`, `base`): all of them are checked,
// whatever the path, rather than a list of the calls that would serve a file. A pull request
// list's `head` and `base` only filter it, by branch: not checked there.
const REF_PARAMS = ["ref", "sha", "head", "base"];
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

// What a ref, branch or commit names, as a path or parameter spells it (with what follows it in
// a path, a revision's suffix): { pull } for a pull request's refs (`refs/pull/<n>/head`,
// `pull/<n>/merge`), { sha } for what may be a commit, { owner } for another repository's
// (compare's `owner:branch`), else {}: a branch or tag, the repository's own.
export function refKind(spec) {
  const text = String(spec ?? "").replace(/^\/+/, "");
  const other = /^([^/:]+):/.exec(text);
  if (other) return { owner: other[1] };
  const pull = /^(?:refs\/)?pull\/(\d+)(?:[/~^@.]|$)/i.exec(text);
  if (pull) return { pull: Number(pull[1]) };
  const first = text.split("/")[0].split(/[~^@.]/)[0];
  return HEX.test(first) ? { sha: first.toLowerCase() } : {};
}

// The repository a call names, and what in it may be a fork's: { repo } (owner/name) or { id },
// and { refs, pulls, blob, lfs } (refKind()'s specs, pull request numbers, whether it reads a
// blob by its id, or git LFS's objects); null for a call that names none. `kind`: "api" (REST, its path under the API's
// base), "web" (the web host's path, and patch-diff.githubusercontent.com's) or "raw"
// (raw.githubusercontent.com's, and media.githubusercontent.com's); `query`, its
// URLSearchParams; `accept`, its header. Trees and a commit's metadata (`git/trees`,
// `git/commits`) hold no file's content: not checked.
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
  const pulls = [];
  let blob = false;
  let lfs = false;
  // Any call's ref parameters, every value of each (GitHub may read the last).
  for (const name of REF_PARAMS) {
    if (kind === "api" && /^pulls\/?$/i.test(rest) && name !== "ref" && name !== "sha") continue;
    refs.push(...query.getAll(name));
  }
  const strip = (ref) => ref.replace(/\.(?:tar\.gz|tgz|zip|diff|patch)$/i, "");
  const sides = (spec) =>
    strip(spec)
      .split(/\.{2,3}/)
      .filter(Boolean);
  let m;
  if (kind === "raw") {
    if (rest) refs.push(rest);
  } else if (kind === "api") {
    if ((m = /^(?:tarball|zipball)\/(.+)$/i.exec(rest))) refs.push(m[1]);
    else if (/^git\/blobs(?:\/|$)/i.test(rest)) blob = true;
    else if ((m = /^commits\/(.+)$/i.exec(rest)) && !COMMIT_METADATA.test(rest)) refs.push(m[1]);
    else if ((m = /^compare\/(.+)$/i.exec(rest))) refs.push(...sides(m[1]));
    else if ((m = /^pulls\/(\d+)\/files$/i.exec(rest))) pulls.push(Number(m[1]));
    else if ((m = /^pulls\/(\d+)$/i.exec(rest)) && /diff|patch/i.test(accept)) {
      pulls.push(Number(m[1]));
    }
  } else if (
    (m = /^(?:archive|tarball|zipball|raw|blob|tree|blame|commit|commits)\/(.+)$/i.exec(rest))
  ) {
    refs.push(strip(m[1]));
  } else if ((m = /^pull\/(\d+)(?:[./]|$)/i.exec(rest))) pulls.push(Number(m[1]));
  // git LFS's batch API (`<repo>.git/info/lfs/…`): its objects are named by their sha256, which
  // whoever wrote a fork knows, as a blob's id.
  else if (/^info\/lfs(?:\/|$)/i.test(rest)) lfs = true;
  else if ((m = /^compare\/(.+)$/i.exec(rest))) refs.push(...sides(m[1]));
  return { repo, id, refs, pulls, blob, lfs };
}

// Whether `doc` (a parsed GraphQL document) reads a file's content: a fragment on `Blob`, the
// only type that has it.
export function readsBlobs(doc) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    if (node.typeCondition?.name?.value === "Blob") return true;
    return Object.values(node).some((value) =>
      Array.isArray(value) ? value.some(walk) : walk(value),
    );
  };
  return walk(doc);
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
      if (map.size >= max) map.delete(map.keys().next().value);
      map.set(key, { value, at: now() });
    },
  };
}

export function createForkChecks({
  // (repo, path, expected) → GitHub's JSON for a GET, with the App's token for `repo`, or null
  // for a status in `expected` (github.mjs getJson()).
  get,
  log = () => {},
  now = Date.now,
}) {
  const repos = kept(LOOKUP_MS, MAX_KEPT, now);
  const pulls = kept(LOOKUP_MS, MAX_KEPT, now);
  const commits = kept(LOOKUP_MS, MAX_KEPT, now);
  // run → repository → oid → what GitHub advertised it as, to the run's git: OWN_REF (a ref of
  // the repository's own: a branch, a tag) or the numbers of the pull requests whose refs it is.
  const advertised = new WeakMap();
  const OWN_REF = "own";

  // Whether `run`'s fetches are checked: a work run (it has caches, mounts and maybe an engine,
  // and pushes) that isn't a fork's.
  const restricted = (run) => run?.push === true && run.fork !== true;

  // A repository by name or id, as GitHub has it (cached), or null when it has none.
  async function repoOf(run, { repo, id }) {
    const key = repo ? repo.toLowerCase() : `#${id}`;
    let info = repos.get(key);
    if (info === undefined) {
      info = await get(run.repo, repo ? `/repos/${repo}` : `/repositories/${id}`, [404, 410]);
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
      pr = await get(run.repo, `/repos/${repo}/pulls/${n}`, [404, 410]);
      pulls.set(key, pr);
    }
    if (!pr) return `${repo} has no pull request #${n} Deckhand could check`;
    if (headInRepo(pr, repo) || headInRepo(pr, run.repo)) return null;
    const head = pr.head?.repo?.full_name ?? "a deleted fork";
    return `pull request #${n} is from a fork (${head}): ${FORK_RUN}`;
  }

  // Why commit `sha` of `repo` can't be fetched (it may be a fork's), or null: an own ref's in
  // what GitHub advertised to the run, on the default branch, or a branch's head.
  async function commitRefusal(run, repo, sha) {
    const as = advertised.get(run)?.get(repo)?.get(sha);
    if (as) return advertisedRefusal(run, repo, as);
    const key = `${repo}@${sha}`;
    if (commits.get(key)) return null;
    const info = await repoOf(run, { repo });
    const base = info?.default_branch;
    if (base) {
      const compared = await get(
        run.repo,
        `/repos/${repo}/compare/${sha}...${encodeURIComponent(base)}?per_page=1`,
        [404, 410, 422],
      );
      if (compared?.status === "ahead" || compared?.status === "identical") {
        commits.set(key, true);
        return null;
      }
    }
    const heads = await get(
      run.repo,
      `/repos/${repo}/commits/${sha}/branches-where-head`,
      [404, 410, 422],
    );
    if (Array.isArray(heads) && heads.length) {
      commits.set(key, true);
      return null;
    }
    return `${sha.slice(0, 12)} isn't a commit on ${repo}'s default branch nor a branch's head, so it may be a fork's (a blob or tree isn't fetched on its own here: the clone is whole); fetch a branch of ${repo} instead, or: ${FORK_RUN}`;
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
  async function refRefusal(run, repo, spec) {
    const kind = refKind(spec);
    if (kind.owner !== undefined) {
      if (kind.owner.toLowerCase() === repo.split("/")[0]) return null;
      return `${kind.owner}'s ${spec.slice(kind.owner.length + 1)} is another repository's, maybe a fork's: ${FORK_RUN}`;
    }
    if (kind.pull !== undefined) return pullRefusal(run, repo, kind.pull);
    if (kind.sha !== undefined) return commitRefusal(run, repo, kind.sha);
    return null;
  }

  // Fails closed: what can't be looked up is refused, as a 502.
  async function checked(run, what, fn) {
    try {
      const why = await fn();
      return why && { status: 403, message: why };
    } catch (error) {
      log(`GitHub gateway: ${run.repo}: checking ${what}: ${error.message ?? error}`);
      return { status: 502, message: `couldn't check whether ${what} is a fork's; try again` };
    }
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
      log(`GitHub gateway: ${run.repo}: checking ${repo}: ${error.message ?? error}`);
      return {
        refused: { status: 502, message: `couldn't check whether ${repo} is a fork's; try again` },
      };
    }
  }

  // A fetch's request (fetchRequest()) of `repo` → null when it may go on, else { status,
  // message }: each object it wants is the repository's own, and each ref it names too. Those
  // no ref advertised are looked up, MAX_LOOKUPS at most: more is a partial clone's lazy fetch
  // of blobs, refused without asking GitHub.
  function checkFetch(run, repo, { wants, refs }) {
    return checked(run, repo, async () => {
      const unknown = [...new Set(wants)].filter(
        (oid) => !advertised.get(run)?.get(repo)?.has(oid),
      );
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
  function remember(run, repo, refs) {
    const byRepo = advertised.get(run) ?? new Map();
    advertised.set(run, byRepo);
    const oids = byRepo.get(repo) ?? new Map();
    byRepo.set(repo, oids);
    for (const { oid, ref } of refs) {
      const before = oids.get(oid);
      if (before === OWN_REF) continue;
      if (before === undefined && oids.size >= MAX_REFS) oids.delete(oids.keys().next().value);
      const { pull } = refKind(ref);
      if (pull === undefined) oids.set(oid, OWN_REF);
      else oids.set(oid, [...new Set([...(before ?? []), pull])]);
    }
  }

  return { restricted, checkCall, fetchScope, checkFetch, remember };
}
