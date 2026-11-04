// Who may do what (#730): the access rules (policies.mjs access(), can(), allows()), Deckhand's
// policy/access.rego and policy/access-roles.rego, evaluated by the real opa where it is on the
// PATH (CI's), and what the listener does around them with a service of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ACCESS_MS,
  actionMatches,
  allows,
  createPolicies,
  REPO_ACTIONS,
  SERVER_ACTIONS,
} from "../listener/policies.mjs";
import { builtInPolicies } from "../policy-service/engine.mjs";
import { opaBinary } from "../policy-service/opa.mjs";
import { hasOpa, localService, policyEngineOf } from "./helpers.mjs";

const noOpa = !hasOpa() && "no opa on the PATH";

// A grants folder's access.rego, with `bindings` only.
const bindings = (list) => `package deckhand\n\nbindings := ${JSON.stringify(list, null, 2)}\n`;

// The repositories GitHub knows: name → { private, policies: name → text }, their default branch
// `main`; `calls`, the paths asked.
function fakeGithub(repos) {
  const calls = [];
  // sha → text, a blob per file listed.
  const blobs = new Map();
  const github = async (_repo, _method, url) => {
    const path = url.split("?")[0];
    calls.push(path);
    const at = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(path);
    const repo = at && repos[at[1].toLowerCase()];
    if (!repo) return new Response("{}", { status: 404 });
    if (repo.down) return new Response("{}", { status: 502 });
    if (!at[2]) {
      return Response.json({ full_name: at[1], private: repo.private, default_branch: "main" });
    }
    const files = Object.entries(repo.policies ?? {});
    if (at[2] === "/contents/.deckhand/policy") {
      if (!files.length) return new Response("{}", { status: 404 });
      return Response.json(
        files.map(([name, text]) => {
          const sha = `sha-${blobs.size}`;
          blobs.set(sha, text);
          return { type: "file", name, sha };
        }),
      );
    }
    const blob = /^\/git\/blobs\/(.*)$/.exec(at[2]);
    return Response.json({ content: Buffer.from(blobs.get(blob?.[1]) ?? "").toString("base64") });
  };
  return { github, calls };
}

// createPolicies() on the real opa: Deckhand's files under the operator's (`operator`: name →
// text, edited in place), the repositories' as `repos` says; `asked()`, the access calls the
// policy service got.
function realAccess(t, { operator = {}, repos = {}, now = Date.now } = {}) {
  const { github, calls } = fakeGithub(repos);
  const local = localService(
    policyEngineOf(t, {
      opa: opaBinary(),
      readBuiltIn: () => builtInPolicies(),
      readOperator: () => new Map(Object.entries(operator)),
    }),
  );
  let asked = 0;
  const service = { ...local, evaluateAccess: (body) => (asked++, local.evaluateAccess(body)) };
  const policies = createPolicies({ config: {}, github, service, now });
  return { policies, calls, asked: () => asked };
}

const repo = (name, isPrivate = true) => ({
  full_name: name,
  private: isPrivate,
  default_branch: "main",
});

test("actionMatches and allows: a `*` prefix, a deny wins, each action in its scope, an error gives nothing", () => {
  assert.ok(actionMatches("runs:start:*", "runs:start:work"));
  assert.ok(actionMatches("*", "tasks:read"));
  assert.ok(actionMatches("runs:*", "runs:start:*"));
  assert.ok(actionMatches("tasks:read", "tasks:read"));
  assert.ok(!actionMatches("tasks:read", "tasks:reads"));
  assert.ok(!actionMatches("runs:start:work", "runs:start:*"));
  assert.ok(!actionMatches("runs:start", "runs:start:work"));
  assert.ok(!actionMatches(null, "tasks:read"));
  const answer = {
    actions: ["*"],
    denied: [{ action: "runs:start:*", reason: "no runs", file: "x.rego", layer: "repo" }],
    files: {},
    error: null,
  };
  assert.ok(allows(answer, "tasks:read"));
  assert.ok(!allows(answer, "runs:start:work"));
  assert.ok(allows(answer, "runs:manage"));
  // The server's actions only server-wide, the others only on a repository.
  assert.ok(!allows(answer, "server:read"));
  assert.ok(allows(answer, "server:read", false));
  assert.ok(!allows(answer, "tasks:read", false));
  assert.ok(!allows({ ...answer, error: "policy error: x" }, "tasks:read"));
  assert.ok(!allows(null, "tasks:read"));
  assert.ok(REPO_ACTIONS.every((a) => !a.startsWith("server:")));
  assert.ok(SERVER_ACTIONS.every((a) => a.startsWith("server:")));
});

