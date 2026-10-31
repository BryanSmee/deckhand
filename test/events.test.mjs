import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { normalize } from "../listener/config.mjs";
import {
  closedItem,
  commentsText,
  discussionEntryItem,
  inboxItem,
  issueItem,
  issueOutcome,
  linkTo,
  MARKER,
  parseAfter,
  parseKey,
  prId,
  splitTrigger,
  saysMore,
  takeOptions,
  taskKey,
  touchedItems,
  verified,
  workItem,
} from "../listener/events.mjs";
import { testConfig } from "./helpers.mjs";

// The App's bot, as server.mjs sets it once the App is known.
const config = { ...testConfig(), bot: "Deckhand-X[bot]" };
const sign = (secret, body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

test("task keys: built and parsed, for issues, pull requests and discussions", () => {
  assert.equal(taskKey("org/repo", 12), "org/repo#12");
  assert.equal(taskKey("org/repo", prId(3)), "org/repo#pr-3");
  assert.deepEqual(parseKey("org/repo#12"), {
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
  });
  assert.deepEqual(parseKey(taskKey("org/repo", prId(3))), {
    repo: "org/repo",
    id: "pr-3",
    kind: "pr",
    number: 3,
  });
  assert.deepEqual(parseKey("org/repo#discussion-8"), {
    repo: "org/repo",
    id: "discussion-8",
    kind: "discussion",
    number: 8,
  });
  assert.equal(parseKey("org-repo-12"), null);
  assert.equal(parseKey("org/repo#onboarding"), null);
});

test("issueItem: an issue's item, with what the caller adds", () => {
  assert.deepEqual(issueItem("o/r", { number: 7, title: "T" }, { trigger: "work" }), {
    repo: "o/r",
    id: "7",
    kind: "issue",
    number: 7,
    title: "T",
    replyTo: 7,
    trigger: "work",
  });
  assert.equal(issueItem("o/r", { number: 7 }).title, null);
});

test("webhook signatures: only the App's secret passes", () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verified("s3cret", sign("s3cret", body), body), true);
  assert.equal(verified("s3cret", sign("other", body), body), false);
  assert.equal(verified("s3cret", sign("s3cret", Buffer.from('{"a":2}')), body), false);
  assert.equal(verified("s3cret", undefined, body), false);
  assert.equal(verified("s3cret", "sha256=short", body), false);
  // No App yet: nothing is verified, even an empty-key signature.
  assert.equal(verified("", sign("", body), body), false);
});

// `pr`: the pull request's body, when the comment is on one; `by`: its author's association
// with the repo, `author` its login (the App's bot opened it by default).
function comment(
  body,
  { login = "alice", type = "User", installation = 7, pr, by, author = "outsider" } = {},
) {
  return {
    action: "created",
    installation: installation && { id: installation },
    repository: { full_name: "Org/Repo", default_branch: "main" },
    issue: {
      number: 12,
      title: "Fix the queue",
      body: pr,
      ...(pr !== undefined && { pull_request: {} }),
      ...(pr !== undefined &&
        (by
          ? {
              user: { login: author, type: author.endsWith("[bot]") ? "Bot" : "User" },
              author_association: by,
            }
          : { user: { login: "deckhand-x[bot]", type: "Bot" }, author_association: "NONE" })),
    },
    comment: { id: 99, body, user: { login, type } },
  };
}

test("/cancel: from an allowed user, on an issue, a pull request or an inbox issue", () => {
  assert.equal(workItem(config, "issue_comment", comment("/cancel")).trigger, "cancel");
  // A pull request's comment stops the run of the issue it closes.
  const pr = workItem(config, "issue_comment", comment("/cancel", { pr: "Closes #3" }));
  assert.deepEqual([pr.trigger, pr.id, pr.replyTo], ["cancel", "3", 12]);
  // On an inbox issue every other comment is an entry: this one stops the entry's run.
  const inbox = { ...config, inbox: { ideas: 12 } };
  const stop = workItem(inbox, "issue_comment", comment("/cancel"));
  assert.deepEqual([stop.trigger, stop.id], ["cancel", "12"]);
  assert.equal(workItem(inbox, "issue_comment", comment("Cancel the plan")).trigger, "idea");
  assert.equal(workItem(config, "issue_comment", comment("/cancel", { login: "mallory" })), null);
});

