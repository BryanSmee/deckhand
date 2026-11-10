// Context repos at the gateways (#930, context-gateway.mjs): a run's git fetches each of its
// context repos with a token for that repository alone (none for a public one without the App),
// and nothing else of them: their API, pages, raw files, GraphQL, pushes; what it may not read
// isn't fetched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runFields } from "../github/runs.mjs";
import {
  CONTEXT_READ,
  contextCall,
  contextFields,
  contextGraphql,
  namedRepo,
  tokenFor,
} from "../listener/context-gateway.mjs";
import { createGitGateway } from "../listener/git-gateway.mjs";
import { createGithubGateway } from "../listener/github-gateway.mjs";
import { parse } from "../listener/vendor/graphql.mjs";
import { serve, tempDir, tokenBroker } from "./helpers.mjs";

const TOKEN = "repo-token-0123456789abcdef";
const CONTEXT_TOKEN = "context-token-0123456789abcdef";
// A run of org/repo that reads acme/app (the App installed there) and acme/docs (public, without
// it), and may not fetch the rest of acme's (the operator's pattern).
const CONTEXT = {
  repos: [
    { repo: "acme/app", installed: true },
    { repo: "acme/docs", installed: false },
  ],
  fenced: ["acme/app", "acme/docs", "acme/*"],
};

