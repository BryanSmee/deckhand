import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  allTicked,
  applyInput,
  hasOpenQuestions,
  inputEvent,
  parseQuestions,
  questionsSection,
  replyQuestions,
  stillAsks,
} from "../listener/questions.mjs";
import { Refused } from "../listener/web.mjs";
import { testConfig } from "./helpers.mjs";

// Real issue bodies: #77, #79, #130 and #134 (filed by an inbox run, questions pending), #67
// ("None").
const body = (n) => readFileSync(new URL(`fixtures/issue-${n}.md`, import.meta.url), "utf8");
const config = testConfig({ ALLOWED_USERS: "alice,bob", ALLOWED_REPOS: "org/repo" });
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
  // A brainstorm's wrap-up: settled questions under Decisions, "None" left in Open questions.
  const wrapped =
    "## Proposal\n\nX.\n\n## Decisions\n\n1. **Name**: which one?\n   - [x] `deck`\n\n" +
    "## Open questions\n\nNone\n\nFrom the brainstorm on #150.\n";
  assert.equal(hasOpenQuestions(wrapped), false);
  assert.equal(parseQuestions(questionsSection(wrapped)), null);
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
          { label: "Left to right, scrolling sideways", recommended: true, checked: false },
          { label: "Top to bottom on phones only", recommended: false, checked: false },
        ],
      },
      free("what should the header link say?", "Link text"),
      {
        title: null,
        text: "Which colour?\nThe header is dark in both themes.\nToday it is grey.",
        options: [
          { label: "Blue", recommended: false, checked: true },
          { label: "Green", recommended: true, checked: false },
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
          { label: "Yes, migrate the rows first", recommended: true, checked: false },
          { label: "No, keep both", recommended: false, checked: false },
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
  // Under an "Open questions" heading of their own: that section.
  const titled = reply.replace(
    "## Needs your input\n",
    "## Needs your input\n\n### Open questions\n",
  );
  assert.deepEqual(replyQuestions(titled), replyQuestions(reply));
  assert.equal(
    replyQuestions(
      "<!-- needs-input -->\n## Needs your input\n### Open questions\nNone\n## Checked",
    ),
    null,
  );
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
  const off = testConfig({ NEEDS_INPUT_LABEL: "" });
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
  // What a comment waiting for the answers starts on (waits.mjs).
  assert.equal(label("unlabeled", "needs-input").answered, true);
  const closed = issues("unlabeled", { label: { name: "needs-input" } });
  closed.issue.state = "closed";
  assert.equal(inputEvent(config, "issues", closed, BOT).answered, undefined);
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
  // Its body: with the repo's `wait_for_answers`, a trigger line alone answers nothing.
  assert.equal(comment("alice", { text: "Deckhand" }).comment, "Deckhand");
  assert.equal(comment("alice", { labels: [] }), null);
  assert.equal(comment("mallory"), null);
  assert.equal(comment(BOT), null);
  assert.equal(comment("alice", { text: "Answer <!-- deckhand -->" }), null);
  // On a pull request: off, but not listed (a pull request's task key isn't its number).
  const pr = comment("alice", { pull: true });
  assert.equal(pr.label, false);
  assert.equal(pr.track, undefined);
  assert.equal(pr.title, null);
  assert.equal(pr.comment, undefined);
});

// The listener's state and services applyInput() touches, each call kept.
function inputCtx(
  settings = { users: ["alice", "bob"], trigger: "deckhand", waitForAnswers: true },
) {
  const calls = [];
  const ctx = {
    config,
    log: (line) => calls.push(["log", line]),
    skip: (why) => (calls.push(["skip", why]), null),
    titles: { set: (key, title) => calls.push(["title", key, title]) },
    repoSettings: async () => ({ settings, errors: [] }),
    label: async (repo, number, on) => (calls.push(["label", number, on]), new Response(null)),
    inputs: {
      set: (key, track) => calls.push(["track", key, track]),
      update: (key) => calls.push(["update", key]),
    },
    waits: { answered: async (repo, number) => calls.push(["answered", number]) },
  };
  return { ctx, calls };
}