test("issue comments: trigger, text and reply target", () => {
  const item = workItem(config, "issue_comment", comment("Deckhand\nUse X."));
  assert.deepEqual(
    { ...item, comment: undefined },
    {
      repo: "Org/Repo",
      id: "12",
      kind: "issue",
      number: 12,
      title: "Fix the queue",
      trigger: "work",
      modeLine: null,
      after: null,
      text: "Use X.",
      replyTo: 12,
      comment: undefined,
      author: "alice",
    },
  );
});

test("deliveries outside the allowlist or the App are ignored", () => {
  const reasons = [];
  const skip = (reason) => (reasons.push(reason), null);
  const go = "Deckhand";
  assert.equal(workItem(config, "issue_comment", comment(go, { installation: null }), skip), null);
  assert.equal(workItem(config, "issue_comment", comment(go, { login: "mallory" }), skip), null);
  assert.equal(workItem(config, "issue_comment", comment(go, { type: "Bot" }), skip), null);
  assert.equal(workItem(config, "issue_comment", comment(`hi\n${MARKER}`), skip), null);
  assert.equal(workItem(config, "ping", {}, skip), null);
  assert.equal(reasons.length, 5);
  const narrowed = testConfig({
    ALLOWED_REPOS: "org/other",
  });
  assert.equal(workItem(narrowed, "issue_comment", comment(go)), null);
});

test("pull request comments go to the linked issue's session", () => {
  const linked = workItem(config, "issue_comment", comment("fix the typo", { pr: "Closes #3" }));
  assert.equal(linked.id, "3");
  assert.equal(linked.replyTo, 12);
  // The pull request's title isn't the issue's: the dashboard fetches that one.
  assert.equal(linked.title, null);
  const alone = workItem(config, "issue_comment", comment("fix it", { pr: "No issue" }));
  assert.equal(alone.id, "pr-12");
  assert.equal(alone.title, "Fix the queue");
  // Anyone else's, a maintainer's included: the payload has no head, which tasks.mjs looks up
  // (`claims`) before linking it.
  const own = comment("fix it", { pr: "Closes #3", by: "COLLABORATOR" });
  const claimed = workItem(config, "issue_comment", own);
  assert.equal(claimed.id, "pr-12");
  assert.equal(claimed.claims, 3);
  const relinked = linkTo(claimed, 3);
  assert.equal(relinked.id, "3");
  assert.equal(relinked.kind, "issue");
  assert.equal(relinked.replyTo, 12);
  assert.equal("claims" in relinked, false);
  // No App known yet: no bot is trusted.
  const noBot = { ...config, bot: null };
  const byApp = comment("fix the typo", { pr: "Closes #3" });
  assert.equal(workItem(noBot, "issue_comment", byApp).id, "pr-12");
});

