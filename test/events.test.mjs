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

test("trigger lines and options", () => {
  assert.deepEqual(splitTrigger(config, "/stop"), {
    trigger: "stop",
    text: "",
  });
  assert.deepEqual(splitTrigger(config, "just text"), {
    trigger: null,
    text: "just text",
  });
  const options = {};
  assert.equal(
    takeOptions("/model sonnet\n/effort HIGH\n/effort huge\nhello", options),
    "/effort huge\nhello",
  );
  assert.deepEqual(options, { model: "sonnet", effort: "high" });
});
