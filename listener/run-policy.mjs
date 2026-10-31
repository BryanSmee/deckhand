// The decision before a run a person starts (issue #488): `allow_run` and `deny_run`
// (policies.mjs), asked once a queued item's mode is settled and before it changes anything
// (task-modes.mjs modeOf()): a trigger comment, a "/mode" line, a comment that goes on in the
// issue's mode, the dashboard, an inbox entry, a discussion. Not the runs the listener starts by
// itself (review, fix, CI fix, conflict: `deny_review` and `deny_fix` decide those), nor an
// onboarding issue's run (nobody asked for it). Asked once, when the item is queued: a label
// added before it starts changes nothing. Input: ../docs/repo-config.md#the-run-input.
import { getJson } from "./github.mjs";
import { BUILT_IN, isFresh, isLight } from "./modes.mjs";
import { denyKept, isPolicyError, unallowed } from "./policies.mjs";

// Whether `item` is a run a person asked for: one with an author, not one of the listener's own
// (`reason`: "review", "review-fix", "ci-fix", "conflict").
export const personStarted = (item) => !!item.author && !item.reason;

// What started `item`: "inbox" (an idea or a bug entry), "discussion", "dashboard" (a button, a
// drag, a message sent from there) or "comment" (on GitHub).
export function runTrigger(item) {
  if (item.trigger === "idea" || item.trigger === "bug") return "inbox";
  if (item.trigger === "discussion") return "discussion";
  return item.dashboard ? "dashboard" : "comment";
}

// Where `item`'s comment is: { kind, number }, "issue", "pr" (a pull request of its own, or one
// that closes the task's issue: events.mjs linkTo()) or "discussion".
export function targetOf(item) {
  if (item.kind === "discussion") return { kind: "discussion", number: item.number };
  if (item.kind === "pr" || item.replyTo !== item.number) {
    return { kind: "pr", number: item.replyTo };
  }
  return { kind: "issue", number: item.number };
}

const DISCUSSION =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { author { login } labels(first: 100) { nodes { name } } } } }";

// What the input says of `target` in `repo`, read from GitHub now: { labels, author, pr }, `pr`
// ({ draft, base, head }) on a pull request only. One call: no files, this decision is made
// per comment. `github`, `graphql`: the App's calls (github.mjs createGitHub()).
export async function readTarget({ github, graphql }, repo, target) {
  const names = (labels) => (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
  if (target.kind === "discussion") {
    const [owner, name] = repo.split("/");
    const data = await graphql(repo, DISCUSSION, { owner, name, number: target.number });
    const d = data?.repository?.discussion;
    if (!d) throw new Error(`discussion #${target.number} not found`);
    return { labels: names(d.labels?.nodes), author: d.author?.login ?? null, pr: null };
  }
  const path = `/repos/${repo}/${target.kind === "pr" ? "pulls" : "issues"}/${target.number}`;
  const found = await getJson(github, repo, path);
  return {
    labels: names(found.labels),
    author: found.user?.login ?? null,
    pr:
      target.kind === "pr"
        ? { draft: !!found.draft, base: found.base?.ref ?? null, head: found.head?.ref ?? null }
        : null,
  };
}

// Whether `item` goes on in the issue's current mode, without a trigger or "/mode" line: a
// conversation started where it was allowed (the onboarding pull request's comments go on in
// onboarding).
export const continues = (item) => !item.trigger && !item.modeLine;

// The input of `allow_run` and `deny_run` for `item` in `mode`, `read` being readTarget()'s.
export function runInput(item, mode, read, now = Date.now) {
  const target = targetOf(item);
  return {
    decision: "run",
    time: new Date(now()).toISOString(),
    repo: item.repo.toLowerCase(),
    mode,
    custom_mode: !BUILT_IN.has(mode),
    light: isLight(item, mode),
    fresh: isFresh(item, mode),
    trigger: runTrigger(item),
    continues: continues(item),
    sender: item.author ?? null,
    target: { ...target, labels: read.labels, author: read.author },
    // The issue whose task it is: the one a pull request closes, null for a pull request's own.
    issue: item.kind === "issue" ? item.number : null,
    pr: read.pr,
  };
}

// The modes Deckhand's policy/run.rego keeps on issues, unless a comment goes on in them.
const ISSUE_ONLY = new Set(["brainstorm", "stop", "onboarding"]);

// What Deckhand's policy/run.rego, alone and with no repo file, says of `item` in `mode`: the
// refusals, as opa's evaluation would give them (test/run-policy.test.mjs compares both). It
// reads only the item: no `opa`, no read of the issue or pull request (createRunPolicy() lists
// the repo's policy folder first, to know it has none).
export function defaultRun(item, mode) {
  const doc = { mode, target: targetOf(item) };
  // A repo's own mode needs the repo's allow, which a repo without files can't give.
  if (!BUILT_IN.has(mode)) return [unallowed("run", doc, "repo")];
  if (doc.target.kind === "issue" || continues(item) || !ISSUE_ONLY.has(mode)) return [];
  return [unallowed("run", doc, "operator")];
}

// The reply to a run the policies refuse: their messages, quoted as code (they may repeat a
// title, which mustn't mention anyone), as an unknown mode's reply (task-modes.mjs). A policy
// error isn't a rule's answer: the comment may be posted again.
export function runRefusedText(mode, messages) {
  const quoted = messages.map((m) => `\`${m.replace(/`/g, "'")}\``).join(", ");
  const again = messages.some(isPolicyError) ? " Post the comment again once it is fixed." : "";
  return `No \`${mode}\` run: the policies refuse it: ${quoted}.${again}`;
}