test("an outsider's pull request saying Closes #N doesn't reach issue N's session", () => {
  // Issue comments: the payload has no head; only the App's own pull requests are trusted
  // from it, not any bot, nor a collaborator's (whose head may be a fork's).
  const authors = [
    ["CONTRIBUTOR", "outsider"],
    ["FIRST_TIME_CONTRIBUTOR", "outsider"],
    ["NONE", "github-actions[bot]"],
    ["NONE", "other-app[bot]"],
    ["COLLABORATOR", "bob"],
  ];
  for (const [by, author] of authors) {
    const p = comment("fix it", { pr: "Closes #3", by, author });
    const item = workItem(config, "issue_comment", p);
    assert.equal(item.id, "pr-12", author);
    assert.equal(item.kind, "pr");
  }
  // Reviews and review comments: its head branch must be in the repo, not a fork.
  const review = (head) => ({
    action: "submitted",
    installation: { id: 7 },
    repository: { full_name: "Org/Repo", default_branch: "main" },
    pull_request: { number: 12, title: "Fix", body: "Closes #3", head },
    review: { id: 5, body: "Looks good", user: { login: "alice", type: "User" } },
  });
  const fork = { ref: "issue-3-fix", repo: { full_name: "mallory/repo" } };
  assert.equal(workItem(config, "pull_request_review", review(fork)).id, "pr-12");
  assert.equal(
    workItem(config, "pull_request_review", review({ ref: "x", repo: null })).id,
    "pr-12",
  );
  const own = { ref: "issue-3-fix", repo: { full_name: "org/repo" } };
  assert.equal(workItem(config, "pull_request_review", review(own)).id, "3");
});

test("inbox issues: every comment is an entry, trigger lines or not", () => {
  const repoConfig = { ...config, inbox: { ideas: 12, bugs: 13 } };
  const payload = comment("Deckhand\nDark mode", { login: "alice" });
  payload.comment.html_url = "https://github.com/Org/Repo/issues/12#issuecomment-99";
  const item = workItem(repoConfig, "issue_comment", payload);
  assert.equal(item.trigger, "idea");
  assert.equal(item.replyTo, 12);
  assert.equal(
    item.text,
    "From @alice (https://github.com/Org/Repo/issues/12#issuecomment-99):\n\nDeckhand\nDark mode",
  );
  // Another issue of the same repo: the usual trigger lines.
  payload.issue.number = 14;
  assert.equal(workItem(repoConfig, "issue_comment", payload).trigger, "work");
  // Still only allowed users.
  assert.equal(workItem(repoConfig, "issue_comment", comment("idea", { login: "mallory" })), null);
});

test("inbox entries: /model, /effort and /agent may end any line", () => {
  const repoConfig = { ...config, inbox: { ideas: 12 } };
  const ran = (body) => {
    const options = {};
    const item = workItem(repoConfig, "issue_comment", comment(body, { login: "alice" }));
    return { text: commentsText([item], options).replace(/^From @alice[^\n]*\n\n/, ""), options };
  };
  assert.deepEqual(ran("Do X /effort high"), { text: "Do X", options: { effort: "high" } });
  assert.deepEqual(ran("Do X /model sonnet /agent codex\nThen Y /effort MAX"), {
    text: "Do X\nThen Y",
    options: { model: "sonnet", agent: "codex", effort: "max" },
  });
  // A command earlier in the sentence stays: only the run at the end counts.
  assert.deepEqual(ran("Use /model x, then /effort low"), {
    text: "Use /model x, then",
    options: { effort: "low" },
  });
  // In the middle of a line, refused values, "/mode" and "/after": text, no options.
  for (const body of [
    "use /effort high to review",
    "Do X /effort huge",
    "Do X /effort high /effort huge",
    "Do X /mode review",
    "Do X /after #3",
  ]) {
    assert.deepEqual(ran(body), { text: body, options: {} });
  }
  // Code blocks and quotes show commands, they don't give them.
  for (const body of [
    "It breaks on:\n```\nDeckhand /agent codex\n```",
    "~~~md\nDo X /effort high\n~~~",
    "> Do X /effort high\nSame here.",
  ]) {
    assert.deepEqual(ran(body), { text: body, options: {} });
  }
  // After a code block, lines count again.
  assert.deepEqual(ran("```\nx\n```\nDo X /effort low"), {
    text: "```\nx\n```\nDo X",
    options: { effort: "low" },
  });
  // Long runs of spaces: linear, not quadratic.
  const started = performance.now();
  ran(`a${" ".repeat(60_000)}b`);
  assert.ok(performance.now() - started < 1000);
  // An own line still works.
  assert.deepEqual(ran("Do X\n  /effort high"), { text: "Do X", options: { effort: "high" } });
  // Sent from the dashboard (work.mjs), and in a discussion.
  const issue = { number: 12, title: "Ideas", html_url: "u" };
  const sent = inboxItem("Org/Repo", issue, "idea", { id: 1 }, { login: "bob" }, "Y /effort low");
  const options = {};
  assert.equal(commentsText([sent], options), "From @bob:\n\nY");
  assert.deepEqual(options, { effort: "low" });
  const d = { number: 8, title: "Runs?", html_url: "https://d/8", node_id: "D_5", id: 5 };
  const asked = discussionEntryItem("Org/Repo", d, null, { login: "bob" }, "Kept? /agent codex");
  const picked = {};
  assert.equal(
    commentsText([asked], picked),
    "From @bob (https://d/8):\n\nKept?\n\n(Title: Runs?)",
  );
  assert.deepEqual(picked, { agent: "codex" });
});

