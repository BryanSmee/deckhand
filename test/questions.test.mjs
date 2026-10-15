import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { hasOpenQuestions, inputEvent, questionsSection } from "../listener/questions.mjs";

// Real issue bodies: #77 and #79 (filed by an inbox run, questions pending), #67 ("None").
const body = (n) => readFileSync(new URL(`fixtures/issue-${n}.md`, import.meta.url), "utf8");
const config = loadConfig({ ALLOWED_USERS: "alice,bob", ALLOWED_REPOS: "org/repo" });
const BOT = "deckhand-x[bot]";

test("open questions in real issues: #77 and #79 ask, #67 says None", () => {
  assert.equal(hasOpenQuestions(body(77)), true);
  assert.equal(hasOpenQuestions(body(79)), true);
  assert.equal(hasOpenQuestions(body(67)), false);
  assert.match(questionsSection(body(79)), /^1\. \*\*Command name\*\*/);
});

test("open questions: None, its variants and the inbox link after it", () => {
  const inbox = "\n\nFrom the ideas inbox: https://github.com/org/repo/issues/15#issuecomment-1\n";
  assert.equal(hasOpenQuestions(`## Open questions\n\nNone.${inbox}`), false);
  for (const none of ["None", "- None", "_None._", "**None**", "N/A", "No open questions."]) {
    assert.equal(hasOpenQuestions(`## Open questions\n\n${none}\n`), false, none);
  }
  assert.equal(hasOpenQuestions(`## Open questions\n\n1. Which name?${inbox}`), true);
  // Any heading level, a colon, a hand-written intro before the list.
  assert.equal(hasOpenQuestions("### Open Questions:\n\nTwo things:\n\n- A?\n- B?"), true);
  // Empty, only a comment, or no such section.
  assert.equal(hasOpenQuestions("## Open questions\n\n## Next\n\nText"), false);
  assert.equal(hasOpenQuestions("## Open questions\n<!-- none yet -->\n"), false);
  assert.equal(hasOpenQuestions("## Problem\n\nIt breaks.\n"), false);
  assert.equal(hasOpenQuestions(null), false);
  // A heading in a code block isn't one; a deeper heading stays in the section.
  assert.equal(hasOpenQuestions("```\n## Open questions\n1. x\n```\n"), false);
  assert.equal(
    questionsSection("## Open questions\n\n### A\n\n1. x\n\n## B\n\ny"),
    "### A\n\n1. x",
  );
});

// An `issues` delivery on org/repo by `user`; `sender` defaults to them.
function issues(action, { user = "alice", type = "User", text = "", labels = [], ...more } = {}) {
  return {
    action,
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    issue: {
      number: 12,
      title: "An idea",
      state: "open",
      body: text,
      user: { login: user, type },
      labels: labels.map((name) => ({ name })),
    },
    sender: { login: user, type },
    ...more,
  };
}
const asks = "## Open questions\n\n1. Which one?";
const none = "## Open questions\n\nNone.";
const map = (action, opts, event = "issues", cfg = config) =>
  inputEvent(cfg, event, issues(action, opts), BOT);

test("an issue opened with open questions, by an allowed user or the App's bot, is labelled", () => {
  const change = { repo: "org/repo", key: "org/repo#12", number: 12, title: "An idea" };
  assert.deepEqual(map("opened", { text: asks }), {
    ...change,
    base: "trunk",
    label: true,
    by: "alice",
    track: true,
  });
  // The bot's (an inbox run's): no user to check against the repo's.
  assert.equal(map("opened", { text: asks, user: BOT, type: "Bot" }).by, null);
  assert.equal(map("opened", { text: none }), null);
  assert.equal(map("opened", { text: "No section" }), null);
  // Opened with the label already: only listed.
  assert.deepEqual(map("opened", { text: asks, labels: ["Needs-Input"] }).label, undefined);
  assert.equal(map("opened", { text: asks, labels: ["needs-input"] }).track, true);
});

