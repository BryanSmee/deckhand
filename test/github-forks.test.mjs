// What a work run that isn't a fork's may fetch of GitHub (github-forks.mjs, issue #409): a
// fork's pull request's head, a fork's repository and a commit that isn't its repository's are
// refused, by git, the API, an archive, a page or a raw file; its own branches' never are.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  pkt,
  readsBlobs,
  refKind,
} from "../listener/github-forks.mjs";
import { createGithubGateway, FILES } from "../listener/github-gateway.mjs";
import { createGraphqlChecks } from "../listener/github-graphql.mjs";
import { parse } from "../listener/vendor/graphql.mjs";
import { sandboxAt, serve, tempDir } from "./helpers.mjs";

const OWN = "a".repeat(40); // on the default branch
const HEAD = "b".repeat(40); // a branch's head, not on the default one
const FORK = "c".repeat(40); // a fork's pull request's head
const TAG = "d".repeat(40);
const PEELED = "e".repeat(40);
const MERGE = "f".repeat(40); // an own pull request's merge, on no branch

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
  // Read as it streams: the same, whatever its chunks, only a cut line held.
  const reader = advertisementReader();
  for (let i = 0; i < v0.length; i += 7) reader.push(v0.subarray(i, i + 7));
  assert.deepEqual(reader.refs(), advertisedRefs(v0));
});

