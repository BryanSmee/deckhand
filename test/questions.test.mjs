import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import {
  hasOpenQuestions,
  inputEvent,
  parseQuestions,
  questionsSection,
  replyQuestions,
} from "../listener/questions.mjs";

// Real issue bodies: #77, #79, #130 and #134 (filed by an inbox run, questions pending), #67
// ("None").
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

const free = (text, title = null) => ({ title, text, options: [] });

test("parsed questions: titles, options, the recommended one, explanation lines", () => {
  const section = [
    "1. **Phones**: chains left to right with sideways scrolling, or top to bottom on phones only?",
    "   - [ ] Left to right, scrolling sideways (recommended)",
    "   - [ ] Top to bottom on phones only",
    "2. **Link text**: what should the header link say?",
    "3. Which colour?",
    "   The header is dark in both themes.",
    "",
    "   Today it is grey.",
    "   * [x] Blue",
    "   * [ ] Green (Recommended)",
    "4. **Order:** newest first?",
  ].join("\n");
  assert.deepEqual(parseQuestions(section), {
    items: [
      {
        title: "Phones",
        text: "chains left to right with sideways scrolling, or top to bottom on phones only?",
        options: [
          { label: "Left to right, scrolling sideways", recommended: true },
          { label: "Top to bottom on phones only", recommended: false },
        ],
      },
      free("what should the header link say?", "Link text"),
      {
        title: null,
        text: "Which colour?\nThe header is dark in both themes.\nToday it is grey.",
        options: [
          { label: "Blue", recommended: false },
          { label: "Green", recommended: true },
        ],
      },
      free("newest first?", "Order"),
    ],
    raw: section,
  });
});

test("parsed questions: None, an intro and the inbox link around the list", () => {
  assert.equal(parseQuestions("None."), null);
  assert.equal(parseQuestions(""), null);
  assert.equal(parseQuestions(null), null);
  const raw = "Two things:\n\n1. A?\n2) B?\n\nFrom the ideas inbox: https://x/1#issuecomment-2";
  assert.deepEqual(parseQuestions(raw), { items: [free("A?"), free("B?")], raw });
  // A line wrapped without indenting it is still the question's.
  assert.deepEqual(parseQuestions("1. A long\nquestion?").items, [free("A long\nquestion?")]);
});

test("parsed questions in another format: only the markdown", () => {
  for (const raw of [
    // Prose, or a bullet list.
    "Which colour should it be?",
    "- Blue?\n- Green?",
    // Options without checkboxes, nested numbers, text after the options.
    "1. Colour?\n   - Blue\n   - Green",
    "1. Colour?\n   1. Blue\n   2. Green",
    "1. Colour?\n   - [ ] Blue\n   Or something else.",
    // A paragraph between two questions, two picks, an empty question or option.
    "1. A?\n\nSome context.\n\n2. B?",
    "1. A?\n   - [ ] X (recommended)\n   - [ ] Y (recommended)",
    "1. **Title**:\n2. B?",
    "1. A?\n   - [ ] (recommended)",
  ]) {
    assert.deepEqual(parseQuestions(raw), { items: null, raw }, raw);
  }
});

test("parsed questions of real issues, as filed before the format", () => {
  assert.deepEqual(parseQuestions(questionsSection(body(130))).items.length, 3);
  assert.deepEqual(parseQuestions(questionsSection(body(134))).items, [
    free(
      'Should the nav link say **Home** or **Tasks**? "Tasks" says what the page shows. ' +
        "I'd go with **Home**, since that's the word in the request.",
    ),
  ]);
  const titled = parseQuestions(questionsSection(body(79))).items;
  assert.deepEqual(
    titled.map((q) => q.title),
    ["Command name", "When a blocker counts as done", "Cancelling", "GitHub's native dependencies"],
  );
  assert.equal(parseQuestions(questionsSection(body(67))), null);
  assert.equal(parseQuestions(questionsSection(body(130))).items[0].title, null);
});

test("a run's questions: after its needs-input heading, up to the next heading", () => {
  const reply = [
    "<!-- needs-input -->",
    "## Needs your input",
    "",
    "1. **Schema**: drop the old column?",
    "   - [ ] Yes, migrate the rows first (recommended)",
    "   - [ ] No, keep both",
    "",
    "### What I checked",
    "",
    "1. The migrations.",
  ].join("\n");
  assert.deepEqual(replyQuestions(reply), {
    items: [
      {
        title: "Schema",
        text: "drop the old column?",
        options: [
          { label: "Yes, migrate the rows first", recommended: true },
          { label: "No, keep both", recommended: false },
        ],
      },
    ],
    raw: reply.split("\n").slice(3, 6).join("\n"),
  });
  // No heading: up to the first one; no marker or nothing asked: none.
  assert.deepEqual(replyQuestions("<!-- needs-input -->\n1. A?\n## Rest\n2. B?").items, [
    free("A?"),
  ]);
  assert.equal(replyQuestions("Done.\n\n1. A?"), null);
  assert.equal(replyQuestions("<!-- needs-input -->\n## Needs your input\n\nNone."), null);
  assert.equal(replyQuestions(null), null);
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
    questions: { items: [{ title: null, text: "Which one?", options: [] }], raw: "1. Which one?" },
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
  // Already as it should be: only the questions the dashboard shows change.
  const still = edit(none, asks, ["needs-input"]);
  assert.deepEqual(
    [still.label, still.track, still.questions.raw],
    [undefined, undefined, "1. Which one?"],
  );
  assert.equal(edit(asks, none, []), null);
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
  // Listed: with the questions of its body.
  const listed = label("labeled", "needs-input", { text: "## Open questions\n\n1. A?" });
  assert.deepEqual(listed.questions, { items: [free("A?")], raw: "1. A?" });
  assert.equal(label("labeled", "needs-input").questions, null);
  assert.equal(label("unlabeled", "needs-input").questions, undefined);
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