test(
  "the real opa: with Deckhand's files alone, every login has every action, without asking it",
  { skip: noOpa },
  async (t) => {
    const { policies, asked } = realAccess(t, { repos: { "org/repo": {} } });
    const answer = await policies.access("Someone", repo("org/repo"));
    assert.deepEqual(answer, {
      actions: ["*"],
      denied: [],
      files: { "*": ["access.rego"] },
      error: null,
    });
    assert.equal(asked(), 0);
    for (const action of [...REPO_ACTIONS, "runs:start:work", "runs:start:audit"]) {
      assert.ok(await policies.can("someone", repo("org/repo"), action), action);
    }
    for (const action of SERVER_ACTIONS) assert.ok(await policies.can("someone", null, action));
    // What opa says of the same files: an operator file that adds nothing has it asked.
    const other = realAccess(t, {
      operator: { "extra.rego": "package deckhand\n\nextra := true\n" },
      repos: { "org/repo": {} },
    });
    const evaluated = await other.policies.access("someone", repo("org/repo"));
    assert.deepEqual(evaluated, answer);
    assert.equal(other.asked(), 1);
    assert.deepEqual((await other.policies.access("someone", null)).actions, ["*"]);
  },
);

test(
  "the real opa: bindings narrow, by exact name, owner/* and */*, whatever the case; roles are action sets",
  { skip: noOpa },
  async (t) => {
    const { policies } = realAccess(t, {
      operator: {
        "access.rego": bindings([
          { users: ["Alice"], repos: ["acme/*"], role: "viewer" },
          { users: ["bob"], repos: ["acme/api"], role: "member" },
          { users: ["carol"], repos: ["*/*"], role: "admin" },
          { users: ["carol"], role: "operator" },
          { users: ["dan"], repos: ["acme/web"], actions: ["logs:read", "server:read"] },
        ]),
      },
    });
    const actions = async (login, where) => (await policies.access(login, where)).actions;
    assert.deepEqual(await actions("alice", repo("ACME/Web")), ["tasks:read"]);
    assert.deepEqual(await actions("ALICE", repo("acme/api")), ["tasks:read"]);
    // Another owner whose name starts as acme's: no.
    assert.deepEqual(await actions("alice", repo("acmex/web")), []);
    assert.deepEqual(await actions("bob", repo("acme/api")), [
      "logs:read",
      "runs:manage",
      "runs:start:*",
      "tasks:read",
    ]);
    assert.deepEqual(await actions("bob", repo("acme/web")), []);
    assert.deepEqual(await actions("carol", repo("any/thing")), [
      "logs:read",
      "repo:config:read",
      "runs:manage",
      "runs:start:*",
      "tasks:read",
    ]);
    // Server-wide: the server's actions alone, of any binding of the login's.
    assert.deepEqual(await actions("carol", null), ["server:*"]);
    assert.deepEqual(await actions("dan", null), ["server:read"]);
    assert.deepEqual(await actions("dan", repo("acme/web")), ["logs:read"]);
    assert.deepEqual(await actions("bob", null), []);
    // Nobody bound: nothing, anywhere.
    assert.deepEqual(await actions("eve", repo("acme/api")), []);
    assert.deepEqual(await actions("eve", null), []);
    // The `*` of a role: every mode.
    assert.ok(await policies.can("bob", repo("acme/api"), "runs:start:work"));
    assert.ok(await policies.can("bob", repo("acme/api"), "runs:start:audit"));
    assert.ok(!(await policies.can("bob", repo("acme/api"), "repo:config:read")));
    assert.ok(!(await policies.can("alice", repo("acme/api"), "logs:read")));
    assert.ok(await policies.can("carol", null, "server:sync"));
    assert.ok(!(await policies.can("dan", null, "server:sync")));
    // The file whose rule gave each action.
    assert.deepEqual((await policies.access("bob", repo("acme/api"))).files, {
      "logs:read": ["access-roles.rego"],
      "runs:manage": ["access-roles.rego"],
      "runs:start:*": ["access-roles.rego"],
      "tasks:read": ["access-roles.rego"],
    });
  },
);

