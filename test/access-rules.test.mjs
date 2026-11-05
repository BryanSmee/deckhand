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
  knownAction,
  knownMode,
  REPO_ACTIONS,
  SERVER_ACTIONS,
  STALE_LISTING_MS,
} from "../listener/policies.mjs";
import { createPermissions } from "../listener/permissions.mjs";
import { validRepo } from "../listener/repo-config.mjs";
import { builtInPolicies } from "../policy-service/engine.mjs";
import { opaBinary } from "../policy-service/opa.mjs";
import { hasOpa, localService, policyEngineOf } from "./helpers.mjs";

const noOpa = !hasOpa() && "no opa on the PATH";

// A grants folder's access.rego, with `bindings` only.
const bindings = (list) => `package deckhand\n\nbindings := ${JSON.stringify(list, null, 2)}\n`;

// The repositories GitHub knows: name → { private, policies: name → text, branch, down (true: 502,
// or the status every path answers), infoDown (true: GET /repos/{repo} alone answers 502),
// renamed:
// the name GitHub answers with }, their
// policies on their default branch (`branch`, `main` by default) alone; `calls`, the paths asked.
function fakeGithub(repos) {
  const calls = [];
  // sha → text, a blob per file listed.
  const blobs = new Map();
  const github = async (_repo, _method, url) => {
    const [path, query = ""] = url.split("?");
    calls.push(path);
    const at = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(path);
    const repo = at && repos[at[1].toLowerCase()];
    if (!repo) return new Response("{}", { status: 404 });
    if (repo.down) return new Response("{}", { status: repo.down === true ? 502 : repo.down });
    if (!at[2]) {
      if (repo.infoDown) return new Response("{}", { status: 502 });
      const branch = repo.branch ?? "main";
      const full = repo.renamed ?? at[1];
      return Response.json({ full_name: full, private: repo.private, default_branch: branch });
    }
    const files = Object.entries(repo.policies ?? {});
    if (at[2] === "/contents/.deckhand/policy") {
      const ref = new URLSearchParams(query).get("ref");
      if (!files.length || ref !== (repo.branch ?? "main")) {
        return new Response("{}", { status: 404 });
      }
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
// policy service got, `bodies`, what they sent.
function realAccess(t, { operator = {}, repos = {}, now = Date.now, config = {} } = {}) {
  const { github, calls } = fakeGithub(repos);
  const local = localService(
    policyEngineOf(t, {
      opa: opaBinary(),
      readBuiltIn: () => builtInPolicies(),
      readOperator: () => new Map(Object.entries(operator)),
    }),
  );
  const bodies = [];
  const service = {
    ...local,
    evaluateAccess: (body) => (bodies.push(body), local.evaluateAccess(body)),
  };
  const policies = createPolicies({ config, github, service, now });
  return { policies, calls, asked: () => bodies.length, bodies };
}

// The Rego block after `<!-- <marker>: test/access-rules.test.mjs … -->` in docs/<file>.
function docsBlock(file, marker) {
  const docs = readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8");
  const at = docs.indexOf(`<!-- ${marker}: test/access-rules.test.mjs`);
  assert.ok(at >= 0, `no ${marker} block in docs/${file}`);
  return /```rego\n([\s\S]*?)```/.exec(docs.slice(at))[1];
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
  // A pattern asked is all of it: a narrower deny refuses it, a narrower allow doesn't give it.
  const work = { ...answer, denied: [{ ...answer.denied[0], action: "runs:start:work" }] };
  assert.ok(!allows(work, "runs:start:*"));
  assert.ok(allows(work, "runs:start:brainstorm"));
  assert.ok(!allows({ ...answer, actions: ["runs:start:work"], denied: [] }, "runs:start:*"));
  assert.ok(allows({ ...answer, actions: ["runs:*"], denied: [] }, "runs:start:*"));
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
          { users: ["erin"], actions: ["*"] },
          { users: ["hal"], repos: ["acme/api"], actions: ["*"] },
          { users: ["ida"], repos: ["*/*"], actions: ["*"] },
          { users: ["frank"], repos: ["acme/api"], role: "viewer", actions: ["logs:read"] },
          { users: ["gus"], repos: ["acme/api"], role: "viwer" },
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
    // A binding's `*` gives every server action; its role and its own actions both count; an
    // unknown role, nothing.
    assert.deepEqual(await actions("erin", null), ["*"]);
    assert.ok(await policies.can("erin", null, "server:sync"));
    // Limited to some repositories, its `*` is theirs: no server action.
    assert.deepEqual(await actions("hal", null), []);
    assert.ok(!(await policies.can("hal", null, "server:read")));
    assert.deepEqual(await actions("hal", repo("acme/api")), ["*"]);
    assert.ok(await policies.can("hal", repo("acme/api"), "runs:start:work"));
    assert.deepEqual(await actions("ida", null), ["*"]);
    assert.deepEqual(await actions("frank", repo("acme/api")), ["logs:read", "tasks:read"]);
    assert.deepEqual(await actions("gus", repo("acme/api")), []);
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
    // The kept answer is read-only: a caller can't change the next one's.
    const kept = await policies.access("bob", repo("acme/api"));
    assert.ok(Object.isFrozen(kept) && Object.isFrozen(kept.actions));
    assert.throws(() => kept.actions.push("repo:config:read"), TypeError);
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
    const text = docsBlock("repo-config.md", "access.rego");
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

test(
  "the real opa: docs/setup.md's bindings give what its migration notes say",
  { skip: noOpa },
  async (t) => {
    const text = docsBlock("setup.md", "migration access.rego");
    const { policies } = realAccess(t, { operator: { "access.rego": text } });
    const actions = async (login, where) => (await policies.access(login, where)).actions;
    assert.ok((await actions("alice", repo("other/repo"))).includes("repo:config:read"));
    assert.ok(await policies.can("alice", null, "server:read"));
    assert.deepEqual(await actions("bob", repo("acme/api")), [
      "logs:read",
      "runs:manage",
      "runs:start:*",
      "tasks:read",
    ]);
    assert.deepEqual(await actions("bob", repo("other/repo")), []);
    assert.deepEqual(await actions("bob", null), []);
    assert.deepEqual(await actions("carol", repo("acme/web")), ["logs:read", "tasks:read"]);
    assert.deepEqual(await actions("carol", repo("acme/api")), []);
    assert.ok(await policies.can("dan", repo("acme/api"), "runs:start:review"));
    assert.ok(!(await policies.can("dan", repo("acme/api"), "runs:start:work")));
    assert.ok(!(await policies.can("dan", repo("acme/api"), "logs:read")));
    // Nobody the bindings name: nothing.
    assert.deepEqual(await actions("erin", repo("acme/api")), []);
  },
);

test(
  "the real opa: docs/repo-config.md's repository deny_access narrows what Deckhand's default gives",
  { skip: noOpa },
  async (t) => {
    const text = docsBlock("repo-config.md", "repository deny_access");
    const repos = { "acme/api": { policies: { "access.rego": text } } };
    const { policies } = realAccess(t, { repos });
    assert.ok(await policies.can("alice", repo("acme/api"), "runs:start:work"));
    assert.ok(!(await policies.can("carol", repo("acme/api"), "runs:start:work")));
    assert.ok(await policies.can("carol", repo("acme/api"), "runs:start:review"));
    assert.ok(!(await policies.can("alice", repo("acme/api"), "logs:read")));
    assert.ok(await policies.can("carol", repo("acme/api"), "tasks:read"));
    // Another repository, and server-wide: untouched.
    assert.ok(await policies.can("carol", repo("acme/web"), "logs:read"));
    assert.ok(await policies.can("carol", null, "server:read"));
  },
);

const denyManage =
  'package deckhand\n\ndeny_access contains {"action": "runs:manage", "reason": "no"} if true\n';

test(
  "the real opa: a repository's default branch is read, never guessed, and what GitHub says of it kept",
  { skip: noOpa },
  async (t) => {
    const clock = { now: 1_000 };
    const repos = { "acme/api": { branch: "master", policies: { "deny.rego": denyManage } } };
    const { policies, calls } = realAccess(t, { repos, now: () => clock.now });
    const infos = () => calls.filter((p) => p === "/repos/acme/api").length;
    // Without its default branch: read, so its deny rules on `master` apply.
    assert.ok(
      !(await policies.can("bob", { full_name: "acme/api", private: true }, "runs:manage")),
    );
    assert.ok(await policies.can("bob", { full_name: "acme/api" }, "tasks:read"));
    assert.equal(infos(), 1);
    // By name: the same, read once while kept, the login in another case too.
    assert.ok(!(await policies.can("bob", "acme/api", "runs:manage")));
    assert.ok(await policies.can("Bob", "Acme/API", "tasks:read"));
    assert.equal(infos(), 1);
    // A GitHub hiccup meanwhile: the kept answer still holds.
    repos["acme/api"].down = true;
    assert.ok(await policies.can("bob", "acme/api", "tasks:read"));
    // Its push: read again, and GitHub down now gives nothing.
    policies.forget("acme/api");
    assert.match((await policies.access("bob", "acme/api")).error, /can't be read/);
    assert.equal(infos(), 2);
    repos["acme/api"].down = false;
    assert.ok(await policies.can("bob", "acme/api", "tasks:read"));
    assert.equal(infos(), 3);
    // Past ACCESS_MS, read again.
    clock.now += ACCESS_MS;
    await policies.access("bob", "acme/api");
    assert.equal(infos(), 4);
    // Past the listing's 10 minutes too, GitHub down: what it last said of the repository and
    // its listing hold, its deny rules on `master` with them (#785).
    clock.now += 11 * 60_000;
    repos["acme/api"].down = true;
    assert.ok(await policies.can("bob", "acme/api", "tasks:read"));
    assert.equal(infos(), 5);
    // Each decision asks GitHub again: a failure isn't kept.
    assert.ok(!(await policies.can("bob", "acme/api", "runs:manage")));
    assert.equal(infos(), 6);
    // A rate limit is a hiccup too.
    repos["acme/api"].down = 429;
    assert.ok(await policies.can("bob", "acme/api", "tasks:read"));
    // A 404 isn't (deleted, or out of the App's reach): nothing, rather than its listing's 404
    // read as no policy, dropping its deny rules.
    repos["acme/api"].down = 404;
    for (const action of ["tasks:read", "runs:manage"]) {
      assert.ok(!(await policies.can("bob", "acme/api", action)), action);
    }
    assert.match((await policies.access("bob", "acme/api")).error, /404/);
    // What GitHub said before goes with the 404: a hiccup next gives nothing, rather than the
    // old view of a repository GitHub said is gone.
    repos["acme/api"].down = true;
    assert.match((await policies.access("bob", "acme/api")).error, /can't be read/);
    // Nor when only GET /repos/{repo} fails, its listing answering.
    repos["acme/api"].down = false;
    repos["acme/api"].infoDown = true;
    assert.match((await policies.access("bob", "acme/api")).error, /can't be read/);
    repos["acme/api"].infoDown = false;
    // Read again, it holds through a hiccup up to STALE_LISTING_MS: past it, nothing.
    repos["acme/api"].down = false;
    assert.ok(!(await policies.can("bob", "acme/api", "runs:manage")));
    clock.now += ACCESS_MS;
    repos["acme/api"].down = true;
    assert.ok(await policies.can("bob", "acme/api", "tasks:read"));
    clock.now += STALE_LISTING_MS;
    assert.match((await policies.access("bob", "acme/api")).error, /can't be read/);
  },
);

test(
  "the real opa: a repository GitHub answers under another name keeps the name asked",
  { skip: noOpa },
  async (t) => {
    const repos = {
      "acme/old": { renamed: "other/new", policies: { "deny.rego": denyManage } },
    };
    const { policies, calls } = realAccess(t, {
      repos,
      operator: {
        "access.rego": bindings([
          { users: ["bob"], repos: ["acme/old"], role: "member" },
          { users: ["eve"], repos: ["other/new"], role: "member" },
        ]),
      },
    });
    // Bound on the name asked: its actions, its own policies listed under that name.
    assert.ok(await policies.can("bob", "acme/old", "tasks:read"));
    assert.ok(!(await policies.can("bob", "acme/old", "runs:manage")));
    assert.ok(!(await policies.can("eve", "acme/old", "tasks:read")));
    assert.ok(calls.includes("/repos/acme/old/contents/.deckhand/policy"));
    assert.ok(!calls.some((p) => p.startsWith("/repos/other/new")));
    // A push under the name asked forgets what GitHub said of it.
    policies.forget("acme/old");
    await policies.access("bob", "acme/old");
    assert.equal(calls.filter((p) => p === "/repos/acme/old").length, 2);
    // Its push's webhook says GitHub's current name: a deny pushed applies under the old one.
    assert.ok(await policies.can("bob", "acme/old", "logs:read"));
    repos["acme/old"].policies["logs.rego"] =
      'package deckhand\n\ndeny_access contains {"action": "logs:read", "reason": "no"} if true\n';
    policies.forget("Other/New");
    assert.ok(!(await policies.can("bob", "acme/old", "logs:read")));
    assert.equal(calls.filter((p) => p === "/repos/acme/old").length, 3);
  },
);

test("access over the repositories as listed: no read of each from GitHub, a single decision's read (#783)", async (t) => {
  const names = Array.from({ length: 50 }, (_, i) => `acme/r${i}`);
  const repos = Object.fromEntries(names.map((name) => [name, { private: true }]));
  const { github, calls } = fakeGithub(repos);
  // Deckhand's own policies: every action, unless a repo's deny takes one away.
  const engine = policyEngineOf(t, { readOperator: () => new Map() });
  const policies = createPolicies({ config: {}, github, service: localService(engine) });
  // As the installations were listed (repos.mjs infoOf()).
  const listed = (name) =>
    names.includes(name) ? { full_name: name, private: true, default_branch: "main" } : null;
  const permissions = createPermissions({ policies, infoOf: listed });
  const infos = () => calls.filter((p) => /^\/repos\/[^/]+\/[^/]+$/.test(p)).length;
  const seen = await permissions.which("bob", names, null, { listed: true });
  assert.equal(seen.size, names.length);
  const shown = await permissions.dashboard("bob", names);
  assert.equal(Object.keys(shown.repos).length, names.length);
  // Their policy folders listed once each, and nothing else.
  assert.equal(infos(), 0);
  assert.equal(calls.filter((p) => p.endsWith("/contents/.deckhand/policy")).length, names.length);
  await permissions.which("bob", names, "runs:manage", { listed: true });
  assert.equal(infos(), 0);
  // Without `listed` (a log stream's check): read by name, as a single decision is.
  assert.equal((await permissions.which("bob", ["acme/r3"], "logs:read")).size, 1);
  assert.equal(infos(), 1);
  // A single decision reads the repository by name, fresher than a listing; one not listed
  // (installed since) is read by name too.
  assert.equal(await permissions.can("bob", "acme/r2", "runs:manage"), true);
  assert.equal(infos(), 2);
  repos["acme/new"] = {};
  assert.equal((await permissions.which("bob", ["acme/new"], null, { listed: true })).size, 1);
  assert.equal(infos(), 3);
});

test(
  "the real opa: a repository as listed has its deny rules read on the default branch listed",
  { skip: noOpa },
  async (t) => {
    const repos = {
      "acme/api": { branch: "master", policies: { "deny.rego": denyManage } },
      "acme/web": {},
    };
    const { policies, calls } = realAccess(t, { repos });
    const listed = (name) =>
      repos[name] && {
        full_name: name,
        private: true,
        default_branch: repos[name].branch ?? "main",
      };
    const permissions = createPermissions({ policies, infoOf: listed });
    const shown = await permissions.dashboard("bob", ["acme/api", "acme/web"]);
    assert.ok(!shown.repos["acme/api"].actions.includes("runs:manage"));
    assert.ok(shown.repos["acme/web"].actions.includes("runs:manage"));
    const managed = await permissions.which("bob", ["acme/api", "acme/web"], "runs:manage", {
      listed: true,
    });
    assert.deepEqual([...managed], ["acme/web"]);
    assert.ok(!calls.some((p) => p === "/repos/acme/api" || p === "/repos/acme/web"));
  },
);

test("access: a repo's policies kept per default branch, a listed one and a read one not evicting each other", async (t) => {
  // GitHub says `trunk` now; the listing, from before the move, still says `main`.
  const repos = { "acme/api": { branch: "trunk" } };
  const { github, calls } = fakeGithub(repos);
  const engine = policyEngineOf(t, { readOperator: () => new Map() });
  const policies = createPolicies({ config: {}, github, service: localService(engine) });
  const listed = { full_name: "acme/api", private: true, default_branch: "main" };
  const listings = () => calls.filter((p) => p.endsWith("/contents/.deckhand/policy")).length;
  for (let i = 0; i < 3; i++) {
    await policies.access("bob", listed);
    await policies.access("bob", "acme/api");
  }
  assert.equal(listings(), 2);
  // A push forgets both.
  policies.forget("acme/api");
  await policies.access("bob", listed);
  await policies.access("bob", "acme/api");
  assert.equal(listings(), 4);
});

test("access: a repository's name is owner/repo, nothing GitHub's paths would read otherwise", async (t) => {
  const { github, calls } = fakeGithub({ "acme/y": {} });
  const engine = policyEngineOf(t, { readOperator: () => new Map() });
  const policies = createPolicies({ config: {}, github, service: localService(engine) });
  for (const name of ["acme/x/../y", "acme/..", "acme/y?ref=x", "acme", "./y", "acme/y/z"]) {
    const answer = await policies.access("bob", name);
    assert.match(answer.error, /no repository's name/, name);
    const info = await policies.access("bob", { full_name: name, default_branch: "main" });
    assert.match(info.error, /no repository's name/, name);
  }
  assert.deepEqual(calls, []);
  assert.ok(validRepo("acme/my-repo.js"));
  assert.ok(!validRepo("acme/.."));
  assert.ok(!validRepo(`acme/${"x".repeat(101)}`));
});

test("allows: `*` asked server-wide is every server action", () => {
  const answer = { actions: ["*"], denied: [], files: {}, error: null };
  assert.ok(allows(answer, "*", false));
  assert.ok(!allows({ ...answer, actions: ["server:read"] }, "*", false));
  const sync = [{ action: "server:sync", reason: "no", file: null, layer: "operator" }];
  assert.ok(!allows({ ...answer, denied: sync }, "*", false));
  assert.ok(allows({ ...answer, denied: sync }, "*"));
});

test("allows: a deny of the other scope's actions doesn't refuse a pattern", () => {
  const answer = {
    actions: ["*"],
    denied: [{ action: "server:sync", reason: "no", file: null, layer: "operator" }],
    files: {},
    error: null,
  };
  assert.ok(allows(answer, "*"));
  assert.ok(allows(answer, "runs:*"));
  assert.ok(!allows(answer, "server:*", false));
  assert.ok(allows(answer, "server:read", false));
  const repoDeny = { ...answer, denied: [{ ...answer.denied[0], action: "runs:manage" }] };
  assert.ok(!allows(repoDeny, "*"));
  assert.ok(allows(repoDeny, "server:*", false));
});

test("allows: a deny of `*` refuses everything, server-wide too", () => {
  const answer = {
    actions: ["*"],
    denied: [{ action: "*", reason: "no", file: null, layer: "operator" }],
    files: {},
    error: null,
  };
  for (const action of ["server:read", "server:sync", "server:*"]) {
    assert.ok(!allows(answer, action, false), action);
  }
  for (const action of ["tasks:read", "runs:start:*", "*"]) assert.ok(!allows(answer, action));
  // A prefix covering the server's actions refuses them too.
  const s = { ...answer, denied: [{ ...answer.denied[0], action: "s*" }] };
  assert.ok(!allows(s, "server:read", false));
  assert.ok(allows(s, "tasks:read"));
});

test(
  "the real opa: an operator's deny of `*` for one login takes every action away, server-wide too",
  { skip: noOpa },
  async (t) => {
    const { policies } = realAccess(t, {
      operator: {
        "mallory.rego": [
          "package deckhand",
          "",
          'deny_access contains {"action": "*", "reason": "not mallory"} if {',
          '  input.user.login == "mallory"',
          "}",
        ].join("\n"),
      },
    });
    for (const action of SERVER_ACTIONS) {
      assert.ok(!(await policies.can("mallory", null, action)), action);
      assert.ok(await policies.can("bob", null, action), action);
    }
    assert.ok(!(await policies.can("mallory", repo("acme/api"), "tasks:read")));
    assert.ok(await policies.can("bob", repo("acme/api"), "tasks:read"));
  },
);

test("knownAction: Deckhand's actions, the patterns covering them or covered by them, nothing else", () => {
  for (const action of [...REPO_ACTIONS, ...SERVER_ACTIONS]) assert.ok(knownAction(action));
  for (const action of ["*", "runs:*", "runs:start:work", "server:*", "tasks:*", "repo:*"]) {
    assert.ok(knownAction(action), action);
  }
  for (const action of ["run:start:work", "task:read", "servers:read", "tasks:write", "", null]) {
    assert.ok(!knownAction(action), String(action));
  }
});

test(
  "the real opa: the checks name the actions no rule should (#765), each once, and only when evaluating says them",
  { skip: noOpa },
  async (t) => {
    const operator = {
      "access.rego": `${bindings([
        { users: ["alice"], repos: ["acme/*"], actions: ["tasks:read", "tsks:read"] },
        { users: ["bob"], repos: ["*/*"], role: "member" },
      ])}
allow_access contains "task:read"

deny_access contains {"action": "run:start:work", "reason": "a typo"}

deny_access contains {"action": "runs:start:audit", "reason": "spelled right"}
`,
    };
    const repos = {
      "acme/api": {
        private: true,
        policies: {
          "deny.rego": `package deckhand

deny_access contains {"action": "logz:read", "reason": "public only"} if not input.repo.private

deny_access contains {"action": "runs:manage", "reason": "spelled right"}
`,
        },
      },
    };
    const { policies, asked, bodies } = realAccess(t, {
      operator,
      repos,
      config: { users: ["Alice", "bob"] },
    });
    const said = (rule, action, layer) =>
      new RegExp(
        `^\`${rule}\` of the ${layer} policies names \`${RegExp.escape(action)}\`, which isn't an action Deckhand knows`,
      );
    const matching = (warnings, ...expected) => {
      const found = warnings.filter((w) => w.includes("isn't an action Deckhand knows"));
      assert.equal(found.length, expected.length, found.join("\n"));
      for (const re of expected)
        assert.ok(
          found.some((w) => re.test(w)),
          `${re}: ${found}`,
        );
    };
    // At start, server-wide: the rules said whatever the repository; a binding's action only
    // counts on one.
    const start = await policies.checkOperator();
    assert.deepEqual(start.errors, []);
    matching(
      start.warnings,
      said("allow_access", "task:read", "operator's"),
      said("deny_access", "run:start:work", "operator's"),
    );
    assert.match(
      start.warnings.find((w) => /run:start/.test(w)),
      /it takes nothing away$/,
    );
    // The config panel of a repository (repos.mjs policyView()): the binding's too, and the
    // repository's deny that only applies were it public. describe() doesn't evaluate them: the
    // dry run doesn't show its warnings.
    assert.equal(
      (await policies.describe("acme/api", "main")).warnings.filter((w) =>
        w.includes("isn't an action Deckhand knows"),
      ).length,
      0,
    );
    const before = asked();
    // Two calls: server-wide, the operator's layer alone; on the repository, both.
    const panel = await policies.accessNameWarnings("acme/api", "main");
    assert.equal(asked(), before + 2);
    // Server-wide, never the repository's rules, as access() asks them.
    const [wide, on] = bodies.slice(before);
    assert.ok(Object.values(wide.inputs).every((i) => i.repo === null));
    assert.equal(wide.repo, null);
    assert.ok(Object.values(on.inputs).every((i) => i.repo?.name === "acme/api"));
    assert.equal(on.repo.length, 1);
    matching(
      panel,
      said("allow_access", "task:read", "operator's"),
      said("allow_access", "tsks:read", "operator's"),
      said("deny_access", "run:start:work", "operator's"),
      said("deny_access", "logz:read", "repository's"),
    );
    // Kept for the same files: the panel's next load asks nothing.
    assert.deepEqual(await policies.accessNameWarnings("acme/api", "main"), panel);
    assert.equal(asked(), before + 2);
    // The onboarding check: the repository's own rules alone.
    const checked = await policies.checkRepo("acme/api", "main");
    assert.deepEqual(checked.errors, []);
    matching(checked.warnings, said("deny_access", "logz:read", "repository's"));
  },
);

test(
  "the real opa: Deckhand's files alone, or rules that don't compile, say no action and ask nothing more",
  { skip: noOpa },
  async (t) => {
    const plain = realAccess(t, { config: { users: ["alice"] } });
    assert.deepEqual(await plain.policies.checkOperator(), { errors: [], warnings: [] });
    assert.equal(plain.asked(), 0);
    const broken = realAccess(t, {
      repos: {
        "acme/api": {
          policies: { "deny.rego": "package deckhand\n\ndeny_access contains x if {\n" },
        },
      },
    });
    const checked = await broken.policies.checkRepo("acme/api", "main");
    assert.equal(checked.errors.length, 1);
    assert.equal(broken.asked(), 0);
    // A repository's allow rule is an error, ignored: its deny rules are checked all the same.
    const ignored = realAccess(t, {
      repos: {
        "acme/api": {
          policies: {
            "access.rego":
              'package deckhand\n\nallow_access contains "tsks:read"\n\ndeny_access contains {"action": "logz:read", "reason": "x"}\n',
          },
        },
      },
    });
    const both = await ignored.policies.checkRepo("acme/api", "main");
    assert.equal(both.errors.length, 1);
    assert.deepEqual(
      both.warnings.filter((w) => w.includes("isn't an action")).map((w) => w.split(",")[0]),
      ["`deny_access` of the repository's policies names `logz:read`"],
    );
  },
);

test("knownMode: a `runs:start:` action names Deckhand's modes or the repository's, the others aren't asked", () => {
  const modes = ["deploy"];
  for (const action of [
    "runs:start:work",
    "runs:start:review",
    "runs:start:deploy",
    "runs:start:*",
    "runs:start:re*",
    "runs:start:dep*",
    "runs:*",
    "*",
    "tasks:read",
  ]) {
    assert.ok(knownMode(action, modes), action);
  }
  for (const action of ["runs:start:wrok", "runs:start:Work", "runs:start:x*", "runs:start:"]) {
    assert.ok(!knownMode(action, modes), action);
  }
  // A repository's own mode, only where it has it; without its modes, nothing is said.
  assert.ok(!knownMode("runs:start:deploy", []));
  assert.ok(knownMode("runs:start:wrok", null));
});

test(
  "the real opa: a repository's deny of a mode it doesn't have is said, the operator's never (#837)",
  { skip: noOpa },
  async (t) => {
    const deny = (action) => `deny_access contains {"action": "${action}", "reason": "x"}`;
    const { policies } = realAccess(t, {
      operator: { "modes.rego": `package deckhand\n\n${deny("runs:start:elsewhere")}\n` },
      repos: {
        "acme/api": {
          policies: {
            "deny.rego": [
              "package deckhand",
              ...["runs:start:wrok", "runs:start:deploy", "runs:start:work", "runs:start:x*"].map(
                deny,
              ),
            ].join("\n\n"),
          },
        },
      },
      config: { users: ["alice"] },
    });
    const modesSaid = (warnings) =>
      warnings
        .filter((w) => w.includes("which starts no mode it has"))
        .map((w) => w.split(",")[0])
        .sort();
    const at = (action) => `\`deny_access\` of the repository's policies names \`${action}\``;
    // The onboarding check, with the branch's modes: `deploy` is one of them.
    const checked = await policies.checkRepo("acme/api", "main", { modes: ["deploy"] });
    assert.deepEqual(checked.errors, []);
    assert.deepEqual(modesSaid(checked.warnings), [at("runs:start:wrok"), at("runs:start:x*")]);
    assert.match(
      checked.warnings.find((w) => w.includes("runs:start:wrok")),
      /\(`work`, .*`deploy`\): it takes nothing away$/,
    );
    // The config panel: the repository without `deploy`, the operator's rule left alone (it may
    // name another repository's mode).
    const panel = await policies.accessNameWarnings("acme/api", "main", []);
    assert.deepEqual(modesSaid(panel), [
      at("runs:start:deploy"),
      at("runs:start:wrok"),
      at("runs:start:x*"),
    ]);
    // Without the modes, as before.
    assert.deepEqual(modesSaid((await policies.checkRepo("acme/api", "main")).warnings), []);
  },
);

test("the access actions' check: a mismatch reads the layers again, once (#765)", async () => {
  // A service whose operator layer isn't Deckhand's alone (no shortcut), answering its first
  // `mismatch` answers so, then the rules' value: `deny_access` naming `run:start:work`.
  const service = (mismatches) => {
    const events = [];
    let left = mismatches;
    return {
      events,
      policies: async () => (
        events.push("read"),
        {
          deckhand: [["access.rego", 'package deckhand\n\nallow_access contains "*"\n']],
          operator: [["typo.rego", "package deckhand\n"]],
        }
      ),
      compile: async () => ({ errors: [] }),
      evaluateAccess: async ({ inputs }) => {
        events.push("evaluate");
        if (left-- > 0) return { error: "not the operator's layer read", mismatch: true };
        const rules = {
          allow: [["*"]],
          deny: [[{ action: "run:start:work", reason: "a typo" }]],
        };
        return {
          results: Object.fromEntries(
            Object.keys(inputs).map((k) => [k, { operator: { all: rules, files: {} } }]),
          ),
        };
      },
    };
  };
  const typo = /^`deny_access` of the operator's policies names `run:start:work`/;
  const once = service(1);
  const policies = createPolicies({ config: { users: ["alice"] }, github: null, service: once });
  const { errors, warnings } = await policies.checkOperator();
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], typo);
  // The check's own read, then the access rules': read, mismatch, read again, answered.
  assert.deepEqual(once.events.slice(1), ["read", "evaluate", "read", "evaluate"]);
  // Twice: nothing said, and no third evaluation.
  const twice = service(2);
  const again = createPolicies({ config: { users: ["alice"] }, github: null, service: twice });
  assert.deepEqual((await again.checkOperator()).warnings, []);
  assert.equal(twice.events.filter((e) => e === "evaluate").length, 2);
  assert.deepEqual(twice.events.slice(1), ["read", "evaluate", "read", "evaluate"]);
});
