// Which mode a comment runs in, and the reply when its "/mode" line names none the repo has.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createTaskModes } from "../listener/task-modes.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig();

// modeOf() for a comment on org/repo#12 with the repo's `yaml`: what it ran, and the replies.
async function modeOf(fields, yaml = "") {
  const replies = [];
  const ctx = {
    config,
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {} },
    reply: async (repo, number, text) => replies.push([repo, number, text]),
  };
  const { settings } = parseRepoConfig(yaml, config);
  const item = { repo: "org/repo", id: "12", number: 12, replyTo: 12, settings, ...fields };
  const { modeOf } = createTaskModes(ctx);
  return { mode: await modeOf(item, "org/repo#12", "deckhand-org-repo-12"), replies };
}

test("/mode with a name the repo doesn't have: a reply listing its modes, no run", async () => {
  const { mode, replies } = await modeOf({ trigger: "work", modeLine: "foo" });
  assert.equal(mode, null);
  assert.deepEqual(replies, [
    [
      "org/repo",
      12,
      "Unknown mode `foo`. The modes here: `work`, `brainstorm`, `onboarding`. Pick one with a `/mode <name>` line.",
    ],
  ]);
  // The repo's own modes are listed too, a light one as comments only.
  const modes = "modes:\n  review:\n    instructions: .deckhand/review.md\n    light: true\n";
  const own = await modeOf({ trigger: "work", modeLine: "reveiw" }, modes);
  assert.equal(own.mode, null);
  assert.match(
    own.replies[0][2],
    /^Unknown mode `reveiw`\. The modes here: `work`, `brainstorm`, `onboarding`, `review` \(comments only\)\./,
  );
  assert.equal((await modeOf({ trigger: "work", modeLine: "review" }, modes)).mode, "review");
});
