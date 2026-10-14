import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { MARKER, splitTrigger, takeOptions, verified, workItem } from "../listener/events.mjs";

const config = loadConfig({ ALLOWED_USERS: "alice" });
const sign = (secret, body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

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

function comment(body, { login = "alice", type = "User", installation = 7, pr } = {}) {
  return {
    action: "created",
    installation: installation && { id: installation },
    repository: { full_name: "Org/Repo", default_branch: "main" },
    issue: {
      number: 12,
      body: pr,
      ...(pr !== undefined && { pull_request: {} }),
    },
    comment: { id: 99, body, user: { login, type } },
  };
}

test("issue comments: trigger, text and reply target", () => {
  const item = workItem(config, "issue_comment", comment("Claude work on this\nUse X."));
  assert.deepEqual(
    { ...item, comment: undefined },
    {
      repo: "Org/Repo",
      id: "12",
      kind: "issue",
      number: 12,
      trigger: "work",
      modeLine: null,
      text: "Use X.",
      replyTo: 12,
      comment: undefined,
    },
  );
});

test("deliveries outside the allowlist or the App are ignored", () => {
  const reasons = [];
  const skip = (reason) => (reasons.push(reason), null);
  const go = "Claude work on this";
  assert.equal(workItem(config, "issue_comment", comment(go, { installation: null }), skip), null);
  assert.equal(workItem(config, "issue_comment", comment(go, { login: "mallory" }), skip), null);
  assert.equal(workItem(config, "issue_comment", comment(go, { type: "Bot" }), skip), null);
  assert.equal(workItem(config, "issue_comment", comment(`hi\n${MARKER}`), skip), null);
  assert.equal(workItem(config, "ping", {}, skip), null);
  assert.equal(reasons.length, 5);
  const narrowed = loadConfig({
    ALLOWED_USERS: "alice",
    ALLOWED_REPOS: "org/other",
  });
  assert.equal(workItem(narrowed, "issue_comment", comment(go)), null);
});

test("pull request comments go to the linked issue's session", () => {
  const linked = workItem(config, "issue_comment", comment("fix the typo", { pr: "Closes #3" }));
  assert.equal(linked.id, "3");
  assert.equal(linked.replyTo, 12);
  const alone = workItem(config, "issue_comment", comment("fix it", { pr: "No issue" }));
  assert.equal(alone.id, "pr-12");
  const brainstorm = comment("Claude let's brainstorm this", { pr: "" });
  assert.equal(workItem(config, "issue_comment", brainstorm), null);
});

test("inbox issues: every comment is an entry, trigger lines or not", () => {
  const repoConfig = { ...config, inbox: { ideas: 12, bugs: 13 } };
  const payload = comment("Claude work on this\nDark mode", { login: "alice" });
  payload.comment.html_url = "https://github.com/Org/Repo/issues/12#issuecomment-99";
  const item = workItem(repoConfig, "issue_comment", payload);
  assert.equal(item.trigger, "idea");
  assert.equal(item.replyTo, 12);
  assert.equal(
    item.text,
    "From @alice (https://github.com/Org/Repo/issues/12#issuecomment-99):\n\nClaude work on this\nDark mode",
  );
  // Another issue of the same repo: the usual trigger lines.
  payload.issue.number = 14;
  assert.equal(workItem(repoConfig, "issue_comment", payload).trigger, "work");
  // Still only allowed users.
  assert.equal(workItem(repoConfig, "issue_comment", comment("idea", { login: "mallory" })), null);
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
      trigger: "discussion",
      text: undefined,
      replyTo: 8,
      discussionId: "D_5",
      comment: { id: 5, node_id: "D_5", discussion: true },
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
    text: "",
  });
  assert.deepEqual(splitTrigger(config, "just text"), {
    trigger: null,
    mode: null,
    text: "just text",
  });
  const options = {};
  assert.equal(
    takeOptions("/model sonnet\n/effort HIGH\n/effort huge\nhello", options),
    "/effort huge\nhello",
  );
  assert.deepEqual(options, { model: "sonnet", effort: "high" });
});

test("a /mode line picks the mode, and is never taken for /model", () => {
  assert.deepEqual(splitTrigger(config, "Claude work on this\n/mode Review\nLook at X."), {
    trigger: "work",
    mode: "review",
    text: "Look at X.",
  });
  // Without a trigger line: a switch, for an issue that has a session (server.mjs decides).
  assert.deepEqual(splitTrigger(config, "/mode work\nGo ahead."), {
    trigger: null,
    mode: "work",
    text: "Go ahead.",
  });
  const model = splitTrigger(config, "Claude work on this\n/model sonnet");
  assert.equal(model.mode, null);
  assert.equal(model.text, "/model sonnet");
  const options = {};
  assert.equal(takeOptions("/mode review", options), "/mode review");
  assert.deepEqual(options, {});
  // Only on its own line.
  assert.equal(splitTrigger(config, "use /mode review here").mode, null);
});

test("a /mode line reaches the item; brainstorms stay off pull requests", () => {
  const item = workItem(config, "issue_comment", comment("/mode review\nCheck the tests."));
  assert.equal(item.modeLine, "review");
  assert.equal(item.trigger, null);
  assert.equal(item.text, "Check the tests.");
  const onPr = workItem(config, "issue_comment", comment("/mode review", { pr: "Closes #3" }));
  assert.equal(onPr.modeLine, "review");
  assert.equal(onPr.id, "3");
  const reasons = [];
  const skip = (reason) => (reasons.push(reason), null);
  const brainstorm = comment("/mode brainstorm", { pr: "Closes #3" });
  assert.equal(workItem(config, "issue_comment", brainstorm, skip), null);
  assert.match(reasons[0], /brainstorms are on issues/);
});