test("applyInput: the label and the list follow the change, by the repo's own users", async () => {
  const change = { repo: "org/repo", key: "org/repo#3", number: 3, base: "main", label: false };
  const { ctx, calls } = inputCtx();
  await applyInput(ctx, { ...change, by: "bob", track: false, comment: "Yes, Postgres." });
  assert.deepEqual(
    calls.filter(([what]) => what !== "log"),
    [
      ["label", 3, false],
      ["track", "org/repo#3", false],
    ],
  );
  // Not among the repo's users: nothing changes.
  const narrow = inputCtx({ users: ["alice"], trigger: "deckhand", waitForAnswers: true });
  await applyInput(narrow.ctx, { ...change, by: "bob", track: false, comment: "Yes." });
  assert.deepEqual(
    narrow.calls.map(([what]) => what),
    ["skip"],
  );
  // A trigger line alone answers nothing while the repo waits for answers.
  const trigger = inputCtx();
  await applyInput(trigger.ctx, { ...change, by: "bob", track: false, comment: "Deckhand" });
  assert.deepEqual(
    trigger.calls.map(([what]) => what),
    ["skip"],
  );
  // The label taken off by hand: whatever waited for the answers starts.
  const off = inputCtx();
  await applyInput(off.ctx, { ...change, label: undefined, track: false, answered: true });
  assert.deepEqual(off.calls.at(-1), ["answered", 3]);
});

const ticked = (a, b) =>
  `## Open questions\n\n1. **A**: which?\n   - [${a}] X (recommended)\n   - [ ] Y\n2. B?\n   - [ ] Z\n   - [${b}] W`;

test("parsed questions: each option ticked or not, [x] and [X] alike", () => {
  const options = (text) =>
    parseQuestions(questionsSection(text)).items.map((q) => q.options.map((o) => o.checked));
  assert.deepEqual(options(ticked("x", "X")), [
    [true, false],
    [false, true],
  ]);
  assert.deepEqual(options(ticked(" ", " ")), [
    [false, false],
    [false, false],
  ]);
});

test("allTicked: a box in every question, none of them free text", () => {
  const all = (text) => allTicked(parseQuestions(questionsSection(text)));
  assert.equal(all(ticked("x", "x")), true);
  assert.equal(all(ticked("x", " ")), false);
  assert.equal(all(ticked(" ", " ")), false);
  // A free-text question needs a comment, ticks or not.
  assert.equal(all(`${ticked("x", "x")}\n3. Anything else?`), false);
  assert.equal(all(none), false);
  assert.equal(allTicked(null), false);
  assert.equal(stillAsks(ticked("x", "x")), false);
  assert.equal(stillAsks(ticked("x", " ")), true);
  assert.equal(stillAsks(none), false);
});

test("ticking every question's box answers them; unticking asks again", () => {
  const edit = (from, to, labels, sender = { login: "bob", type: "User" }) =>
    map("edited", { text: to, labels, sender, changes: { body: { from } } });
  const done = edit(ticked("x", " "), ticked("x", "x"), ["needs-input"]);
  assert.deepEqual([done.label, done.track, done.answered, done.by], [false, false, true, "bob"]);
  // Partly ticked, or a free-text question left: the label stays, the form shows the ticks.
  const partly = edit(ticked(" ", " "), ticked("x", " "), ["needs-input"]);
  assert.equal(partly.label, undefined);
  assert.equal(partly.questions.items[0].options[0].checked, true);
  const free = `${ticked("x", "x")}\n3. Anything else?`;
  assert.equal(edit(ticked("x", " "), free, ["needs-input"]).label, undefined);
  // Someone not allowed ticking them: nothing.
  const mallory = { login: "mallory", type: "User" };
  assert.equal(edit(ticked("x", " "), ticked("x", "x"), ["needs-input"], mallory), null);
  // Unticked again: labelled again.
  const again = edit(ticked("x", "x"), ticked(" ", "x"), []);
  assert.deepEqual([again.label, again.track], [true, true]);
  // Opened with every box ticked by an allowed user: nothing to wait for. By the App's bot (an
  // inbox run that ticked its own picks): its ticks answer nothing.
  assert.equal(map("opened", { text: ticked("x", "x") }), null);
  const bot = map("opened", { text: ticked("x", "x"), user: BOT, type: "Bot" });
  assert.deepEqual([bot.label, bot.by, bot.track], [true, null, true]);
  // A closed issue releases nothing.
  const closed = issues("edited", {
    text: ticked("x", "x"),
    labels: ["needs-input"],
    changes: { body: { from: ticked(" ", "x") } },
  });
  closed.issue.state = "closed";
  assert.equal(inputEvent(config, "issues", closed, BOT).answered, false);
});

