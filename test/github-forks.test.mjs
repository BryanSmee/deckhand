// What a work run that isn't a fork's may fetch of GitHub (github-forks.mjs, issue #409): a
// fork's pull request's head, a fork's repository and a commit that isn't its repository's are
// refused, by git, the API, an archive, a page or a raw file; its own branches' never are.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createBroker } from "../listener/broker.mjs";
import { GITHUB_FILES } from "../listener/egress.mjs";
import {
  advertisedRefs,
  advertisementReader,
  callTargets,
  createForkChecks,
  fetchBody,
  fetchRequest,
  MAX_LOOKUPS,
  RUN_LOOKUPS,
  graphqlReads,
  refKind,
} from "../listener/github-forks.mjs";
import { createGithubGateway, FILES, ROUTING_HEADERS } from "../listener/github-gateway.mjs";
import { createGraphqlChecks, githubSchema } from "../listener/github-graphql.mjs";
import { pkt, pktLines } from "../listener/pkt-line.mjs";
import { parse } from "../listener/vendor/graphql.mjs";
import { needsBash, serve, tempDir, tokenBroker } from "./helpers.mjs";

const OWN = "a".repeat(40); // on the default branch
const HEAD = "b".repeat(40); // a branch's head, not on the default one
const FORK = "c".repeat(40); // a fork's pull request's head
const TAG = "d".repeat(40);
const PEELED = "e".repeat(40);
const MERGE = "f".repeat(40); // an own pull request's merge, on no branch
const BELOW = "0b".repeat(20); // an own branch's commit, below its head, in its pull request

// GitHub as the checks' lookups see it: Org/Repo, its fork evil/repo, an unrelated other/lib,
// pull requests #7 (from the fork) and #8 (from a branch of the repository).
const REPOS = {
  "org/repo": { id: 1, full_name: "Org/Repo", default_branch: "main" },
  "evil/repo": { id: 2, full_name: "evil/repo", fork: true, source: { id: 1 } },
  "other/lib": { id: 3, full_name: "other/lib", default_branch: "main" },
};
const PULLS = {
  7: { number: 7, head: { repo: { full_name: "evil/repo" } } },
  8: { number: 8, head: { repo: { full_name: "Org/Repo" } } },
};

function fakeGithub(repos = REPOS) {
  const asked = [];
  const get = async (repo, path, expected) => {
    asked.push(path);
    let m;
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path))) return repos[m[1].toLowerCase()] ?? null;
    if ((m = /^\/repositories\/(\d+)$/.exec(path))) {
      return Object.values(repos).find((r) => r.id === Number(m[1])) ?? null;
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path))) return PULLS[m[1]] ?? null;
    if ((m = /\/compare\/([^.]+)\.\.\./.exec(path))) {
      return { status: m[1] === OWN ? "ahead" : "diverged" };
    }
    // Branches and tags named as a short commit id could be, as matching-refs lists them.
    if ((m = /\/git\/matching-refs\/(heads|tags)\/([^?]+)/.exec(path))) {
      const refs = { heads: ["cafe", "2024/q4"], tags: ["2024.1"] }[m[1]];
      return refs
        .filter((r) => r.startsWith(decodeURIComponent(m[2])))
        .map((r) => ({ ref: `refs/${m[1]}/${r}` }));
    }
    // Workflow runs 10 (from a branch of the repository) and 11 (from the fork), their jobs
    // and artifacts.
    if ((m = /\/actions\/runs\/(\d+)$/.exec(path))) {
      return { id: Number(m[1]), head_repository: { id: m[1] === "10" ? 1 : 2 } };
    }
    if ((m = /\/actions\/jobs\/(\d+)$/.exec(path))) return { run_id: m[1] === "20" ? 10 : 11 };
    if ((m = /\/actions\/artifacts\/(\d+)$/.exec(path))) {
      const own = m[1] === "30";
      return { workflow_run: { id: own ? 10 : 11, head_repository_id: own ? 1 : 2 } };
    }
    // A commit below an own branch's head, in its pull request (#8); a fork's, in #7.
    if ((m = /\/commits\/([^/]+)\/pulls\?/.exec(path))) {
      return m[1] === BELOW ? [PULLS[8]] : m[1] === FORK ? [PULLS[7]] : [];
    }
    // Code scanning analyses: 40 of the default branch, 41 of #7.
    if ((m = /\/code-scanning\/analyses\/(\d+)$/.exec(path))) {
      return { ref: m[1] === "40" ? "refs/heads/main" : "refs/pull/7/merge" };
    }
    if ((m = /\/commits\/([^/]+)\/branches-where-head$/.exec(path))) {
      return m[1] === HEAD ? [{ name: "feature" }] : [];
    }
    if (expected.includes(404)) return null;
    throw new Error(`unexpected ${path}`);
  };
  return { get, asked };
}

const workRun = (repo = "org/repo") => ({ repo, push: true, fork: false });
const advertisement = (refs) =>
  Buffer.concat([...refs.map((r) => pkt(`${r}\n`)), Buffer.from("0000")]);