test(
  "the real opa: a deny wins, the operator's or a repository's; a repository's allow widens nothing",
  { skip: noOpa },
  async (t) => {
    const repos = {
      "acme/api": {
        policies: {
          "access.rego": [
            "package deckhand",
            "",
            'allow_access contains "repo:config:read"',
            "",
            "deny_access contains {",
            '  "action": "runs:start:work",',
            '  "reason": "work runs start from the release team only",',
            '} if input.user.login == "bob"',
          ].join("\n"),
        },
      },
      "acme/web": { private: false },
    };
    const { policies } = realAccess(t, {
      repos,
      operator: {
        "access.rego": bindings([{ users: ["bob"], repos: ["acme/*"], role: "member" }]),
        "public.rego": [
          "package deckhand",
          "",
          "deny_access contains {",
          '  "action": "runs:*",',
          '  "reason": "no runs on public repositories",',
          "} if input.repo.private == false",
        ].join("\n"),
      },
    });
    const api = await policies.access("bob", "acme/api");
    assert.equal(api.error, null);
    assert.ok(!api.actions.includes("repo:config:read"));
    assert.deepEqual(api.denied, [
      {
        action: "runs:start:work",
        reason: "work runs start from the release team only",
        file: "access.rego",
        layer: "repo",
      },
    ]);
    assert.ok(!(await policies.can("bob", "acme/api", "runs:start:work")));
    assert.ok(await policies.can("bob", "acme/api", "runs:start:brainstorm"));
    assert.ok(!(await policies.can("bob", "acme/api", "repo:config:read")));
    // The operator's deny, on what GitHub says of the repository.
    const web = await policies.access("bob", "acme/web");
    assert.deepEqual(web.denied, [
      {
        action: "runs:*",
        reason: "no runs on public repositories",
        file: "public.rego",
        layer: "operator",
      },
    ]);
    assert.ok(await policies.can("bob", "acme/web", "tasks:read"));
    assert.ok(!(await policies.can("bob", "acme/web", "runs:manage")));
    // A repository's allow_access: a config check error, flagged ignored.
    const { errors } = await policies.check(
      new Map(Object.entries(repos["acme/api"].policies)),
      "repo",
    );
    assert.deepEqual(errors, [
      "access.rego:3: `allow_access` is ignored: only the operator's policies give access; a repository's may only take some away (`deny_access`)",
    ]);
  },
);

test(
  "the real opa: fail closed, a policy that doesn't compile, a rule of the wrong shape, an unreadable repository",
  { skip: noOpa },
  async (t) => {
    const broken = realAccess(t, {
      operator: { "access.rego": "package deckhand\n\nallow_access contains x if {\n" },
    });
    const answer = await broken.policies.access("bob", repo("acme/api"));
    assert.deepEqual(answer.actions, []);
    assert.match(answer.error, /^policy error: /);
    assert.ok(!(await broken.policies.can("bob", repo("acme/api"), "tasks:read")));
    assert.ok(!(await broken.policies.can("bob", null, "server:read")));
    const shape = realAccess(t, {
      operator: {
        "access.rego":
          'package deckhand\n\nallow_access contains "*"\n\ndeny_access contains "x"\n',
      },
    });
    assert.match(
      (await shape.policies.access("bob", null)).error,
      /`deny_access` must be a set of \{"action": …, "reason": …\} objects/,
    );
    // A repository GitHub can't say anything of, or whose policies can't be listed.
    const down = realAccess(t, { repos: { "acme/api": { down: true } } });
    assert.match((await down.policies.access("bob", "acme/api")).error, /can't be read/);
    assert.match((await down.policies.access("bob", repo("acme/api"))).error, /can't be read/);
    assert.equal((await down.policies.access("bob", null)).error, null);
    assert.equal((await down.policies.access("", null)).error, "no login");
  },
);

test("access: a policy service away, or of other operator policies, gives nothing", async (t) => {
  const engine = policyEngineOf(t, {
    readOperator: () => new Map([["access.rego", bindings([])]]),
  });
  const local = localService(engine);
  const away = createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service: {
      ...local,
      evaluateAccess: async () => {
        throw new Error("the policy service can't be reached (ECONNREFUSED, for 30 s)");
      },
    },
  });
  const answer = await away.access("bob", null);
  assert.deepEqual(answer, {
    actions: [],
    denied: [],
    files: {},
    error: "policy error: the policy service can't be reached (ECONNREFUSED, for 30 s)",
  });
  // Another set of operator policies than the listener's own: asked once more, then refused.
  let calls = 0;
  const other = createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service: {
      ...local,
      evaluateAccess: async () => (calls++, { error: "not the ones", mismatch: true }),
    },
  });
  assert.equal((await other.access("bob", null)).error, "policy error: not the ones");
  assert.equal(calls, 2);
});