// A fake GitHub (its API under /api/v3, on the web's host) and a gateway in front of it, its
// raw file host on the same server.
async function gateway(t) {
  const calls = [];
  const github = await serve(t, (req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
      res.end("ok");
    });
  });
  const broker = tokenBroker();
  const minted = [];
  const app = {
    repoToken: async (repo, wanted) => {
      minted.push([repo, wanted]);
      return { token: repo === "org/repo" ? TOKEN : CONTEXT_TOKEN };
    },
  };
  const gw = createGithubGateway({
    broker,
    app: () => app,
    api: `${github.url}/api/v3`,
    web: github.url,
    files: [{ host: "raw.githubusercontent.com", kind: "raw", prefix: "", url: github.url }],
    log: () => {},
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  const register = (context = CONTEXT) => {
    const id = broker.register("org/repo", { caps: ["pull"], context });
    const notes = [];
    broker.provide(id, "anthropic", (line) => notes.push(line));
    return { secret: broker.token(id), notes };
  };
  const call = (path, secret, { host = "127.0.0.1", method = "GET", body } = {}) =>
    fetch(`${url}/relay/${host}${path}`, {
      method,
      body,
      headers: { authorization: `Basic ${Buffer.from(`x:${secret}`).toString("base64")}` },
    });
  return { calls, minted, register, call };
}

const basic = (token) => `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
const advertisement = "/info/refs?service=git-upload-pack";

test("a context repo the App is installed on: git fetches it with a token for it alone, contents: read", async (t) => {
  const { calls, minted, register, call } = await gateway(t);
  const { secret } = register();
  const res = await call(`/acme/app.git${advertisement}`, secret);
  assert.equal(res.status, 200);
  const pack = await call("/Acme/App.git/git-upload-pack", secret, {
    method: "POST",
    body: "0000",
  });
  assert.equal(pack.status, 200);
  assert.deepEqual(minted, [
    ["acme/app", { contents: "read" }],
    ["acme/app", { contents: "read" }],
  ]);
  assert.deepEqual(CONTEXT_READ, { contents: "read" });
  assert.deepEqual(
    calls.map((c) => c.headers.authorization),
    [basic(CONTEXT_TOKEN), basic(CONTEXT_TOKEN)],
  );
});

test("a public context repo without the App: fetched without any token", async (t) => {
  const { calls, minted, register, call } = await gateway(t);
  const { secret } = register();
  const res = await call(`/acme/docs${advertisement}`, secret);
  assert.equal(res.status, 200);
  assert.deepEqual(minted, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, undefined);
});

test("a repository the run may not fetch is refused, noted; another one goes as before", async (t) => {
  const { calls, minted, register, call } = await gateway(t);
  const { secret, notes } = register();
  // Granted to the repository (acme/*), not asked for by its config.
  const fenced = await call(`/acme/templates${advertisement}`, secret);
  assert.equal(fenced.status, 403);
  assert.match(await fenced.text(), /acme\/templates isn't a context repo this run reads/);
  const pack = await call("/acme/templates.git/git-upload-pack", secret, {
    method: "POST",
    body: "0000",
  });
  // git's pack request gets git's error line.
  assert.match(await pack.text(), /ERR Deckhand: acme\/templates isn't a context repo/);
  assert.equal(calls.length, 0);
  assert.ok(notes.some((n) => /refused the run's GitHub call .*acme\/templates/.test(n)));
  // Asked for, without `read:context`: none of them.
  const { secret: without } = register({ repos: [], fenced: ["acme/app"] });
  assert.equal((await call(`/acme/app${advertisement}`, without)).status, 403);
  assert.equal(calls.length, 0);
  // Another repository: with the run's own token, which reads public ones only (as before).
  assert.equal((await call(`/other/lib${advertisement}`, secret)).status, 200);
  assert.deepEqual(
    minted.map(([repo]) => repo),
    ["org/repo"],
  );
  // Its own repository: its own token.
  assert.equal((await call(`/org/repo${advertisement}`, secret)).status, 200);
  assert.equal(calls.length, 2);
});

test("a context repo's API, issues, pull requests, pages and raw files are refused, noted", async (t) => {
  const { calls, minted, register, call } = await gateway(t);
  const { secret, notes } = register();
  for (const [path, host, what] of [
    ["/api/v3/repos/acme/app", undefined, "its API"],
    ["/api/v3/repos/ACME/app/issues/3", undefined, "its API"],
    ["/api/v3/repos/acme/docs/pulls", undefined, "its API"],
    ["/acme/app/pull/4", undefined, "its pages"],
    ["/acme/app/blob/main/README.md", undefined, "its pages"],
    ["/acme/app/main/README.md", "raw.githubusercontent.com", "its raw files"],
  ]) {
    const res = await call(path, secret, { host });
    assert.equal(res.status, 403, path);
    assert.match(await res.text(), new RegExp(`git alone .*not ${what}`), path);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(minted, []);
  assert.ok(notes.some((n) => /acme\/app is one of this run's context repos/.test(n)));
});

test("a push to a context repo: the GitHub gateway sends it to the git gateway, which refuses it", async (t) => {
  const { register, call } = await gateway(t);
  const { secret } = register();
  const res = await call("/acme/app.git/git-receive-pack", secret, { method: "POST", body: "0" });
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /pushes go through Deckhand's git gateway/);

  const broker = tokenBroker();
  const id = broker.register("org/repo", { push: true, caps: ["pull", "push"], context: CONTEXT });
  broker.allow(id, ["issue-1-*"]);
  const seen = [];
  const git = createGitGateway({
    broker,
    app: () => ({ repoToken: async () => (seen.push("token"), { token: TOKEN }) }),
    githubUrl: "https://github.invalid",
    mirrorDir: tempDir(t),
    fetch: async () => (seen.push("github"), new Response("")),
    log: () => {},
  });
  const { url } = await serve(t, (req, res) => git.handle(req, res));
  const auth = `Basic ${Buffer.from(`x:${broker.token(id)}`).toString("base64")}`;
  for (const repo of ["acme/app", "acme/docs"]) {
    const probe = await fetch(`${url}/git/${repo}.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: auth },
    });
    assert.equal(probe.status, 403);
    assert.match(await probe.text(), /this run can only push to org\/repo/);
  }
  assert.deepEqual(seen, []);
});

test("tokenFor: the run's own repository's, a context repo's alone, or none", async () => {
  const asked = [];
  const github = {
    repoToken: async (repo, wanted) => (asked.push([repo, wanted]), { token: repo }),
  };
  const run = { repo: "org/repo" };
  assert.deepEqual(await tokenFor(github, run, { issues: "read" }), { token: "org/repo" });
  const installed = { repo: "acme/app", installed: true };
  assert.deepEqual(await tokenFor(github, run, { issues: "read" }, installed), {
    token: "acme/app",
  });
  const plain = { repo: "acme/docs", installed: false };
  assert.deepEqual(await tokenFor(github, run, {}, plain), { token: null });
  assert.deepEqual(asked, [
    ["org/repo", { issues: "read" }],
    ["acme/app", { contents: "read" }],
  ]);
});