function discussion(event, { category = "Ask Claude", login = "alice", parent = null } = {}) {
  const d = {
    id: 5,
    node_id: "D_5",
    number: 8,
    title: "How do runs restart?",
    body: "Is the queue kept?",
    html_url: "https://github.com/Org/Repo/discussions/8",
    category: { name: category },
    user: { login, type: "User" },
  };
  return {
    action: "created",
    installation: { id: 7 },
    repository: { full_name: "Org/Repo", default_branch: "main" },
    discussion: d,
    ...(event === "discussion_comment" && {
      comment: {
        id: 41,
        node_id: "DC_41",
        parent_id: parent,
        body: "And the reactions?",
        html_url: "https://github.com/Org/Repo/discussions/8#discussioncomment-41",
        user: { login, type: "User" },
      },
    }),
  };
}

test("discussions: only in the repo's category, only from allowed users", () => {
  const repoConfig = { ...config, inbox: { discussions: "ask claude" } };
  const opened = workItem(repoConfig, "discussion", discussion("discussion"));
  assert.deepEqual(
    { ...opened, text: undefined },
    {
      repo: "Org/Repo",
      id: "discussion-8",
      kind: "discussion",
      number: 8,
      title: "How do runs restart?",
      trigger: "discussion",
      text: undefined,
      replyTo: 8,
      discussionId: "D_5",
      comment: { id: 5, node_id: "D_5", discussion: true },
      author: "alice",
    },
  );
  assert.match(
    opened.text,
    /^From @alice .*\n\nIs the queue kept\?\n\n\(Title: How do runs restart\?\)$/,
  );
  const answer = workItem(repoConfig, "discussion_comment", discussion("discussion_comment"));
  assert.equal(answer.id, "discussion-8");
  assert.deepEqual(answer.comment, {
    id: 41,
    node_id: "DC_41",
    parent_id: null,
    discussion: true,
  });

  const reasons = [];
  const skip = (reason) => (reasons.push(reason), null);
  const other = discussion("discussion", { category: "General" });
  assert.equal(workItem(repoConfig, "discussion", other, skip), null);
  assert.match(reasons[0], /category "General"/);
  // No category in the repo's config: no discussion calls Claude.
  assert.equal(workItem({ ...config, inbox: {} }, "discussion", discussion("discussion")), null);
  const stranger = discussion("discussion_comment", { login: "mallory" });
  assert.equal(workItem(repoConfig, "discussion_comment", stranger), null);
  const edited = { ...discussion("discussion"), action: "edited" };
  assert.equal(workItem(repoConfig, "discussion", edited), null);
  // The operator's check, before the repo's config is read, lets it through.
  assert.equal(workItem(config, "discussion", other).kind, "discussion");
});