test("refKind and callTargets: what a call names that may be a fork's", () => {
  assert.deepEqual(refKind("refs/pull/7/head"), { pull: 7 });
  assert.deepEqual(refKind("pull/12/merge/src/a.js"), { pull: 12 });
  assert.deepEqual(refKind(`${FORK}/package.json`), { sha: FORK });
  assert.deepEqual(refKind("abc1234~2"), { sha: "abc1234" });
  assert.deepEqual(refKind("feature/x/README.md"), {});
  assert.deepEqual(refKind("refs/heads/main/a"), {});
  assert.deepEqual(refKind("evil:main"), { owner: "evil" });

  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(callTargets("api", "repos/Org/Repo/tarball/refs/pull/7/head"), {
    repo: "Org/Repo",
    id: null,
    refs: ["refs/pull/7/head"],
    pulls: [],
    blob: false,
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
  assert.deepEqual(callTargets("raw", "o/r/refs/pull/7/head/a.js").refs, ["refs/pull/7/head/a.js"]);
});

test("readsBlobs: a fragment on Blob, inline or named", () => {
  const reads = (q) => readsBlobs(parse(q));
  assert.equal(
    reads(
      `{ repository(owner:"o",name:"r") { object(expression:"main:a") { ... on Blob { text } } } }`,
    ),
    true,
  );
  assert.equal(
    reads(
      `query { repository(owner:"o",name:"r") { object(expression:"x") { ...F } } } fragment F on Blob { text }`,
    ),
    true,
  );
  assert.equal(
    reads(`{ repository(owner:"o",name:"r") { pullRequest(number:7) { title } } }`),
    false,
  );
});

test("a work run that isn't a fork's is checked; a fork's run and other runs aren't", () => {
  const { get } = fakeGithub();
  const forks = createForkChecks({ get });
  const broker = createBroker({});
  const work = broker.register("Org/Repo", {}, { push: true });
  assert.equal(forks.restricted(broker.runOf(work)), true);
  broker.allow(work, ["issue-1-*"]);
  assert.equal(forks.restricted(broker.runOf(work)), true);
  broker.allow(work, [], true);
  assert.equal(forks.restricted(broker.runOf(work)), false);
  const light = broker.register("Org/Repo", {}, { push: false });
  assert.equal(forks.restricted(broker.runOf(light)), false);
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
      /isn't a commit on org\/repo's default branch nor a branch's head/,
      path,
    );
  }
  assert.match(
    (await check("api", "repos/org/repo/compare/main...evil:main")).message,
    /another repository's/,
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
    ["web", "org/repo/archive/refs/pull/8/head.zip"],
    ["raw", "org/repo/feature/x/README.md"],
    ["raw", "org/repo/refs/heads/main/README.md"],
    // Another repository, not in the network: not this check's business.
    ["api", "repos/other/lib/tarball/main"],
    ["raw", "other/lib/main/install.sh"],
    ["web", "login/oauth"],
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

test("over GraphQL, a work run that isn't a fork's can't read a file's content", async () => {
  const checks = createGraphqlChecks({
    nodes: async () => [],
    checkWrite: async () => null,
    blobs: (run) => run.fork,
  });
  const query = JSON.stringify({
    query: `{ repository(owner:"o",name:"r") { object(expression:"refs/pull/7/head:a.js") { ... on Blob { text } } } }`,
  });
  const refused = await checks.check({ repo: "o/r", fork: false }, Buffer.from(query));
  assert.equal(refused.refused.status, 403);
  assert.match(refused.refused.message, /Blob/);
  assert.equal(
    (await checks.check({ repo: "o/r", fork: true }, Buffer.from(query))).refused,
    undefined,
  );
});

// The gateway in front of a fake GitHub that serves git's advertisements, and raw files.
async function gateway(t) {
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
  const broker = createBroker({ sentFrom: sandboxAt() });
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
    forks,
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  const register = (fork) => {
    const secret = broker.register("Org/Repo", {}, { push: true });
    const notes = [];
    broker.provide(secret, "anthropic", (line) => notes.push(line));
    broker.allow(secret, ["issue-1-*"], fork);
    return { secret, notes };
  };
  const call = (host, path, secret, { method = "GET", body, headers = {} } = {}) =>
    fetch(`${url}/relay/${host}${path}`, {
      method,
      body,
      headers: { authorization: `token ${secret}`, ...headers },
    });
  return { calls, register, call };
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
test("real git through the gateway: a whole clone goes, a fork's head and lone blobs don't", async (t) => {
  const dir = tempDir(t, "forks-git-");
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
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
        const [name, value] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)];
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
    if (path === "/repos/org/repo") return { id: 1, full_name: "org/repo", default_branch: "main" };
    if ((m = /pulls\/(\d+)$/.exec(path))) return PULLS[m[1]] ?? null;
    if ((m = /compare\/([0-9a-f]+)\.\.\./.exec(path))) {
      const on = await sh(`git -C ${repo} merge-base --is-ancestor ${m[1]} main`);
      return on.code === 0 ? { status: "ahead" } : null;
    }
    return /branches-where-head/.test(path) ? [] : null;
  };
  const broker = createBroker({ sentFrom: async () => true });
  let current = null;
  const gw = createGithubGateway({
    broker,
    app: () => ({ repoToken: async () => ({ token: "repo-token-0123456789abcdef" }) }),
    api: `${github.url}/api/v3`,
    web: github.url,
    forks: createForkChecks({ get }),
    // git's calls carry no secret: the run whose sandbox sent them.
    runFrom: async () => current,
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  const via = `${url}/relay/127.0.0.1/org/repo.git`;
  const as = (fork) => {
    const secret = broker.register("org/repo", {}, { push: true });
    broker.allow(secret, [], fork);
    current = broker.runOf(secret);
  };

  as(false);
  assert.equal(
    (await sh(`git clone -q ${via} whole && git -C whole log --oneline | wc -l`)).out,
    "3",
  );
  assert.equal((await sh("git -C whole fetch -q origin refs/pull/8/head")).code, 0);
  for (const what of ["refs/pull/7/head", forkSha]) {
    const fetched = await sh(`git -C whole fetch -q origin ${what}`);
    assert.notEqual(fetched.code, 0, what);
    assert.match(
      fetched.out,
      /remote error: Deckhand: pull request #7 is from a fork \(evil\/repo\)/,
    );
  }
  const blobless = await sh(`git clone -q --filter=blob:none ${via} blobless`);
  assert.match(
    blobless.out,
    /remote error: Deckhand: \w+ isn't a commit on org\/repo's default branch/,
  );
  assert.match(blobless.out, /checkout failed/);

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
});