// An `issue_comment edited` delivery: `sender` ticking boxes in a comment by `author`.
function tick(from, to, { author = BOT, sender = "alice", pull = false } = {}) {
  const p = issues("edited", { sender: { login: sender, type: "User" } });
  const bot = author.endsWith("]");
  p.comment = { id: 9, body: to, user: { login: author, type: bot ? "Bot" : "User" } };
  p.changes = { body: { from } };
  if (pull) p.issue.pull_request = { url: "x" };
  return inputEvent(config, "issue_comment", p, BOT);
}
const reply = (a, b) =>
  `<!-- needs-input -->\n## Needs your input\n\n### Open questions\n\n${ticked(a, b).replace("## Open questions\n\n", "")}\n\n### Checked\n\nThe code.\n\n<sub>🤖 Claude</sub>\n<!-- deckhand -->`;

test("ticking every question's box in a run's reply answers it, as a reply would", () => {
  const done = tick(reply("x", " "), reply("x", "x"));
  assert.deepEqual(done.reply.answers, [
    { options: [0], text: "" },
    { options: [1], text: "" },
  ]);
  assert.equal(done.reply.pr, false);
  assert.equal(done.reply.items.length, 2);
  assert.equal(done.by, "alice");
  assert.equal(done.label, undefined);
  assert.equal(tick(reply("x", " "), reply("x", "x"), { pull: true }).reply.pr, true);
  // Partly ticked, ticked already, someone not allowed, or a comment that isn't the App's.
  assert.equal(tick(reply(" ", " "), reply("x", " ")), null);
  assert.equal(tick(reply("x", "x"), reply("x", "x").replace("The code", "Code")), null);
  assert.equal(tick(reply("x", " "), reply("x", "x"), { sender: "mallory" }), null);
  assert.equal(tick(reply("x", " "), reply("x", "x"), { author: "bob" }), null);
  assert.equal(tick(reply("x", " "), reply("x", "x"), { author: "other[bot]" }), null);
  // Not a reply that stopped to ask.
  const plain = (s) => s.replace("<!-- needs-input -->", "");
  assert.equal(tick(plain(reply("x", " ")), plain(reply("x", "x"))), null);
});

test("applyInput: a run's ticked reply goes on through the work area, refusals logged", async () => {
  const { ctx, calls } = inputCtx();
  const asked = [];
  ctx.workApi = { ticked: async (...args) => (asked.push(args), "Answers sent: #12 continues.") };
  const change = tick(reply("x", " "), reply("x", "x"));
  await applyInput(ctx, change);
  assert.deepEqual(asked, [
    [
      "org/repo",
      "alice",
      { number: 12, pr: false, items: change.reply.items, answers: change.reply.answers },
    ],
  ]);
  assert.deepEqual(calls.at(-1), ["log", "org/repo#12: Answers sent: #12 continues."]);
  ctx.workApi = {
    ticked: async () => {
      throw new Refused(409, "#12 is closed.");
    },
  };
  await applyInput(ctx, change);
  assert.deepEqual(calls.at(-1), ["log", "org/repo#12: ticks: #12 is closed."]);
});