test("trigger lines and options", () => {
  assert.deepEqual(splitTrigger(config, "/stop"), {
    trigger: "stop",
    mode: null,
    after: null,
    text: "",
  });
  // `/cancel` stops a run: its own command, not the brainstorm's wrap-up.
  assert.deepEqual(splitTrigger(config, " /Cancel \nit loops"), {
    trigger: "cancel",
    mode: null,
    after: null,
    text: "it loops",
  });
  assert.equal(splitTrigger(config, "/cancel please").trigger, null);
  assert.deepEqual(splitTrigger(config, "just text"), {
    trigger: null,
    mode: null,
    after: null,
    text: "just text",
  });
  // The default trigger, compared loosely; the lines after it are the instructions.
  for (const line of ["Deckhand", "deckhand:", "@Deckhand", " DECKHAND! "]) {
    assert.deepEqual(splitTrigger(config, `${line}\nFix it.`), {
      trigger: "work",
      mode: null,
      after: null,
      text: "Fix it.",
    });
  }
  // The whole first line: text after the trigger is not one.
  assert.equal(splitTrigger(config, "Deckhand is down again").trigger, null);
  assert.equal(splitTrigger(config, "Deckhand fix the typo").trigger, null);
  // The old lines are gone.
  assert.equal(splitTrigger(config, "Claude work on this").trigger, null);
  assert.equal(splitTrigger(config, "Claude stop").trigger, null);
  const own = { ...config, trigger: normalize("Hey bot") };
  assert.equal(splitTrigger(own, "hey, bot!").trigger, "work");
  assert.equal(splitTrigger(own, "Deckhand").trigger, null);
  const options = {};
  assert.equal(
    takeOptions("/model sonnet\n/effort HIGH\n/effort huge\nhello", options),
    "/effort huge\nhello",
  );
  assert.deepEqual(options, { model: "sonnet", effort: "high" });
  // A gateway's names; not a sentence that starts with /model.
  const gateway = {};
  assert.equal(
    takeOptions("/model openai/gpt-5\n/model the best one\nhi", gateway),
    "/model the best one\nhi",
  );
  assert.deepEqual(gateway, { model: "openai/gpt-5" });
  // An agent, on a provider or not; not a sentence.
  const agent = {};
  assert.equal(
    takeOptions("/agent Claude@OpenRouter\n/agent the other one\nhi", agent),
    "/agent the other one\nhi",
  );
  assert.deepEqual(agent, { agent: "claude@openrouter" });
});

test("a /mode line picks the mode, and is never taken for /model", () => {
  assert.deepEqual(splitTrigger(config, "Deckhand\n/mode Review\nLook at X."), {
    trigger: "work",
    mode: "review",
    after: null,
    text: "Look at X.",
  });
  // On the trigger's line too.
  assert.deepEqual(splitTrigger(config, "@deckhand /mode Brainstorm\nIdeas?"), {
    trigger: "work",
    mode: "brainstorm",
    after: null,
    text: "Ideas?",
  });
  assert.equal(splitTrigger(config, "Deckhand /model sonnet").mode, null);
  assert.equal(splitTrigger(config, "Deckhand is down /mode work").trigger, null);
  // Without a trigger line: a switch, for an issue that has a session (server.mjs decides).
  assert.deepEqual(splitTrigger(config, "/mode work\nGo ahead."), {
    trigger: null,
    mode: "work",
    after: null,
    text: "Go ahead.",
  });
  const model = splitTrigger(config, "Deckhand\n/model sonnet");
  assert.equal(model.mode, null);
  assert.equal(model.text, "/model sonnet");
  const options = {};
  assert.equal(takeOptions("/mode review", options), "/mode review");
  assert.deepEqual(options, {});
  // Only on its own line.
  assert.equal(splitTrigger(config, "use /mode review here").mode, null);
});

