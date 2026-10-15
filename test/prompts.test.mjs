import assert from "node:assert/strict";
import { test } from "node:test";
import { DISCUSSION_PERMISSIONS, READ_ONLY_PERMISSIONS } from "../listener/github-app.mjs";
import { isFresh, isLight, kindOf, permissionsFor } from "../listener/modes.mjs";
import { firstMessage, liveMessage, promptFor } from "../listener/prompts.mjs";

const settings = {
  model: "opus",
  effort: "high",
  brainstormModel: "sonnet",
  brainstormEffort: "low",
  trigger: "Deckhand",
  modes: {
    review: { light: true, instructions: "docs/review.md" },
    triage: { session: "fresh", instructions: "docs/triage.md" },
  },
};
const issue = { repo: "org/repo", kind: "issue", number: 12, base: "main", settings };
const pr = { ...issue, kind: "pr", number: 13 };
const config = {
  users: ["alice"],
  hosts: [],
  githubUrl: "https://github.com",
  githubApi: "https://api.github.com",
};
const grant = { hosts: ["registry.npmjs.org"], mounts: [{ root: "/srv/data", readOnly: false }] };

test("modes: light, fresh and the dashboard's kind, built-in or the repo's own", () => {
  assert.equal(isLight(issue, "brainstorm"), true);
  assert.equal(isLight(issue, "discussion"), true);
  assert.equal(isLight(issue, "review"), true);
  assert.equal(isLight(issue, "work"), false);
  assert.equal(isLight(issue, "triage"), false);
  assert.equal(isFresh(issue, "idea"), true);
  assert.equal(isFresh(issue, "triage"), true);
  assert.equal(isFresh(issue, "discussion"), false);
  assert.equal(kindOf("stop", "issue"), "brainstorm");
  assert.equal(kindOf("bug", "issue"), "bug");
  assert.equal(kindOf("review", "pr"), "pr");
});

test("modes: discussions may write them, onboarding and light repo modes only read", () => {
  assert.equal(permissionsFor("discussion", true), DISCUSSION_PERMISSIONS);
  assert.equal(permissionsFor("onboarding", true), READ_ONLY_PERMISSIONS);
  assert.equal(permissionsFor("review", true), READ_ONLY_PERMISSIONS);
  // Brainstorms keep the sandbox's usual token, as before repo modes.
  assert.equal(permissionsFor("brainstorm", true), undefined);
  assert.equal(permissionsFor("work", false), undefined);
});

test("prompts: each kind of run gets its own", () => {
  const prompt = (task, mode, extra = {}) =>
    promptFor(task, { mode, text: "the comments", settings, config, grant, ...extra });
  assert.match(prompt(issue, "work"), /^Work on GitHub issue #12 of org\/repo until it is ready/);
  assert.match(prompt(issue, "work"), /`issue-12-<short-slug>`/);
  assert.match(prompt(pr, "work"), /^Work on pull request #13 of org\/repo: check it out/);
  assert.match(prompt(issue, "brainstorm"), /^Brainstorm GitHub issue #12/);
  assert.match(prompt(issue, "stop"), /^Brainstorm GitHub issue #12/);
  assert.match(prompt(issue, "idea"), /^New on the ideas inbox of org\/repo \(issue #12\)/);
  assert.match(prompt(issue, "idea"), /The entries, each its own:\n\nthe comments$/);
  assert.match(
    prompt(issue, "discussion"),
    /gh api graphql -F owner=org -F name=repo -F number=12/,
  );
  assert.match(
    prompt(issue, "work", { onboardingWork: true }),
    /^The maintainer confirmed the onboarding proposal/,
  );
});

test("prompts: onboarding lists what this Deckhand allows the repo", () => {
  const text = promptFor(issue, { mode: "onboarding", settings, config, grant });
  assert.match(text, /^Onboard org\/repo with the maintainer, on GitHub issue #12/);
  assert.match(text, /alone on the first line of a comment\): `Deckhand`/);
  assert.match(text, /\(`ALLOWED_USERS`; `users` can only narrow it\): `alice`/);
  assert.match(text, /Hosts the operator grants this repository: `registry.npmjs.org`/);
  assert.match(text, /Host mount roots granted to this repository: `\/srv\/data \(read-write\)`/);
  assert.match(text, /Models: work `opus` \(high effort\), brainstorms `sonnet` \(low\)/);
  assert.match(text, /## Reference: `.deckhand.yaml`/);
});

test("prompts: a repo's mode, light or not, with its instructions", () => {
  const own = { name: "review", light: true };
  const light = promptFor(pr, { mode: "review", own, instructions: "Review it.\n", settings });
  assert.match(light, /^You are in the "review" mode of this repository, on pull request #13/);
  assert.match(light, /your GitHub token can only read/);
  assert.match(light, /from the repository:\n\nReview it\.$/);
  const heavy = promptFor(issue, {
    mode: "triage",
    own: { name: "triage", light: false },
    instructions: "Triage.",
    settings,
  });
  assert.match(heavy, /commit and push to that branch\. Never\npush to main\./);
});

test("first message: brainstorms, follow-ups and new inbox sessions", () => {
  assert.equal(firstMessage({ mode: "work", text: "Do it", started: false }), "Do it");
  assert.match(
    firstMessage({ mode: "work", text: "", started: true }),
    /^Continue\.\n\n\(Don't post comments on GitHub yourself/,
  );
  assert.equal(firstMessage({ mode: "idea", text: "An idea", started: false }), "");
  assert.match(
    firstMessage({ mode: "brainstorm", text: "Hm", restored: true, started: false }),
    /^Hm\n\n\(The brainstorm resumes after a pause/,
  );
  assert.match(
    firstMessage({ mode: "stop", text: "", started: true }),
    /^The maintainer ends the brainstorm here\. Wrap up/,
  );
});

test("live messages: what Claude reads for a comment delivered mid-run", () => {
  assert.match(
    liveMessage("brainstorm", "Hi"),
    /^New comment on the issue: Hi\n\n\(Still a brainstorm/,
  );
  assert.match(liveMessage("idea", "Hi"), /^Another entry arrived on the inbox/);
  assert.match(liveMessage("discussion", "Hi"), /^New comment in the discussion/);
  assert.match(liveMessage("onboarding", "Hi"), /\(Still onboarding/);
  assert.match(liveMessage("work", "Hi"), /^New comment on this issue while you are working/);
});