test("fetchRequest reads what a fetch wants, in protocol v0 and v2", () => {
  const v0 = Buffer.concat([
    pkt(`want ${OWN} multi_ack side-band-64k\n`),
    pkt(`want ${TAG}\n`),
    Buffer.from("0000"),
    pkt(`have ${HEAD}\n`),
    pkt("done\n"),
  ]);
  assert.deepEqual(fetchRequest(v0), { command: null, wants: [OWN, TAG], refs: [] });
  const v2 = Buffer.concat([
    pkt("command=fetch\n"),
    pkt("agent=git/2.50\n"),
    Buffer.from("0001"),
    pkt(`want ${FORK}\n`),
    pkt("want-ref refs/pull/7/head\n"),
    pkt(`have ${OWN}\n`),
    pkt("done\n"),
    Buffer.from("0000"),
  ]);
  assert.deepEqual(fetchRequest(v2), {
    command: "fetch",
    wants: [FORK],
    refs: ["refs/pull/7/head"],
  });
  // git reads an id in any case: so does this, lowercased. A want line it can't read fails.
  const upper = Buffer.concat([pkt("command=fetch\n"), pkt(`want ${FORK.toUpperCase()}\n`)]);
  assert.deepEqual(fetchRequest(upper).wants, [FORK]);
  for (const line of [`want ${FORK.slice(1)}`, `WANT-REF  refs/pull/7/head`, `want-refs x`]) {
    const odd = Buffer.concat([pkt("command=fetch\n"), pkt(`${line}\n`)]);
    assert.throws(() => fetchRequest(odd), /a fetch line Deckhand can't read/, line);
  }
  const ls = Buffer.concat([pkt("command=ls-refs\n"), Buffer.from("0001"), pkt("peel\n")]);
  assert.equal(fetchRequest(ls).command, "ls-refs");
  assert.throws(() => fetchRequest(Buffer.from("not git")), /not a git fetch/);
  // A long negotiation comes compressed.
  assert.deepEqual(fetchBody(gzipSync(v2), "gzip"), v2);
  assert.equal(fetchBody(v2, "identity"), v2);
  assert.throws(() => fetchBody(v2, "br"), /br-encoded/);
});

test("advertisedRefs reads v0's and v2's advertisements, a tag's peeled commit too", () => {
  const v0 = Buffer.concat([
    pkt("# service=git-upload-pack\n"),
    Buffer.from("0000"),
    pkt(`${OWN} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`),
    pkt(`${OWN} refs/heads/main\n`),
    pkt(`${FORK} refs/pull/7/head\n`),
    pkt(`${TAG} refs/tags/v1\n`),
    pkt(`${PEELED} refs/tags/v1^{}\n`),
    Buffer.from("0000"),
  ]);
  assert.deepEqual(advertisedRefs(v0), [
    { oid: OWN, ref: "HEAD" },
    { oid: OWN, ref: "refs/heads/main" },
    { oid: FORK, ref: "refs/pull/7/head" },
    { oid: TAG, ref: "refs/tags/v1" },
    { oid: PEELED, ref: "refs/tags/v1" },
  ]);
  const v2 = advertisement([`${TAG} refs/tags/v1 peeled:${PEELED}`]);
  assert.deepEqual(advertisedRefs(v2), [
    { oid: TAG, ref: "refs/tags/v1" },
    { oid: PEELED, ref: "refs/tags/v1" },
  ]);
  // Read as it streams (pkt-line.mjs, the git gateway's parser too): the same, whatever its
  // chunks, only a cut line held.
  assert.deepEqual(
    pktLines(Buffer.concat([pkt("a\n"), Buffer.from("0000"), pkt("b"), Buffer.from("00")])).map(
      String,
    ),
    ["a\n", "b"],
  );
  const reader = advertisementReader();
  for (let i = 0; i < v0.length; i += 7) reader.push(v0.subarray(i, i + 7));
  assert.deepEqual(reader.refs(), advertisedRefs(v0));
});

test("refKind and callTargets: what a call names that may be a fork's", () => {
  assert.deepEqual(refKind("refs/pull/7/head"), { pull: 7 });
  assert.deepEqual(refKind("pull/12/merge/src/a.js"), { pull: 12 });
  assert.deepEqual(refKind(`${FORK}/package.json`), {
    sha: FORK,
    first: FORK,
    names: [FORK, `${FORK}/package.json`],
  });
  assert.deepEqual(refKind("abc1234~2"), {
    sha: "abc1234",
    first: "abc1234",
    names: ["abc1234~2", "abc1234"],
  });
  // Abbreviated as git allows, from 4 digits: possibly a commit, as spelled.
  assert.deepEqual(refKind("CafE"), { sha: "cafe", first: "CafE", names: ["CafE"] });
  assert.deepEqual(refKind("2024.1/a.js"), {
    sha: "2024",
    first: "2024",
    names: ["2024.1", "2024.1/a.js", "2024"],
  });
  assert.deepEqual(refKind("abc"), {});
  // owner:ref and owner:repo:ref, the ref after it read as any other.
  assert.deepEqual(refKind(`org:${FORK}`), { owner: "org", name: null, ref: FORK });
  assert.deepEqual(refKind("org:repo:main"), { owner: "org", name: "repo", ref: "main" });
  assert.deepEqual(refKind(`:${FORK}`), { invalid: true });
  // Git refuses a component starting with ".", anywhere in a ref, and a revision's leading
  // "^" or "~".
  for (const odd of [
    `.${FORK}`,
    "refs/./pull/7/head",
    "refs/pull/./7/head",
    "refs/.pull/7/head",
    "^refs/pull/7/head",
    "~refs/pull/7/head",
  ]) {
    assert.deepEqual(refKind(odd), { invalid: true }, odd);
  }
  // After a ref, a file's path may name a dotfile.
  assert.deepEqual(refKind("main/.github/workflows/ci.yml", { path: true }), {});
  assert.deepEqual(refKind("feature/x/README.md"), {});
  assert.deepEqual(refKind("refs/heads/main/a"), {});
  assert.deepEqual(refKind("evil:main"), { owner: "evil", name: null, ref: "main" });
  // What git wouldn't take for a ref's name isn't taken for a branch of the repository's own.
  for (const odd of [
    ` ${FORK}`,
    `${FORK}\n`,
    "refs//pull/7/head",
    "/refs/pull/7/head",
    "-main",
    "main@{1}",
    "a..b",
    "ma in/x",
    "main\\x",
  ]) {
    assert.deepEqual(refKind(odd), { invalid: true }, JSON.stringify(odd));
  }
  // A file's path past the ref may hold spaces.
  assert.deepEqual(refKind("main/docs/read me.md"), {});

  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(callTargets("api", "repos/Org/Repo/tarball/refs/pull/7/head"), {
    repo: "Org/Repo",
    id: null,
    refs: ["refs/pull/7/head"],
    paths: [],
    pulls: [],
    actions: [],
    analyses: [],
    blob: false,
    lfs: false,
    page: false,
  });
  assert.deepEqual(callTargets("api", "repos/o/r/contents/a.js", q(`ref=${FORK}`)).refs, [FORK]);
  assert.deepEqual(callTargets("api", "repos/o/r/contents/a.js").refs, []);
  // Every ref it repeats: GitHub may read the last.
  assert.deepEqual(
    callTargets("api", "repos/o/r/contents/a.js", q("ref=main&ref=refs/pull/7/head")).refs,
    ["main", "refs/pull/7/head"],
  );
  // A blob by its id: flagged. A tree's or a commit's metadata hold no file: not checked.
  assert.equal(callTargets("api", `repos/o/r/git/blobs/${FORK}`).blob, true);
  assert.deepEqual(callTargets("api", `repos/o/r/git/trees/${FORK}`).refs, []);
  assert.deepEqual(callTargets("api", `repos/o/r/git/commits/${FORK}`).refs, []);
  assert.deepEqual(callTargets("api", "repos/o/r/license", q("ref=a&sha=b&head=c&base=d")).refs, [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.equal(callTargets("web", "o/r.git/info/lfs/objects/batch").lfs, true);
  assert.deepEqual(callTargets("api", "repos/o/r/compare/main...evil:x").refs, ["main", "evil:x"]);
  assert.deepEqual(callTargets("api", `repos/o/r/commits/${FORK}`).refs, [FORK]);
  assert.deepEqual(callTargets("api", `repos/o/r/commits/${FORK}/check-runs`).refs, []);
  assert.deepEqual(callTargets("api", "repos/o/r/pulls/7/files").pulls, [7]);
  assert.deepEqual(callTargets("api", "repos/o/r/pulls/7", q(""), "application/json").pulls, []);
  assert.deepEqual(
    callTargets("api", "repos/o/r/pulls/7", q(""), "application/vnd.github.v3.diff").pulls,
    [7],
  );
  assert.deepEqual(callTargets("api", "repositories/2/zipball").id, 2);
  assert.equal(callTargets("api", "user"), null);
  assert.deepEqual(callTargets("web", "o/r/archive/refs/pull/7/head.tar.gz").refs, [
    "refs/pull/7/head",
  ]);
  assert.deepEqual(callTargets("web", "o/r/pull/7.diff").pulls, [7]);
  assert.deepEqual(callTargets("web", "o/r.git/info/refs").repo, "o/r");
  // A ref followed by a file's path: read as one.
  assert.deepEqual(callTargets("raw", "o/r/refs/pull/7/head/a.js").paths, [
    "refs/pull/7/head/a.js",
  ]);
  assert.deepEqual(callTargets("web", "o/r/blob/main/a..b.js").paths, ["main/a..b.js"]);
  // A ref parameter whatever its case or brackets.
  assert.deepEqual(callTargets("api", "repos/o/r/contents/a", q("REF=x&ref[]=y&sha[a]=z")).refs, [
    "x",
    "y",
    "z",
  ]);
  // A workflow run's artifacts and logs, over the API and on its pages; its metadata isn't.
  assert.deepEqual(callTargets("api", "repos/o/r/actions/artifacts/5/zip").actions, [
    { artifact: 5 },
  ]);
  assert.deepEqual(callTargets("api", "repos/o/r/actions/runs/6/attempts/2/logs").actions, [
    { run: 6 },
  ]);
  assert.deepEqual(callTargets("api", "repos/o/r/actions/jobs/7/logs").actions, [{ job: 7 }]);
  assert.deepEqual(callTargets("web", "o/r/actions/runs/6/artifacts/5").actions, [{ run: 6 }]);
  assert.deepEqual(callTargets("web", "o/r/actions/runs/6/workflow").actions, [{ run: 6 }]);
  assert.deepEqual(callTargets("web", "o/r/actions/runs/6").actions, [{ run: 6 }]);
  // A code scanning analysis as SARIF.
  assert.deepEqual(
    callTargets("api", "repos/o/r/code-scanning/analyses/4", q(""), "application/sarif+json")
      .analyses,
    [4],
  );
  assert.deepEqual(callTargets("api", "repos/o/r/actions/runs/6").actions, []);
});

test("graphqlReads: a Blob, the repositories named, CODEOWNERS at a ref, an unnamed repository's fields", () => {
  const schema = githubSchema();
  const reads = (query, variables = {}) => {
    const doc = parse(query);
    const op = doc.definitions.find((d) => d.kind === "OperationDefinition");
    return graphqlReads(schema, doc, op, variables);
  };
  assert.deepEqual(
    reads(
      `{ repository(owner:"o",name:"r") { object(expression:"main:a") { ... on Blob { text } } } }`,
    ),
    [{ repo: "o/r" }, { blob: true }],
  );
  assert.deepEqual(
    reads(
      `query { repository(owner:"o",name:"r") { object(expression:"x") { ...F } } } fragment F on Blob { text }`,
    ),
    [{ repo: "o/r" }, { blob: true }],
  );
  // A named repository, a variable resolved: whatever is read of it is that repository's.
  assert.deepEqual(
    reads(
      `query($o: String!) { repository(owner:$o,name:"r") { codeOfConduct { body } codeowners(refName:"x") { errors { source } } } }`,
      { o: "evil" },
    ),
    [{ repo: "evil/r" }, { field: "codeowners", ref: true }],
  );
  // Reached otherwise (a pull request's head, a node, a repository's forks): its metadata only.
  assert.deepEqual(
    reads(
      `{ repository(owner:"o",name:"r") { pullRequest(number:7) { headRepository { id name codeOfConduct { body } } } } }`,
    ),
    [{ repo: "o/r" }, { field: "codeOfConduct", unnamed: true }],
  );
  assert.deepEqual(
    reads(`{ node(id:"x") { ... on Repository { nameWithOwner pullRequestTemplates { body } } } }`),
    [{ field: "pullRequestTemplates", unnamed: true }],
  );
  assert.deepEqual(
    reads(
      `{ repository(owner:"o",name:"r") { forks(first:1) { nodes { ...R } } } } fragment R on Repository { url object(expression:"HEAD") { id } }`,
    ),
    [{ repo: "o/r" }, { field: "object", unnamed: true }],
  );
  // A repository whose name isn't known: unnamed.
  assert.deepEqual(
    reads(
      `query($n: String) { repository(owner:"o",name:$n) { contributingGuidelines { body } } }`,
    ),
    [{ field: "contributingGuidelines", unnamed: true }],
  );
  assert.deepEqual(
    reads(`{ repository(owner:"o",name:"r") { pullRequest(number:7) { title } } }`),
    [{ repo: "o/r" }],
  );
});

test("a work run that isn't a fork's is checked; a fork's run and other runs aren't", () => {
  const { get } = fakeGithub();
  const forks = createForkChecks({ get });
  const broker = createBroker({});
  const work = broker.register("Org/Repo", { push: true, caps: ["pull"] });
  assert.equal(forks.restricted(broker.runOf(work)), true);
  broker.allow(work, ["issue-1-*"]);
  assert.equal(forks.restricted(broker.runOf(work)), true);
  broker.allow(work, [], true);
  assert.equal(forks.restricted(broker.runOf(work)), false);
  const light = broker.register("Org/Repo", { push: false });
  assert.equal(forks.restricted(broker.runOf(light)), false);
  // A light run (a repo's light mode, say) its capabilities give what later runs trust: caches
  // (`setup`) or an engine (`docker`). Checked, unless a fork's.
  for (const caps of [
    ["pull", "setup"],
    ["pull", "docker"],
    ["pull", "push"],
  ]) {
    const run = broker.register("Org/Repo", { push: false });
    broker.grant(run, caps);
    assert.equal(forks.restricted(broker.runOf(run)), true, caps.join());
    broker.allow(run, [], true);
    assert.equal(forks.restricted(broker.runOf(run)), false, caps.join());
  }
  const reads = broker.register("Org/Repo", { push: false });
  broker.grant(reads, ["pull", "image:repo", "read:issues"]);
  assert.equal(forks.restricted(broker.runOf(reads)), false);
});

test("a fork's pull request, its repository and its commits are refused; the repository's own aren't", async () => {
  const { get } = fakeGithub();
  const forks = createForkChecks({ get });
  const run = workRun();
  const check = (kind, path, query = "", accept = "") =>
    forks.checkCall(run, { kind, path, query: new URLSearchParams(query), accept });

  // A fork's pull request's head: an archive, its page's diff, its raw files, its patches.
  for (const [kind, path, query, accept] of [
    ["api", "repos/org/repo/tarball/refs/pull/7/head"],
    ["api", "repos/org/repo/zipball/pull/7/merge"],
    ["api", "repos/org/repo/contents/package.json", "ref=refs/pull/7/head"],
    ["api", "repos/org/repo/contents/package.json", "ref=main&ref=refs/pull/7/head"],
    // Any call's ref parameters, whatever its path: the license serves the file it names.
    ["api", "repos/org/repo/license", "ref=refs/pull/7/head"],
    ["api", "repos/org/repo/codeowners/errors", "ref=pull/7/head"],
    ["api", "repos/org/repo/commits", "sha=refs/pull/7/head"],
    ["web", "org/repo/blob/main/a.js", "ref=refs/pull/7/head"],
    ["raw", "org/repo/main/a.js", "ref=refs/pull/7/head"],
    // In brackets, as Rails reads `ref[]` as `ref`.
    ["api", "repos/org/repo/contents/a.js", "ref[]=refs/pull/7/head"],
    ["api", "repos/org/repo/pulls/7/files"],
    ["api", "repos/org/repo/pulls/7", "", "application/vnd.github.diff"],
    ["web", "Org/Repo/archive/refs/pull/7/head.zip"],
    ["web", "org/repo/pull/7.patch"],
    ["raw", "org/repo/refs/pull/7/head/package.json"],
  ]) {
    const refused = await check(kind, path, query, accept);
    assert.equal(refused?.status, 403, path);
    assert.match(refused.message, /pull request #7 is from a fork \(evil\/repo\)/, path);
    assert.match(refused.message, /only comes in a fork's run/, path);
  }
  // The fork's repository itself, by name or id, whatever is read of it.
  for (const [kind, path] of [
    ["api", "repos/evil/repo/tarball/main"],
    ["api", "repos/Evil/Repo/issues"],
    ["api", "repositories/2/contents/a.js"],
    ["web", "evil/repo/archive/main.tar.gz"],
    ["raw", "evil/repo/main/package.json"],
  ]) {
    const refused = await check(kind, path);
    assert.match(refused?.message ?? "", /evil\/repo is a fork of org\/repo's network/, path);
  }
  // A commit that isn't the repository's (a fork's, through the network), or another owner's ref.
  for (const [kind, path, query] of [
    ["api", `repos/org/repo/tarball/${FORK}`],
    ["api", `repos/org/repo/commits/${FORK}`],
    ["api", "repos/org/repo/contents/a.js", `ref=${FORK.slice(0, 7)}`],
    ["raw", `org/repo/${FORK}/a.js`],
    ["web", `org/repo/commit/${FORK}.patch`],
  ]) {
    const refused = await check(kind, path, query);
    assert.match(
      refused?.message ?? "",
      /isn't a commit on org\/repo's default branch, a branch's head nor a pull request/,
      path,
    );
  }
  assert.match(
    (await check("api", "repos/org/repo/compare/main...evil:main")).message,
    /another repository's/,
  );
  // More dots than a comparison has: no sides to read, refused whole.
  assert.match(
    (await check("api", `repos/org/repo/compare/main....${FORK}`)).message,
    /isn't spelled as git names a ref/,
  );
  // Named with the repository's own owner: what follows is checked all the same.
  for (const [kind, path] of [
    ["api", `repos/org/repo/compare/main...org:${FORK}`],
    ["api", `repos/org/repo/compare/main...org:repo:${FORK}`],
    ["web", `org/repo/compare/main...org:${FORK}`],
  ]) {
    assert.match((await check(kind, path)).message, /isn't a commit on org\/repo's default/, path);
  }
  assert.match(
    (await check("api", "repos/org/repo/compare/main...org:refs/pull/7/head")).message,
    /pull request #7 is from a fork/,
  );
  assert.match(
    (await check("api", "repos/org/repo/compare/main...org:other:main")).message,
    /another repository's/,
  );
  // A short id, from 4 digits: a fork's commit unless the repository has a branch named so.
  assert.match(
    (await check("api", `repos/org/repo/tarball/${FORK.slice(0, 5)}`)).message,
    /isn't a commit on org\/repo's default/,
  );
  assert.equal(await check("api", "repos/org/repo/tarball/cafe"), null);
  assert.equal(await check("raw", "org/repo/2024.1/README.md"), null);
  // A branch whose name starts like one: its whole name, a parameter's or a path's prefix.
  assert.equal(await check("api", "repos/org/repo/contents/a.js", "ref=2024/q4"), null);
  assert.equal(await check("raw", "org/repo/2024/q4/README.md"), null);
  assert.match(
    (await check("api", "repos/org/repo/contents/a.js", "ref=2024/q5")).message,
    /isn't a commit on org\/repo's default/,
  );
  // A ref spelled as git wouldn't name one: refused, not taken for a branch.
  for (const ref of [
    ` ${FORK}`,
    "refs//pull/7/head",
    "main\n",
    "main..x",
    `.${FORK}`,
    "refs/./pull/7/head",
    "refs/pull/./7/head",
    "^refs/pull/7/head",
    "org:refs/./pull/7/head",
  ]) {
    const query = new URLSearchParams({ ref }).toString();
    assert.match(
      (await check("api", "repos/org/repo/contents/a.js", query)).message,
      /isn't spelled as git names a ref/,
      JSON.stringify(ref),
    );
  }
  // What a fork's pull request's workflow made: its artifacts and logs.
  for (const [kind, path] of [
    ["api", "repos/org/repo/actions/artifacts/31/zip"],
    ["api", "repos/org/repo/actions/runs/11/logs"],
    ["api", "repos/org/repo/actions/jobs/21/logs"],
    ["web", "org/repo/actions/runs/11/artifacts/31"],
    // Its pages: its workflow file (the fork's own), its attempts and summaries.
    ["web", "org/repo/actions/runs/11/workflow"],
    ["web", "org/repo/actions/runs/11/attempts/1"],
    ["web", "org/repo/actions/runs/11"],
  ]) {
    assert.match(
      (await check(kind, path)).message,
      /this workflow run's head isn't org\/repo's own/,
      path,
    );
  }
  // A page that isn't one of those that show no file: refused, fail closed. blob_excerpt serves
  // a blob's lines by its id.
  for (const path of [
    `org/repo/blob_excerpt/${FORK}`,
    "org/repo/some-new-page/x",
    "org/repo/security/code-scanning/1",
    "org/repo/network",
  ]) {
    assert.match((await check("web", path)).message, /is a page Deckhand doesn't check/, path);
  }
  // git LFS's batch API: its objects named by their sha256.
  for (const path of ["org/repo.git/info/lfs/objects/batch", "org/repo/info/lfs/locks"]) {
    assert.match((await check("web", path)).message, /git LFS's objects are named by their sha256/);
  }
  // A pull request's code scanning analysis as SARIF, which may quote its code.
  assert.match(
    (await check("api", "repos/org/repo/code-scanning/analyses/41", "", "application/sarif+json"))
      .message,
    /pull request #7 is from a fork/,
  );
  // A blob by its id, even the repository's own: nothing says where one comes from.
  for (const sha of [OWN, FORK]) {
    assert.match(
      (await check("api", `repos/org/repo/git/blobs/${sha}`)).message,
      /a blob read by its id may be a fork's/,
    );
  }

  // The repository's own: its branches, tags, commits, a pull request from one of its branches.
  for (const [kind, path, query, accept] of [
    ["api", "repos/org/repo/tarball/main"],
    ["api", "repos/org/repo/tarball"],
    ["api", "repos/org/repo/tarball/refs/pull/8/head"],
    ["api", "repos/org/repo/pulls/8/files"],
    ["api", "repos/org/repo/pulls/7", "", "application/json"],
    ["api", "repos/org/repo/contents/a.js", `ref=${OWN}`],
    ["api", `repos/org/repo/commits/${HEAD}`],
    ["api", "repos/org/repo/compare/main...feature"],
    ["api", "repos/org/repo/compare/main...org:feature"],
    ["api", `repos/org/repo/commits/${FORK}/check-runs`],
    // A tree lists names and ids, no file: the usual way to walk the repository.
    ["api", `repos/org/repo/git/trees/${"7".repeat(40)}`, "recursive=1"],
    ["api", "repos/org/repo/issues/7"],
    ["api", "repos/org/repo/license", "ref=main"],
    ["api", "repos/org/repo/commits", `sha=${OWN}`],
    // A pull request list's head and base only filter it.
    ["api", "repos/org/repo/pulls", "head=evil:main&base=main"],
    ["web", "org/repo/archive/refs/pull/8/head.zip"],
    ["raw", "org/repo/feature/x/README.md"],
    ["raw", "org/repo/refs/heads/main/README.md"],
    // Another repository, not in the network: not this check's business.
    ["api", "repos/other/lib/tarball/main"],
    ["raw", "other/lib/main/install.sh"],
    ["web", "login/oauth"],
    // Pages that show no file.
    ["web", "org/repo"],
    ["web", "org/repo/issues/7"],
    ["web", "org/repo/releases/download/v1/tool.tgz"],
    ["web", "org/repo/actions/runs/10/workflow"],
    ["web", "org/repo/actions"],
    ["web", "org/repo/actions/workflows/ci.yml"],
    // A commit below an own branch's head, in its pull request: the repository's.
    ["api", `repos/org/repo/commits/${BELOW}`],
    ["raw", `org/repo/${BELOW}/a.js`],
    // The default branch's code scanning analysis as SARIF.
    ["api", "repos/org/repo/code-scanning/analyses/40", "", "application/sarif+json"],
    // A file whose own name holds "..", after the ref.
    ["raw", "org/repo/main/a..b.js"],
    ["web", "org/repo/blob/main/docs/a..b.md"],
    // The repository's own workflow runs' artifacts and logs; a fork's run's metadata.
    ["api", "repos/org/repo/actions/artifacts/30/zip"],
    ["api", "repos/org/repo/actions/runs/10/logs"],
    ["api", "repos/org/repo/actions/jobs/20/logs"],
    ["api", "repos/org/repo/actions/runs/11"],
    ["web", "org/repo/actions/runs/10/artifacts/30"],
    ["api", "user"],
  ]) {
    assert.equal(await check(kind, path, query, accept), null, path);
  }
});

test("when the run's repository is a fork, its source is checked as its own, its siblings refused", async () => {
  const repos = {
    "me/repo": {
      id: 5,
      full_name: "me/repo",
      fork: true,
      source: { id: 1 },
      default_branch: "main",
    },
    "org/repo": { id: 1, full_name: "Org/Repo", default_branch: "main" },
    "evil/repo": REPOS["evil/repo"],
  };
  const forks = createForkChecks({ get: fakeGithub(repos).get });
  const run = workRun("me/repo");
  const check = (path) => forks.checkCall(run, { kind: "api", path, query: new URLSearchParams() });
  assert.equal(await check("repos/org/repo/tarball/main"), null);
  assert.match(
    (await check("repos/org/repo/tarball/refs/pull/7/head")).message,
    /#7 is from a fork/,
  );
  assert.match(
    (await check("repos/evil/repo/tarball/main")).message,
    /is a fork of me\/repo's network/,
  );
});

test("what can't be looked up is refused, as a 502", async () => {
  const forks = createForkChecks({
    get: async () => {
      throw new Error("GitHub is down");
    },
    log: () => {},
  });
  const refused = await forks.checkCall(workRun(), {
    kind: "api",
    path: "repos/org/repo/tarball/refs/pull/7/head",
    query: new URLSearchParams(),
  });
  assert.equal(refused.status, 502);
  assert.match(refused.message, /couldn't check/);
  assert.equal((await forks.fetchScope(workRun(), "evil/repo")).refused.status, 502);
});

test("a fetch's wants: an own ref's advertised commit goes, a fork's pull request's doesn't", async () => {
  const { get, asked } = fakeGithub();
  const forks = createForkChecks({ get });
  const run = workRun();
  forks.remember(
    run,
    "org/repo",
    advertisedRefs(
      advertisement([
        `${OWN} refs/heads/main`,
        `${FORK} refs/pull/7/head`,
        `${MERGE} refs/pull/8/merge`,
        `${TAG} refs/tags/v1 peeled:${PEELED}`,
      ]),
    ),
  );
  const fetch = (wants, refs = []) => forks.checkFetch(run, "org/repo", { wants, refs });
  assert.equal(await fetch([OWN, TAG, PEELED, MERGE]), null);
  assert.deepEqual(asked, ["/repos/org/repo/pulls/8"]);
  assert.match((await fetch([OWN, FORK])).message, /pull request #7 is from a fork/);
  assert.match((await fetch([], ["refs/pull/7/head"])).message, /pull request #7 is from a fork/);
  assert.match((await fetch([], ["refs/./pull/7/head"])).message, /isn't spelled as git names/);
  // Not advertised: the repository's when its default branch has it, or a branch's head.
  assert.equal(await fetch([HEAD]), null);
  assert.match((await fetch(["9".repeat(40)])).message, /isn't a commit on org\/repo's default/);
  // A blobless clone's lazy fetch: a blob, which no ref names and GitHub can't place.
  assert.match(
    (await fetch(["b10b".repeat(10)])).message,
    /a blob or tree isn't fetched on its own/,
  );
  // Many of them (a checkout's): refused without asking GitHub at all.
  const many = Array.from({ length: MAX_LOOKUPS + 1 }, (_, i) => i.toString(16).padStart(40, "0"));
  const asking = asked.length;
  assert.match((await fetch([OWN, ...many])).message, /wants 21 objects no ref of org\/repo/);
  assert.equal(asked.length, asking);
  // Another run's memory isn't this one's.
  assert.match(
    (await forks.checkFetch(workRun(), "org/repo", { wants: [FORK], refs: [] })).message,
    /isn't a commit on org\/repo's default branch/,
  );
  // A fork's repository, fetched by its own URL; another repository's isn't checked.
  assert.match((await forks.fetchScope(run, "evil/repo")).refused.message, /is a fork/);
  assert.deepEqual(await forks.fetchScope(run, "Org/Repo"), { repo: "org/repo" });
  assert.equal(await forks.fetchScope(run, "other/lib"), null);
});

test("over GraphQL, a work run that isn't a fork's reads nothing of a fork's", async () => {
  const forks = createForkChecks({ get: fakeGithub().get });
  const checks = createGraphqlChecks({
    nodes: async () => [],
    checkWrite: async () => null,
    files: forks.checkGraphql,
  });
  const check = (run, query, variables) =>
    checks.check(run, Buffer.from(JSON.stringify({ query, variables })));
  const fork = { ...workRun(), fork: true };
  for (const [query, why, variables] of [
    [
      `{ repository(owner:"org",name:"repo") { object(expression:"refs/pull/7/head:a.js") { ... on Blob { text } } } }`,
      /a file's content \(Blob\)/,
    ],
    [
      `{ repository(owner:"org",name:"repo") { codeowners(refName:"refs/pull/7/head") { errors { source } } } }`,
      /codeowners at a ref/,
    ],
    // A fork's repository, named, whatever is read of it: its files are its author's.
    [
      `{ repository(owner:"evil",name:"repo") { contributingGuidelines { body } } }`,
      /evil\/repo is a fork of org\/repo's network/,
    ],
    [`{ repository(owner:"evil",name:"repo") { codeOfConduct { body } } }`, /evil\/repo is a fork/],
    [`{ repository(owner:"evil",name:"repo") { name } }`, /evil\/repo is a fork/],
    [
      `query($n: String!) { repository(owner:"evil",name:$n) { issueTemplates { body } } }`,
      /evil\/repo is a fork/,
      { n: "repo" },
    ],
    [
      `{ repository(owner:"org",name:"repo") { pullRequest(number:7) { headRepository { pullRequestTemplates { body } } } } }`,
      /pullRequestTemplates of a repository not named by repository\(owner:, name:\)/,
    ],
    [
      `{ repository(owner:"org",name:"repo") { pullRequest(number:7) { headRepository { codeOfConduct { body } } } } }`,
      /codeOfConduct of a repository not named/,
    ],
    [
      `{ node(id:"R_x") { ... on Repository { codeowners { errors { source } } } } }`,
      /codeowners of a repository not named/,
    ],
  ]) {
    const refused = await check(workRun(), query, variables);
    assert.equal(refused.refused?.status, 403, query);
    assert.match(refused.refused.message, why, query);
    assert.equal((await check(fork, query, variables)).refused, undefined, query);
  }
  // Its own repository's templates (gh pr create, gh issue create), another repository's, a
  // pull request's head repository's metadata (gh pr view, gh pr checkout).
  for (const query of [
    `query($o: String!, $n: String!) { repository(owner:$o,name:$n) { pullRequestTemplates { filename body } } }`,
    `{ repository(owner:"other",name:"lib") { contributingGuidelines { body } codeowners { errors { source } } } }`,
    `{ repository(owner:"org",name:"repo") { pullRequest(number:7) { headRepository { id name nameWithOwner url isFork owner { login } } } } }`,
  ]) {
    assert.equal(
      (await check(workRun(), query, { o: "Org", n: "Repo" })).refused,
      undefined,
      query,
    );
  }
});

// The gateway in front of a fake GitHub that serves git's advertisements, and raw files.
async function gateway(t, { maxInFlight } = {}) {
  const calls = [];
  const upstream = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.includes("git-upload-pack") && body.includes("command=ls-refs")) {
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
        return res.end(advertisement([`${OWN} refs/heads/main`, `${FORK} refs/pull/7/head`]));
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("PACK");
    });
  };
  const github = await serve(t, upstream);
  const files = await serve(t, upstream);
  const at = `http://localhost:${files.port}`;
  const broker = tokenBroker();
  const forks = createForkChecks({ get: fakeGithub().get });
  const gw = createGithubGateway({
    broker,
    app: () => ({ repoToken: async () => ({ token: "repo-token-0123456789abcdef" }) }),
    api: `${github.url}/api/v3`,
    web: github.url,
    // GitHub's file hosts (FILES), on the same fake.
    files: [
      { host: "localhost", url: at, kind: "raw", prefix: "" },
      { host: "media.test", url: at, kind: "raw", prefix: "media/" },
      { host: "patch-diff.test", url: at, kind: "web", prefix: "raw/" },
    ],
    // GitHub's other content hosts, on the same fake.
    content: (host) => (host.endsWith(".content.test") ? new URL(`${at}/`) : null),
    forks,
    maxInFlight,
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  // A run, its log's notes beside it. `secret`: its run token.
  const register = (fork) => {
    const id = broker.register("Org/Repo", { push: true, caps: ["pull"] });
    const notes = [];
    broker.provide(id, "anthropic", (line) => notes.push(line));
    broker.allow(id, ["issue-1-*"], fork);
    return { secret: broker.token(id), notes };
  };
  const call = (host, path, secret, { method = "GET", body, headers = {} } = {}) =>
    fetch(`${url}/relay/${host}${path}`, {
      method,
      body,
      headers: { authorization: `token ${secret}`, ...headers },
    });
  // A GET with headers fetch() won't send (`Host`), through node:http.
  const raw = (host, path, headers) =>
    new Promise((resolve, reject) => {
      const req = request(`${url}/relay/${host}${path}`, { headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
  return { calls, register, call, raw };
}

const fetchOf = (want) =>
  Buffer.concat([
    pkt("command=fetch\n"),
    Buffer.from("0001"),
    pkt(`want ${want}\n`),
    pkt("done\n"),
    Buffer.from("0000"),
  ]);
const LS_REFS = Buffer.concat([pkt("command=ls-refs\n"), Buffer.from("0001"), Buffer.from("0000")]);

test("through the gateway: a fork's pull request's head is refused to a work run, with why", async (t) => {
  const gw = await gateway(t);
  const { secret, notes } = gw.register(false);
  const pack = "/org/repo.git/git-upload-pack";
  // ls-refs goes on, and what it advertised is remembered.
  const ls = await gw.call("127.0.0.1", pack, secret, { method: "POST", body: LS_REFS });
  assert.equal(ls.status, 200);
  assert.equal(gw.calls.at(-1).headers["accept-encoding"], "identity");
  // An own branch's head goes on, compressed or not.
  const own = await gw.call("127.0.0.1", pack, secret, {
    method: "POST",
    body: gzipSync(fetchOf(OWN)),
    headers: { "content-encoding": "gzip" },
  });
  assert.equal(await own.text(), "PACK");
  assert.deepEqual(gw.calls.at(-1).body, fetchOf(OWN));
  assert.equal(gw.calls.at(-1).headers["content-encoding"], undefined);
  // refs/pull/7/head, a fork's: git's "remote error", GitHub never asked.
  const before = gw.calls.length;
  const fork = await gw.call("127.0.0.1", pack, secret, { method: "POST", body: fetchOf(FORK) });
  assert.equal(fork.status, 200);
  const answer = Buffer.from(await fork.arrayBuffer()).toString();
  assert.match(answer, /^[0-9a-f]{4}ERR Deckhand: pull request #7 is from a fork \(evil\/repo\)/);
  assert.equal(gw.calls.length, before);
  assert.match(
    notes.join("\n"),
    /refused the run's GitHub call POST .*git-upload-pack: pull request #7/,
  );
  // The fork's own repository: refused from git's first request, as text git shows.
  const refs = await gw.call(
    "127.0.0.1",
    "/evil/repo.git/info/refs?service=git-upload-pack",
    secret,
  );
  assert.equal(refs.status, 403);
  assert.match(await refs.text(), /^Deckhand: evil\/repo is a fork of org\/repo's network/);
  // An archive of the fork's head, over the API.
  const archive = await gw.call(
    "127.0.0.1",
    "/api/v3/repos/org/repo/tarball/refs/pull/7/head",
    secret,
  );
  assert.equal(archive.status, 403);
  assert.match((await archive.json()).message, /^Deckhand: pull request #7 is from a fork/);
  assert.equal(gw.calls.length, before);
});

test("through the gateway: a fork's run fetches its pull request as before", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register(true);
  const res = await gw.call("127.0.0.1", "/org/repo.git/git-upload-pack", secret, {
    method: "POST",
    body: fetchOf(FORK),
  });
  assert.equal(await res.text(), "PACK");
  const archive = await gw.call(
    "127.0.0.1",
    "/api/v3/repos/org/repo/tarball/refs/pull/7/head",
    secret,
  );
  assert.equal(archive.status, 200);
});

test("raw files are relayed without a token, a fork's refused to a work run", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register(false);
  const own = await gw.call("localhost", "/org/repo/main/README.md", secret);
  assert.equal(own.status, 200);
  const sent = gw.calls.at(-1);
  assert.equal(sent.url, "/org/repo/main/README.md");
  assert.equal(sent.headers.authorization, undefined);
  const fork = await gw.call("localhost", "/org/repo/refs/pull/7/head/package.json", secret);
  assert.equal(fork.status, 403);
  assert.match(await fork.text(), /^Deckhand: pull request #7 is from a fork/);
  // Only read.
  const put = await gw.call("localhost", "/org/repo/main/README.md", secret, {
    method: "PUT",
    body: "x",
  });
  assert.equal(put.status, 405);
});

test("a fork's pull request's diff and LFS files are refused on GitHub's other file hosts too", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register(false);
  // patch-diff.githubusercontent.com, where github.com/<repo>/pull/<n>.diff redirects.
  const diff = await gw.call("patch-diff.test", "/raw/org/repo/pull/7.diff", secret);
  assert.equal(diff.status, 403);
  assert.match(await diff.text(), /^Deckhand: pull request #7 is from a fork/);
  const own = await gw.call("patch-diff.test", "/raw/org/repo/pull/8.diff", secret);
  assert.equal(own.status, 200);
  assert.equal(gw.calls.at(-1).url, "/raw/org/repo/pull/8.diff");
  assert.equal(gw.calls.at(-1).headers.authorization, undefined);
  // media.githubusercontent.com, LFS files by ref.
  const lfs = await gw.call("media.test", "/media/org/repo/refs/pull/7/head/model.bin", secret);
  assert.equal(lfs.status, 403);
  // git LFS's batch API, on the web host: refused before GitHub hears of it.
  const before = gw.calls.length;
  const lfs2 = await gw.call("127.0.0.1", "/org/repo.git/info/lfs/objects/batch", secret, {
    method: "POST",
    body: JSON.stringify({ operation: "download", objects: [{ oid: "e".repeat(64), size: 1 }] }),
  });
  assert.equal(lfs2.status, 403);
  assert.match(await lfs2.text(), /git LFS's objects are named by their sha256/);
  assert.equal(gw.calls.length, before);
  // A path the checks don't read: refused, not let through.
  const odd = await gw.call("patch-diff.test", "/elsewhere/org/repo/pull/7.diff", secret);
  assert.equal(odd.status, 403);
  assert.match(await odd.text(), /Deckhand doesn't read/);
});

test("the gateway's file hosts are the ones the egress proxy relays", () => {
  assert.deepEqual(
    FILES.map((f) => f.host),
    GITHUB_FILES,
  );
});

// Real git, through the gateway, against GitHub's git as `git http-backend` serves it: a work
// run's whole clone and own pull request go, a fork's pull request doesn't, by its ref or its
// commit, and a blobless clone's checkout (its blobs wanted one by one) doesn't either: hence
// SANDBOX_FULL_CLONE. A fork's run fetches its pull request as before.
test(
  "real git through the gateway: a whole clone goes, a fork's head and lone blobs don't",
  { skip: needsBash },
  async (t) => {
    const dir = tempDir(t, "forks-git-");
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      // No `git gc --auto` or `git maintenance` left running after a fetch: detached, it would
      // still write in the clones while the test's dir is removed, which then fails (#521).
      // Protocol v2 whatever git's default: a fetch is several pack requests there (ls-refs, then
      // a fetch per negotiation round), counted as one fetch all the same.
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "gc.auto",
      GIT_CONFIG_VALUE_0: "0",
      GIT_CONFIG_KEY_1: "maintenance.auto",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "protocol.version",
      GIT_CONFIG_VALUE_2: "2",
      ...Object.fromEntries(
        ["AUTHOR", "COMMITTER"].flatMap((w) => [
          [`GIT_${w}_NAME`, "a"],
          [`GIT_${w}_EMAIL`, "a@example"],
        ]),
      ),
    };
    // Async: the servers answering git run on this thread.
    const sh = (command) =>
      new Promise((resolve) => {
        const child = spawn("bash", ["-c", command], { cwd: dir, env });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out: out.trim() }));
      });
    const repo = join(dir, "root", "org", "repo.git");
    const made = await sh(
      `git init -q -b main src && cd src && for v in 1 2 3; do echo $v > f && git add f &&
    git commit -qm $v; done && git checkout -q -b fork && echo evil > evil.sh && git add . &&
    git commit -qm fork && git checkout -q main && git clone -q --bare . ${repo} &&
    cd ${repo} && git update-ref refs/pull/7/head fork && git update-ref refs/pull/8/head main &&
    git branch -q -D fork && git config uploadpack.allowFilter true &&
    git config uploadpack.allowAnySHA1InWant true && git rev-parse refs/pull/7/head`,
    );
    assert.equal(made.code, 0, made.out);
    const forkSha = made.out.split("\n").at(-1);
    const github = await serve(t, (req, res) => {
      const url = new URL(req.url, "http://github");
      const cgi = spawn("git", ["http-backend"], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: join(dir, "root"),
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
          HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        },
      });
      req.pipe(cgi.stdin);
      let head = Buffer.alloc(0);
      let started = false;
      cgi.stdout.on("data", (chunk) => {
        if (started) return res.write(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers = {};
        let status = 200;
        for (const line of head.subarray(0, end).toString().split("\r\n")) {
          const [name, value] = [
            line.slice(0, line.indexOf(":")),
            line.slice(line.indexOf(":") + 2),
          ];
          if (name.toLowerCase() === "status") status = parseInt(value);
          else headers[name] = value;
        }
        started = true;
        res.writeHead(status, headers);
        res.write(head.subarray(end + 4));
      });
      cgi.stdout.on("end", () => res.end());
    });
    // GitHub's API as the checks ask it: #7 a fork's, #8 a branch's; compare from the clone.
    const get = async (_, path) => {
      let m;
      if (path === "/repos/org/repo")
        return { id: 1, full_name: "org/repo", default_branch: "main" };
      if ((m = /pulls\/(\d+)$/.exec(path))) return PULLS[m[1]] ?? null;
      if ((m = /compare\/([0-9a-f]+)\.\.\./.exec(path))) {
        const on = await sh(`git -C ${repo} merge-base --is-ancestor ${m[1]} main`);
        return on.code === 0 ? { status: "ahead" } : null;
      }
      return /branches-where-head/.test(path) ? [] : null;
    };
    const broker = createBroker({});
    let current = null;
    // The git operations counted (the github service's metrics), and the pack requests sent.
    const ops = [];
    let packs = 0;
    const gw = createGithubGateway({
      onGit: (op, result) => ops.push(`${op} ${result}`),
      broker,
      app: () => ({ repoToken: async () => ({ token: "repo-token-0123456789abcdef" }) }),
      api: `${github.url}/api/v3`,
      web: github.url,
      forks: createForkChecks({ get }),
      // git's calls carry no token: the run whose sandbox sent them.
      runFrom: async () => current,
    });
    const { url } = await serve(t, (req, res) => {
      if (req.url.endsWith("/git-upload-pack")) packs++;
      return gw.handle(req, res);
    });
    const via = `${url}/relay/127.0.0.1/org/repo.git`;
    const as = (fork) => {
      const secret = broker.register("org/repo", { push: true, caps: ["pull"] });
      broker.allow(secret, [], fork);
      current = broker.runOf(secret);
    };

    as(false);
    assert.equal(
      (await sh(`git clone -q ${via} whole && git -C whole log --oneline | wc -l`)).out,
      "3",
    );
    assert.equal((await sh("git -C whole fetch -q origin refs/pull/8/head")).code, 0);
    // The clone, once whatever number of pack requests it took; a fetch of what the clone has
    // already, an up-to-date fetch and an ls-remote bring no pack: not counted.
    assert.ok(packs > 2, String(packs));
    assert.equal((await sh("git -C whole fetch -q origin")).code, 0);
    assert.equal((await sh(`git ls-remote ${via} >/dev/null`)).code, 0);
    assert.deepEqual(ops, ["fetch ok"]);
    // A fetch of a new commit: one more.
    const pushed = await sh(
      `cd src && echo 4 > f && git commit -qam 4 && git push -q ${repo} main`,
    );
    assert.equal(pushed.code, 0, pushed.out);
    assert.equal((await sh("git -C whole fetch -q origin")).code, 0);
    assert.deepEqual(ops, ["fetch ok", "fetch ok"]);
    ops.length = 0;
    for (const what of ["refs/pull/7/head", forkSha]) {
      const fetched = await sh(`git -C whole fetch -q origin ${what}`);
      assert.notEqual(fetched.code, 0, what);
      assert.match(
        fetched.out,
        /remote error: Deckhand: pull request #7 is from a fork \(evil\/repo\)/,
      );
    }
    // Refused at their pack request: refused, not ok.
    assert.deepEqual(ops, ["fetch refused", "fetch refused"]);
    ops.length = 0;
    const blobless = await sh(`git clone -q --filter=blob:none ${via} blobless`);
    assert.match(
      blobless.out,
      /remote error: Deckhand: \w+ isn't a commit on org\/repo's default branch/,
    );
    assert.match(blobless.out, /checkout failed/);
    // Its commits and trees came; the checkout's lone blobs were refused.
    assert.deepEqual(ops, ["fetch ok", "fetch refused"]);

    as(true);
    assert.equal(
      (
        await sh(
          "git -C whole fetch -q origin refs/pull/7/head && git -C whole show FETCH_HEAD:evil.sh",
        )
      ).out,
      "evil",
    );
    assert.equal((await sh(`git clone -q --filter=blob:none ${via} kept`)).code, 0);
    // The entrypoint's whole_clone(), in the next work run: every blob at once, through the gateway.
    as(false);
    const whole = await sh(
      `cd kept && git fetch -q --refetch --no-filter origin && git log -p >/dev/null &&
    git rev-list --objects --missing=print --all | grep -c '^?' || true`,
    );
    assert.equal(whole.out, "0");
  },
);

test("a file host's calls don't count towards a run's calls in flight: they hold no token", async (t) => {
  // None may be in flight: every counted call is refused, a file host's goes on.
  const gw = await gateway(t, { maxInFlight: 0 });
  const { secret } = gw.register(false);
  assert.equal((await gw.call("127.0.0.1", "/api/v3/repos/org/repo", secret)).status, 429);
  const file = await gw.call("localhost", "/org/repo/main/README.md", secret);
  assert.equal(file.status, 200);
});

test("a ref parameter behind a ';' is read as one: the gateway splits a query on it too", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register(false);
  const res = await gw.call(
    "127.0.0.1",
    "/api/v3/repos/org/repo/contents/a.js?x=1;ref=refs/pull/7/head",
    secret,
  );
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /pull request #7 is from a fork/);
});

test("a run's calls cause so many lookups on GitHub a minute, cached ones aside", async () => {
  let at = 0;
  const { get, asked } = fakeGithub();
  const forks = createForkChecks({ get, now: () => at });
  const run = workRun();
  const ref = (i) => `ref=${i.toString(16).padStart(40, "9")}`;
  const check = (i) =>
    forks.checkCall(run, {
      kind: "raw",
      path: "org/repo/main/a.js",
      query: new URLSearchParams(ref(i)),
    });
  // Each ref is a commit found nowhere: refused (403), after a few lookups each, until the
  // run has spent its lookups.
  let i = 0;
  let refused = null;
  while (refused?.status !== 429 && i <= RUN_LOOKUPS) refused = await check(i++);
  assert.equal(refused?.status, 429);
  assert.match(refused.message, /over 120 lookups on GitHub in a minute/);
  assert.ok(asked.length <= RUN_LOOKUPS);
  // Another run's are its own; a minute later, this one's again.
  assert.equal(
    await forks.checkCall(workRun(), {
      kind: "raw",
      path: "org/repo/main/a.js",
      query: new URLSearchParams(),
    }),
    null,
  );
  at += 60_000;
  assert.equal((await check(i)).status, 403);
});

test("GitHub's other content hosts are relayed as they are, to the host they name, read only", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register(false);
  // A tunnel to avatars.githubusercontent.com would answer as raw. when asked so: relayed, the
  // call goes to the host it names whatever `Host` the sandbox wrote, without its credentials.
  const status = await gw.raw("avatars.content.test", "/u/1?v=4", {
    host: "raw.githubusercontent.com",
    cookie: "a=b",
    authorization: `token ${secret}`,
  });
  assert.equal(status, 200);
  const sent = gw.calls.at(-1);
  assert.equal(sent.url, "/u/1?v=4");
  assert.match(sent.headers.host, /^localhost:\d+$/);
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(sent.headers.cookie, undefined);
  const put = await gw.call("avatars.content.test", "/u/1", secret, { method: "PUT", body: "x" });
  assert.equal(put.status, 405);
});

test("git's paths in any case are a fetch's, checked as one; another spelling is refused", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register(false);
  await gw.call("127.0.0.1", "/org/repo.git/git-upload-pack", secret, {
    method: "POST",
    body: LS_REFS,
  });
  const before = gw.calls.length;
  const upper = await gw.call("127.0.0.1", "/org/repo.git/GIT-UPLOAD-PACK", secret, {
    method: "POST",
    body: fetchOf(FORK),
  });
  assert.match(Buffer.from(await upper.arrayBuffer()).toString(), /ERR Deckhand: pull request #7/);
  const refs = await gw.call(
    "127.0.0.1",
    "/evil/repo.git/Info/Refs?service=git-upload-pack",
    secret,
  );
  assert.equal(refs.status, 403);
  assert.match(await refs.text(), /evil\/repo is a fork/);
  // Not git's path, not a page that shows no file: refused, never sent on unchecked.
  const slash = await gw.call("127.0.0.1", "/org/repo.git/git-upload-pack/", secret, {
    method: "POST",
    body: fetchOf(FORK),
  });
  assert.equal(slash.status, 403);
  assert.equal(gw.calls.length, before);
});

// The gateway as the listener builds it: its real file hosts and content hosts. Only calls it
// refuses are made, refused before anything leaves: none reaches GitHub. Sent through node:http,
// exactly as written (fetch() would resolve an encoded dot segment itself).
async function realGateway(t) {
  const broker = tokenBroker();
  const gw = createGithubGateway({
    broker,
    // A call that passed every check would get no token: it fails here, never reaching GitHub.
    app: () => ({
      repoToken: async () => {
        throw new Error("a test's call passed the checks");
      },
    }),
    api: "https://api.github.com",
    web: "https://github.com",
    forks: createForkChecks({ get: fakeGithub().get }),
  });
  const { port } = await serve(t, (req, res) => gw.handle(req, res));
  const id = broker.register("Org/Repo", { push: true, caps: ["pull"] });
  broker.allow(id, ["issue-1-*"], false);
  const secret = broker.token(id);
  return (host, path, { method = "GET", body } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { authorization: `token ${secret}` };
      const options = { host: "127.0.0.1", port, path: `/relay/${host}${path}`, method, headers };
      const req = request(options, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
}

test("a host spelled otherwise than the proxy relays it is no host the gateway serves", async (t) => {
  const call = await realGateway(t);
  const path = "/org/repo/refs/pull/7/head/a.js";
  // As the proxy relays it: checked, refused.
  const checked = await call("raw.githubusercontent.com", path);
  assert.equal(checked.status, 403);
  assert.match(checked.text, /pull request #7 is from a fork/);
  // Any other spelling (a trailing dot, another case, a port, an encoding): not a host it
  // relays, never a content host sent on unchecked.
  for (const host of [
    "raw.githubusercontent.com.",
    "RAW.githubusercontent.com",
    "raw.githubusercontent.com:443",
    "raw%2egithubusercontent.com",
    "GitHub.com",
  ]) {
    const res = await call(host, path);
    assert.equal(res.status, 404, host);
    assert.match(JSON.parse(res.text).message, /not a GitHub host it relays/, host);
  }
});

test("git's fetch takes its own methods only; a dot segment only decoding shows is refused", async (t) => {
  const call = await realGateway(t);
  for (const [path, method] of [
    ["/org/repo.git/git-upload-pack", "PUT"],
    ["/org/repo.git/git-upload-pack", "PATCH"],
    ["/org/repo.git/git-upload-pack", "GET"],
    ["/org/repo.git/info/refs?service=git-upload-pack", "POST"],
  ]) {
    const res = await call("github.com", path, {
      method,
      ...(method !== "GET" && { body: fetchOf(FORK) }),
    });
    assert.equal(res.status, 405, `${method} ${path}`);
  }
  // An encoded dot segment the URL parser resolves: the call that goes on is the one checked.
  const resolved = await call("api.github.com", "/repos/x/%2e%2e/evil/repo/tarball/main");
  assert.equal(resolved.status, 403);
  assert.match(resolved.text, /evil\/repo is a fork/);
  // One it doesn't, which only decoding shows, a backslash, a NUL: refused.
  for (const path of [
    "/repos/org/repo/..%2f..%2frepos/evil/repo/tarball/main",
    "/repos/org/repo/contents/a%5c..%5cb",
    "/repos/org/repo/contents/a%00b",
  ]) {
    assert.equal((await call("api.github.com", path)).status, 404, path);
  }
});

test("headers some front ends route by never reach GitHub", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register(true);
  const status = await gw.raw("127.0.0.1", "/api/v3/repos/org/repo", {
    authorization: `token ${secret}`,
    "x-original-url": "/repos/evil/repo/tarball/main",
    "x-rewrite-url": "/repos/evil/repo/tarball/main",
    "x-forwarded-host": "raw.githubusercontent.com",
    "x-http-method-override": "DELETE",
    forwarded: "host=raw.githubusercontent.com",
  });
  assert.equal(status, 200);
  const sent = gw.calls.at(-1).headers;
  for (const name of ROUTING_HEADERS) assert.equal(sent[name], undefined, name);
});