test("a /mode line reaches the item, a brainstorm's on a pull request too (policy/run.rego decides)", () => {
  const item = workItem(config, "issue_comment", comment("/mode review\nCheck the tests."));
  assert.equal(item.modeLine, "review");
  assert.equal(item.trigger, null);
  assert.equal(item.text, "Check the tests.");
  const onPr = workItem(config, "issue_comment", comment("/mode review", { pr: "Closes #3" }));
  assert.equal(onPr.modeLine, "review");
  assert.equal(onPr.id, "3");
  // Refused later by the policies' allow_run, not here: the operator may allow it.
  const brainstorm = comment("/mode brainstorm", { pr: "Closes #3" });
  assert.equal(workItem(config, "issue_comment", brainstorm).modeLine, "brainstorm");
  const stop = workItem(config, "issue_comment", comment("/stop", { pr: "Closes #3" }));
  assert.equal(stop.trigger, "stop");
});

test("/after: on the trigger line or its own, with /mode, /model, /effort and the text kept", () => {
  assert.deepEqual(splitTrigger(config, "Deckhand /after #77"), {
    trigger: "work",
    mode: null,
    after: { numbers: [77] },
    text: "",
  });
  const body =
    "Deckhand\n/after #77 #80\n/mode work\n/effort high\nDo it on top of the new parser.";
  assert.deepEqual(splitTrigger(config, body), {
    trigger: "work",
    mode: "work",
    after: { numbers: [77, 80] },
    text: "/effort high\nDo it on top of the new parser.",
  });
  // Both on the trigger line, either order.
  for (const line of [
    "@deckhand /after #7, #8 /mode review",
    "Deckhand /mode review /after #7 #8",
  ]) {
    const cmd = splitTrigger(config, line);
    assert.equal(cmd.trigger, "work");
    assert.equal(cmd.mode, "review");
    assert.deepEqual(cmd.after, { numbers: [7, 8] });
  }
  // Anything else on the line: not the trigger line.
  assert.equal(splitTrigger(config, "Deckhand /mode brainstorm please").trigger, null);
  // On its own: parsed, refused later (waits.mjs).
  assert.deepEqual(splitTrigger(config, "/after none").after, { none: true });
  assert.equal(splitTrigger(config, "/after #3").trigger, null);
  assert.equal(splitTrigger(config, "do it /after #3 is merged").after, null);
  // Not "/afterwards".
  assert.equal(splitTrigger(config, "Deckhand\n/afterwards").after, null);
});

test("/agent, /model and /effort on the trigger line, each kept on its own line", () => {
  const agent = splitTrigger(config, "Deckhand /agent codex\nDo X");
  assert.deepEqual(agent, { trigger: "work", mode: null, after: null, text: "/agent codex\nDo X" });
  const options = {};
  assert.equal(takeOptions(agent.text, options), "Do X");
  assert.deepEqual(options, { agent: "codex" });
  for (const [line, want] of [
    ["Deckhand /model sonnet", { model: "sonnet" }],
    ["@deckhand /effort High", { effort: "high" }],
    ["Deckhand /model sonnet /effort high", { model: "sonnet", effort: "high" }],
  ]) {
    const cmd = splitTrigger(config, line);
    assert.equal(cmd.trigger, "work", line);
    const got = {};
    assert.equal(takeOptions(cmd.text, got), "");
    assert.deepEqual(got, want);
  }
  const mix = splitTrigger(config, "Deckhand /mode brainstorm /agent claude@openrouter /after #7");
  assert.equal(mix.trigger, "work");
  assert.equal(mix.mode, "brainstorm");
  assert.deepEqual(mix.after, { numbers: [7] });
  assert.equal(mix.text, "/agent claude@openrouter");
  // Anything else, or a value takeOptions() would refuse: not the trigger line.
  assert.equal(splitTrigger(config, "Deckhand /agent codex please").trigger, null);
  assert.equal(splitTrigger(config, "Deckhand /effort huge").trigger, null);
  // Only the commands: no answer to open questions (saysMore()).
  assert.equal(saysMore(config, "Deckhand /agent codex"), false);
  const item = workItem(config, "issue_comment", comment("Deckhand /agent codex"));
  assert.equal(item.trigger, "work");
  assert.equal(item.text, "/agent codex");
});

