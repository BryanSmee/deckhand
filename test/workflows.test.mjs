import assert from "node:assert/strict";
import { test } from "node:test";
import { branchConfigReport } from "../listener/onboarding.mjs";
import { createWorkflows } from "../listener/workflows.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig();
const LIST = "GET /repos/org/app/contents/.deckhand/workflows?ref=main";
const REBASE = "on: conflict\nsteps:\n  - run: rebase\n";

// GitHub with `routes` ("METHOD path" → [status, body] or a function of nothing), the files of
// a listing answered by their blobs (`blobs`: sha → text). Unknown paths answer 404.
function fakeGitHub(routes, blobs = {}) {
  const calls = [];
  const github = async (repo, method, path) => {
    calls.push(`${method} ${path}`);
    const blob = /\/git\/blobs\/(.+)$/.exec(path)?.[1];
    const route = blob
      ? [200, { content: Buffer.from(blobs[blob]).toString("base64"), encoding: "base64" }]
      : typeof routes[`${method} ${path}`] === "function"
        ? routes[`${method} ${path}`]()
        : (routes[`${method} ${path}`] ?? [404, {}]);
    return new Response(JSON.stringify(route[1]), { status: route[0] });
  };
  return { github, calls };
}

const entry = (name, sha = name) => ({ type: "file", name, sha });

test("a repo's workflows: listed once until its default branch moves, each blob read once", async () => {
  let listed = [entry("conflicts.yaml", "s1"), entry("notes.md"), entry("old.yml")];
  const { github, calls } = fakeGitHub({ [LIST]: () => [200, listed] }, { s1: REBASE, s2: REBASE });
  let time = 0;
  const workflows = createWorkflows({ github, now: () => time });
  const read = await workflows.read("org/app", "main", {});
  assert.deepEqual(
    read.workflows.map((w) => w.name),
    ["conflicts"],
  );
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.warnings, [
    "`.deckhand/workflows/old.yml`: ignored, a workflow's file ends in .yaml",
  ]);
  const { workflow } = await workflows.forEvent("org/app", "main", {}, "conflict");
  assert.equal(workflow.file, ".deckhand/workflows/conflicts.yaml");
  assert.equal(calls.filter((c) => c === `${LIST}`).length, 1);
  // A push to main: listed again, the blob already parsed not read again.
  listed = [entry("conflicts.yaml", "s1"), entry("more.yaml", "s2")];
  workflows.forget("Org/App");
  const both = await workflows.read("org/app", "main", {});
  assert.equal(calls.filter((c) => c === LIST).length, 2);
  assert.equal(calls.filter((c) => c.includes("/git/blobs/s1")).length, 1);
  // Two on `conflict`: no workflow runs, whichever.
  assert.match(both.errors[0].message, /two triggers for `conflict`/);
  const refused = await workflows.forEvent("org/app", "main", {}, "conflict");
  assert.equal(refused.workflow, null);
  assert.match(refused.errors[0], /^`\.deckhand\/workflows\/more\.yaml` line 1: two triggers/);
  // The listing expires on its own too.
  time += 11 * 60_000;
  await workflows.read("org/app", "main", {});
  assert.equal(calls.filter((c) => c === LIST).length, 3);
});

test("without a folder, the built-in workflow runs on `conflict`; GitHub failing throws", async () => {
  const { github } = fakeGitHub({});
  const workflows = createWorkflows({ github });
  const { workflow, errors } = await workflows.forEvent("org/app", "main", {}, "conflict");
  assert.deepEqual([workflow.name, errors], ["built-in", []]);
  const failing = createWorkflows({ github: fakeGitHub({ [LIST]: [502, {}] }).github });
  await assert.rejects(failing.read("org/app", "main", {}), /502/);
});

test("the onboarding pull request's report says its workflows' errors", async () => {
  const branch = "issue-30-deckhand-config";
  const { github } = fakeGitHub(
    {
      "GET /repos/org/app/pulls?state=open&per_page=100": [
        200,
        [{ number: 31, head: { ref: branch, repo: { full_name: "org/app" } }, body: "Closes #30" }],
      ],
      [`GET /repos/org/app/contents/.deckhand.yaml?ref=${branch}`]: [
        200,
        {
          type: "file",
          sha: "x",
          content: Buffer.from("review:\n  on: ready\n").toString("base64"),
        },
      ],
      [`GET /repos/org/app/contents/.deckhand/workflows?ref=${branch}`]: [
        200,
        [entry("ready.yaml", "r")],
      ],
    },
    { r: "on: ready\nsteps:\n  - comment: hi\n" },
  );
  const workflows = createWorkflows({ github });
  const report = await branchConfigReport(github, config, "org/app", 30, null, workflows);
  assert.match(report, /has errors/);
  assert.match(
    report,
    /- ❌ `\.deckhand\/workflows\/ready\.yaml` line 1: two triggers for `ready`: this workflow and the built-in review loop/,
  );
});