test(
  "the real opa: answers kept per layers, login and repository; an edit or a push asks again",
  { skip: noOpa },
  async (t) => {
    const clock = { now: 1_000 };
    const operator = {
      "access.rego": bindings([{ users: ["bob"], repos: ["acme/*"], role: "member" }]),
    };
    const repos = { "acme/api": {} };
    const { policies, asked, calls } = realAccess(t, {
      operator,
      repos,
      now: () => clock.now,
    });
    const listings = () => calls.filter((p) => p.endsWith("/contents/.deckhand/policy")).length;
    assert.ok(await policies.can("bob", repo("acme/api"), "runs:manage"));
    assert.equal(asked(), 1);
    // Every action from the one answer, the login and the name in another case too.
    assert.ok(await policies.can("Bob", repo("Acme/API"), "logs:read"));
    assert.ok(!(await policies.can("bob", repo("acme/api"), "repo:config:read")));
    assert.equal(asked(), 1);
    // Another login, another repository, server-wide: each asked.
    await policies.access("alice", repo("acme/api"));
    await policies.access("bob", repo("acme/web"));
    await policies.access("bob", null);
    assert.equal(asked(), 4);
    // The repository's policies are listed before its answer, kept until its push.
    const listed = listings();
    repos["acme/api"].policies = {
      "deny.rego":
        'package deckhand\n\ndeny_access contains {"action": "runs:manage", "reason": "no"} if true\n',
    };
    assert.ok(await policies.can("bob", repo("acme/api"), "runs:manage"));
    assert.equal(listings(), listed);
    policies.forget("acme/api");
    assert.ok(!(await policies.can("bob", repo("acme/api"), "runs:manage")));
    assert.equal(listings(), listed + 1);
    assert.equal(asked(), 5);
    // An edit of the operator's policies applies at once.
    operator["access.rego"] = bindings([{ users: ["bob"], repos: ["acme/*"], role: "viewer" }]);
    assert.deepEqual((await policies.access("bob", repo("acme/web"))).actions, ["tasks:read"]);
    assert.equal(asked(), 6);
    assert.deepEqual((await policies.access("bob", repo("acme/web"))).actions, ["tasks:read"]);
    assert.equal(asked(), 6);
    // Past ACCESS_MS, asked again whatever.
    clock.now += ACCESS_MS;
    await policies.access("bob", repo("acme/web"));
    assert.equal(asked(), 7);
  },
);

test("access: a failure isn't kept", async (t) => {
  const engine = policyEngineOf(t, {
    readOperator: () => new Map([["access.rego", bindings([])]]),
  });
  const local = localService(engine);
  let fail = true;
  let calls = 0;
  const policies = createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service: {
      ...local,
      evaluateAccess: async (body) => {
        calls++;
        if (fail) return { error: "opa didn't answer" };
        return {
          results: {
            access: { operator: { all: { allow: [["tasks:read"]], deny: [[]] }, files: {} } },
          },
        };
      },
    },
  });
  assert.equal(
    (await policies.access("bob", repo("acme/api"))).error,
    "policy error: opa didn't answer",
  );
  fail = false;
  assert.deepEqual((await policies.access("bob", repo("acme/api"))).actions, ["tasks:read"]);
  assert.equal(calls, 2);
});

test(
  "the real opa: docs/repo-config.md's bindings give what its roles' table says",
  { skip: noOpa },
  async (t) => {
    const docs = readFileSync(new URL("../docs/repo-config.md", import.meta.url), "utf8");
    const marker = docs.indexOf("<!-- access.rego: test/access-rules.test.mjs");
    assert.ok(marker > 0);
    const [, text] = /```rego\n([\s\S]*?)```/.exec(docs.slice(marker));
    const { policies } = realAccess(t, { operator: { "access.rego": text } });
    const actions = async (login, where) => (await policies.access(login, where)).actions;
    assert.deepEqual(await actions("alice", repo("acme/docs")), ["tasks:read"]);
    assert.deepEqual(await actions("bob", repo("acme/web")), [
      "logs:read",
      "runs:manage",
      "runs:start:*",
      "tasks:read",
    ]);
    assert.ok((await actions("carol", repo("other/repo"))).includes("repo:config:read"));
    assert.deepEqual(await actions("carol", null), ["server:*"]);
    assert.deepEqual(await actions("dan", repo("acme/api")), ["logs:read"]);
    assert.deepEqual(await actions("dan", null), []);
  },
);