test("/speed: fast or normal, on its own line, ending the trigger line or an entry's line", () => {
  const options = {};
  assert.equal(takeOptions("Fix it now\n/speed fast", options), "Fix it now");
  assert.deepEqual(options, { speed: "fast" });
  const normal = {};
  assert.equal(takeOptions("/speed Normal", normal), "");
  assert.deepEqual(normal, { speed: "normal" });
  // A refused value, or in a sentence: text, like a refused /effort.
  for (const text of ["/speed huge", "/speed", "use /speed fast for this", "/speed fast please"]) {
    const none = {};
    assert.equal(takeOptions(text, none), text);
    assert.deepEqual(none, {}, text);
  }
  const cmd = splitTrigger(config, "Deckhand /speed fast /effort high\nPatch the CVE");
  assert.equal(cmd.trigger, "work");
  const got = {};
  assert.equal(takeOptions(cmd.text, got), "Patch the CVE");
  assert.deepEqual(got, { speed: "fast", effort: "high" });
  assert.equal(splitTrigger(config, "Deckhand /speed huge").trigger, null);
  assert.equal(saysMore(config, "Deckhand /speed fast"), false);
  // An inbox entry's line.
  const repoConfig = { ...config, inbox: { ideas: 12 } };
  const item = workItem(
    repoConfig,
    "issue_comment",
    comment("Fix login /speed fast", { login: "alice" }),
  );
  const entry = {};
  assert.match(commentsText([item], entry), /\n\nFix login$/);
  assert.deepEqual(entry, { speed: "fast" });
});