test("namedRepo: the repository a REST path, a page, a raw file or git names", () => {
  const raw = { host: "raw.githubusercontent.com", prefix: "" };
  const media = { host: "media.githubusercontent.com", prefix: "media/" };
  assert.equal(namedRepo({ api: true, path: "repos/Acme/App/issues" }), "acme/app");
  assert.equal(namedRepo({ api: true, path: "repos/acme/app" }), "acme/app");
  assert.equal(namedRepo({ api: true, path: "search/issues" }), null);
  assert.equal(namedRepo({ api: true, path: "graphql" }), null);
  assert.equal(namedRepo({ api: false, path: "acme/app.git/info/refs" }), "acme/app");
  assert.equal(namedRepo({ api: false, path: "acme/app" }), "acme/app");
  assert.equal(namedRepo({ api: false, path: "login" }), null);
  assert.equal(namedRepo({ api: false, file: raw, path: "acme/app/main/a.md" }), "acme/app");
  assert.equal(namedRepo({ api: false, file: media, path: "media/acme/app/main/a" }), "acme/app");
  assert.equal(namedRepo({ api: false, file: media, path: "acme/app/main/a" }), null);
  assert.equal(namedRepo({ api: false, file: { passthrough: true }, path: "acme/app" }), null);
});

test("contextCall: nothing for the run's own repository, nor for a run without context", () => {
  const run = { repo: "acme/app", context: CONTEXT };
  const git = ["acme/app/info/refs", "acme/app"];
  assert.equal(contextCall(run, { api: false, path: git[0] }, git), null);
  const plain = { repo: "org/repo" };
  assert.equal(contextCall(plain, { api: true, path: "repos/acme/app" }, null), null);
  assert.equal(contextCall(plain, { api: false, path: git[0] }, git), null);
});

test("contextGraphql: a context repo named at the root, through variables or fragments", () => {
  const run = { repo: "org/repo", context: CONTEXT };
  const said = (query, variables = {}) => {
    const doc = parse(query);
    const op = doc.definitions.find((d) => d.kind === "OperationDefinition");
    return contextGraphql(run, { doc, op, variables })?.message ?? null;
  };
  assert.match(
    said(`{ repository(owner: "acme", name: "app") { issues(first: 1) { totalCount } } }`),
    /acme\/app is one of this run's context repos: .* not GraphQL/,
  );
  assert.match(
    said(`query($o: String!, $n: String!) { r: repository(owner: $o, name: $n) { id } }`, {
      o: "ACME",
      n: "docs",
    }),
    /acme\/docs/,
  );
  assert.match(
    said(
      `query { ...R } fragment R on Query { ... on Query { repository(owner: "acme", name: "app") { id } } }`,
    ),
    /acme\/app/,
  );
  assert.equal(said(`{ repository(owner: "org", name: "repo") { id } }`), null);
  assert.equal(said(`{ repository(owner: "acme", name: "templates") { id } }`), null);
  const none = { repo: "org/repo" };
  const doc = parse(`{ repository(owner: "acme", name: "app") { id } }`);
  assert.equal(contextGraphql(none, { doc, op: doc.definitions[0] }), null);
});

test("the github service keeps a run's context as the orchestrator says it, checked", () => {
  assert.deepEqual(contextFields(undefined), { repos: [], fenced: [] });
  assert.deepEqual(
    contextFields({
      repos: [
        { repo: "Acme/App", installed: true },
        { repo: "bad" },
        { repo: "a/b", installed: 1 },
      ],
      fenced: ["acme/*", 3, "no owner"],
    }),
    {
      repos: [
        { repo: "acme/app", installed: true },
        { repo: "a/b", installed: false },
      ],
      fenced: ["acme/*"],
    },
  );
  assert.deepEqual(runFields({ repo: "org/repo", context: CONTEXT }).context, CONTEXT);
  assert.deepEqual(runFields({ repo: "org/repo" }).context, { repos: [], fenced: [] });
});