test("issues by others, on other repos, or with the label turned off are ignored", () => {
  assert.equal(map("opened", { text: asks, user: "mallory" }), null);
  assert.equal(map("opened", { text: asks, user: "other[bot]", type: "Bot" }), null);
  // A bot named like an allowed user isn't one.
  assert.equal(map("opened", { text: asks, user: "alice", type: "Bot" }), null);
  const elsewhere = issues("opened", { text: asks });
  elsewhere.repository.full_name = "org/other";
  assert.equal(inputEvent(config, "issues", elsewhere, BOT), null);
  const noApp = issues("opened", { text: asks });
  delete noApp.installation;
  assert.equal(inputEvent(config, "issues", noApp, BOT), null);
  const off = loadConfig({ ALLOWED_USERS: "alice", NEEDS_INPUT_LABEL: "" });
  assert.equal(map("opened", { text: asks }, "issues", off), null);
});

test("editing the section moves the label; other edits don't", () => {
  const edit = (from, to, labels, sender = { login: "bob", type: "User" }) =>
    map("edited", { text: to, labels, sender, changes: { body: { from } } });
  assert.equal(edit(none, asks, []).label, true);
  assert.equal(edit(none, asks, []).by, "bob");
  assert.equal(edit(asks, none, ["needs-input"]).label, false);
  assert.equal(edit(asks, none, ["needs-input"]).track, false);
  assert.equal(edit(asks, "Rewritten without it", ["needs-input"]).label, false);
  // Already as it should be.
  assert.equal(edit(none, asks, ["needs-input"]), null);
  // The section unchanged: a label removed by hand, or put by a run, stays as it is.
  assert.equal(edit(`Typo${asks}`, `Fixed${asks}`, []), null);
  assert.equal(edit("Typo", "Fixed", ["needs-input"]), null);
  // A title edit, or an edit by someone not allowed.
  assert.equal(map("edited", { text: asks, changes: { title: { from: "x" } } }), null);
  assert.equal(edit(none, asks, [], { login: "mallory", type: "User" }), null);
  assert.equal(edit(none, asks, [], { login: BOT, type: "Bot" }).by, null);
});

test("the dashboard follows the label, added or removed by anyone, and closed issues", () => {
  const label = (action, name, more) => map(action, { label: { name }, ...more });
  assert.equal(label("labeled", "needs-input", { user: "mallory" }).track, true);
  assert.equal(label("unlabeled", "needs-input").track, false);
  assert.equal(label("labeled", "bug"), null);
  assert.equal(map("closed").track, false);
  assert.equal(map("deleted").track, false);
  assert.equal(map("reopened", { labels: ["needs-input"] }).track, true);
  assert.equal(map("reopened"), null);
  assert.equal(map("assigned"), null);
  for (const change of [map("closed"), label("labeled", "needs-input")]) {
    assert.equal(change.label, undefined);
  }
});

test("an allowed user's comment on a labelled issue takes the label off; Deckhand's don't", () => {
  const comment = (user, { labels = ["needs-input"], text = "1. A", pull = false } = {}) => {
    const p = issues("created", { labels });
    p.comment = {
      id: 9,
      body: text,
      user: { login: user, type: user.endsWith("]") ? "Bot" : "User" },
    };
    if (pull) p.issue.pull_request = { url: "x" };
    return inputEvent(config, "issue_comment", p, BOT);
  };
  assert.deepEqual(
    { label: comment("alice").label, by: comment("alice").by, track: comment("alice").track },
    { label: false, by: "alice", track: false },
  );
  assert.equal(comment("alice", { labels: [] }), null);
  assert.equal(comment("mallory"), null);
  assert.equal(comment(BOT), null);
  assert.equal(comment("alice", { text: "Answer <!-- deckhand -->" }), null);
  // On a pull request: off, but not listed (a pull request's task key isn't its number).
  const pr = comment("alice", { pull: true });
  assert.equal(pr.label, false);
  assert.equal(pr.track, undefined);
  assert.equal(pr.title, null);
});