test("/after takes this repo's numbers or none; anything else is an error", () => {
  assert.deepEqual(parseAfter("#77 #77, #80"), { numbers: [77, 80] });
  assert.deepEqual(parseAfter("None"), { none: true });
  assert.match(parseAfter("").error, /needs an issue/);
  assert.match(parseAfter("org/other#3").error, /this repository only .*`org\/other#3`/);
  assert.match(parseAfter("#3 77").error, /not `77`/);
  assert.match(parseAfter("#3 none").error, /not `none`/);
  const item = workItem(config, "issue_comment", comment("Deckhand /after acme/x#2"));
  assert.match(item.after.error, /acme\/x#2/);
  const onPr = workItem(
    config,
    "issue_comment",
    comment("Deckhand /after #2", { pr: "Closes #3" }),
  );
  assert.deepEqual(onPr.after, { numbers: [2] });
  assert.equal(onPr.author, "alice");
});

test("closed issues and pull requests: done when completed or merged", () => {
  assert.equal(issueOutcome({ state: "open" }), "open");
  assert.equal(issueOutcome({ state: "closed", state_reason: "completed" }), "done");
  assert.equal(issueOutcome({ state: "closed", state_reason: null }), "done");
  assert.equal(issueOutcome({ state: "closed", state_reason: "not_planned" }), "not-done");
  assert.equal(issueOutcome({ state: "closed", state_reason: "duplicate" }), "not-done");
  assert.equal(issueOutcome({ state: "closed", pull_request: { merged_at: "2026" } }), "done");
  assert.equal(issueOutcome({ state: "closed", pull_request: { merged_at: null } }), "not-done");

  const delivery = (event, target, fields = {}) => ({
    action: "closed",
    installation: { id: 7 },
    repository: { full_name: "Org/Repo" },
    [event === "issues" ? "issue" : "pull_request"]: target,
    ...fields,
  });
  const issue = { number: 77, state: "closed", state_reason: "completed" };
  assert.deepEqual(closedItem(config, "issues", delivery("issues", issue)), {
    repo: "Org/Repo",
    number: 77,
    key: "Org/Repo#77",
    state: "done",
  });
  const pr = { number: 5, state: "closed", merged: true, merged_at: "2026" };
  assert.equal(closedItem(config, "pull_request", delivery("pull_request", pr)).state, "done");
  assert.equal(
    closedItem(config, "pull_request", delivery("pull_request", pr)).key,
    "Org/Repo#pr-5",
  );
  // Reopened: open again, for the dashboard's graph.
  const reopened = delivery("issues", { ...issue, state: "open" }, { action: "reopened" });
  assert.equal(closedItem(config, "issues", reopened).state, "open");
  const dropped = { ...pr, merged: false, merged_at: null };
  assert.equal(
    closedItem(config, "pull_request", delivery("pull_request", dropped)).state,
    "not-done",
  );
  // Not a close, not the App's, not an allowed repo.
  const opened = delivery("issues", issue, { action: "opened" });
  assert.equal(closedItem(config, "issues", opened), null);
  const foreign = delivery("issues", issue, { installation: null });
  assert.equal(closedItem(config, "issues", foreign), null);
  const narrowed = testConfig({ ALLOWED_REPOS: "org/other" });
  assert.equal(closedItem(narrowed, "issues", delivery("issues", issue)), null);
  assert.equal(closedItem(config, "issue_comment", delivery("issues", issue)), null);
});

test("touchedItems: what a delivery is about, and the issue a merged pull request closes", () => {
  const base = { installation: { id: 7 }, repository: { full_name: "org/repo" } };
  const head = { ref: "issue-77-x", repo: { full_name: "org/repo" } };
  const pr = { number: 90, body: "Closes #77", head, merged_at: null };
  const merged = { ...pr, merged: true, merged_at: "2026" };
  const touched = (event, p) => touchedItems(config, event, { ...base, ...p });
  assert.deepEqual(touched("pull_request", { action: "ready_for_review", pull_request: pr }), {
    repo: "org/repo",
    numbers: [90, 77],
    merged: null,
  });
  assert.deepEqual(touched("pull_request", { action: "closed", pull_request: merged }).merged, 77);
  // Closed unmerged: nothing merged.
  assert.equal(touched("pull_request", { action: "closed", pull_request: pr }).merged, null);
  // A fork's "Closes #77" doesn't speak for #77.
  const fork = { ...merged, head: { ref: "x", repo: { full_name: "someone/repo" } } };
  assert.deepEqual(touched("pull_request", { action: "closed", pull_request: fork }), {
    repo: "org/repo",
    numbers: [90],
    merged: null,
  });
  assert.deepEqual(touched("issues", { action: "edited", issue: { number: 77 } }).numbers, [77]);
  // A comment on a pull request: the issue its author's "Closes #77" names too.
  // Anyone's: GitHub's answer about #77 decides, not the pull request.
  const onPr = { number: 90, body: "Fixes #77", pull_request: {}, author_association: "NONE" };
  assert.deepEqual(touched("issue_comment", { action: "created", issue: onPr }).numbers, [90, 77]);
  assert.equal(touched("push", { action: "x" }), null);
  const narrowed = testConfig({ ALLOWED_REPOS: "org/other" });
  assert.equal(touchedItems(narrowed, "issues", { ...base, issue: { number: 77 } }), null);
  assert.equal(
    touchedItems(config, "issues", { repository: base.repository, issue: { number: 77 } }),
    null,
  );
});

test("saysMore: only text besides the trigger and command lines answers open questions", () => {
  const config = testConfig({ TRIGGER: "Deckhand" });
  for (const bare of [
    "Deckhand",
    "@deckhand:",
    "Deckhand /mode review",
    "Deckhand\n/mode review\n/model sonnet\n/effort high\n",
    "Deckhand /after #7",
    "",
  ]) {
    assert.equal(saysMore(config, bare), false, bare);
  }
  assert.equal(saysMore(config, "Deckhand\n1. The first"), true);
  assert.equal(saysMore(config, "Deckhand /mode review\nYes"), true);
  assert.equal(saysMore(config, "The first one"), true);
  // Not the trigger line: the whole comment is text.
  assert.equal(saysMore(config, "Deckhand please"), true);
});