// `ctx` (server.mjs): `policies`, `github`, `graphql`, `decisions`, `answer`, `log`. →
// allowed(item, mode, key): whether `item` may run in `mode`; refused, it replies with the
// messages, keeps the decision for the task's page and marks the item (`refused`: the reply's
// text, for the dashboard's answer: work.mjs). Without policies (some tests), nothing is asked.
export function createRunPolicy(ctx, now = Date.now) {
  // The refusal kept for task `key`: the opa path's (denyKept()) or the defaults' own.
  const keep = (key, entry) => {
    if (!entry.denied) return;
    try {
      ctx.decisions?.record(key, entry);
    } catch (error) {
      ctx.log(`${key}: keeping its run decision: ${error.message ?? error}`);
    }
  };

  async function decide(item, mode, key) {
    const ref = item.base || "main";
    const target = targetOf(item);
    let layers = null;
    try {
      // Its last listing when GitHub can't give one now: a repo without policies stays decided
      // here, a GitHub hiccup refusing nothing.
      layers = await ctx.policies.policiesFor(item.repo, ref, { stale: true });
    } catch {
      // decide() below says it, failing closed.
    }
    // Deckhand's files alone, and none of the repo's: run.rego's answer, without opa.
    if (layers && !layers.repo.size && ctx.policies.deckhandOnly?.(layers.operator)) {
      const messages = defaultRun(item, mode);
      const entry = { decision: "run", rule: "deny_run", messages, pr: target.number, gates: [] };
      keep(key, { ...entry, denied: messages.length > 0 });
      return messages;
    }
    const { messages } = await denyKept(
      ctx.policies,
      "deny_run",
      item.repo,
      ref,
      async () => runInput(item, mode, await readTarget(ctx, item.repo, target), now),
      // Its refusals only: every comment of a conversation asks, and its allowed runs would
      // push the pull request's merge and review decisions out of the task's list.
      { pr: { number: target.number }, log: ctx.log, keep: (entry) => keep(key, entry) },
    );
    return messages;
  }

  return async function allowed(item, mode, key) {
    if (!ctx.policies || !personStarted(item)) return true;
    const messages = await decide(item, mode, key);
    if (!messages.length) return true;
    ctx.log(`${key}: ${mode} run refused by the policies`);
    item.refused = runRefusedText(mode, messages);
    // In the discussion, for a discussion's (comments.mjs answer()).
    await ctx.answer(item, item.refused).catch((error) => ctx.log(`${key}: ${error}`));
    return false;
  };
}
