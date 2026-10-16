// Webhook deliveries → work items: signature check, allowlist, trigger lines. No state, so
// it is tested on its own (../test/events.test.mjs).
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalize, repoAllowed } from "./config.mjs";

// Marks our own comments, in case one ever reaches us from another account than the bot's.
export const MARKER = "<!-- deckhand -->";

// A task's key: "org/repo#12" (an issue), "org/repo#pr-5" (a pull request of its own),
// "org/repo#discussion-8". `id`: its items' (prId(), String(n), discussion-<n>).
export const taskKey = (repo, id) => `${repo}#${id}`;

// The id of a pull request's own task (one that closes no issue it may speak for).
export const prId = (number) => `pr-${number}`;

// "org/repo#pr-3" → { repo: "org/repo", id: "pr-3", kind: "pr", number: 3 }; null for what
// isn't a task's key.
export function parseKey(key) {
  const m = /^([^/#]+\/[^/#]+)#((?:(pr|discussion)-)?(\d+))$/.exec(key);
  return m && { repo: m[1], id: m[2], kind: m[3] ?? "issue", number: Number(m[4]) };
}

// An issue's item, as a comment on it makes: { repo, id, kind, number, title, replyTo },
// and what `fields` add (the trigger, the text, the comment…). `issue`: { number, title }, as
// GitHub has it.
export function issueItem(repo, issue, fields = {}) {
  const n = issue.number;
  return {
    repo,
    id: String(n),
    kind: "issue",
    number: n,
    title: issue.title ?? null,
    replyTo: n,
    ...fields,
  };
}

// GitHub's X-Hub-Signature-256 for the raw body, compared in constant time.
export function verified(secret, signature, body) {
  if (!secret) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(signature ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The issue a pull request belongs to, from the "Closes #12" Claude puts in its description.
// `pr`: as GitHub describes it ({ body, head, user }). Only a pull request that may speak for
// the issue is linked to it: anyone can open one from a fork saying "Closes #12", and its
// comments would then go on in issue 12's session. `bot`: the App's own login ("<slug>[bot]").
export function linkedIssue(pr, repo, bot = null) {
  if (!pr || !trustedPull(pr, repo, bot)) return null;
  return closesIssue(pr);
}

// The issue a pull request's description says it closes, trusted or not.
export function closesIssue(pr) {
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(pr?.body ?? "");
  return match ? Number(match[1]) : null;
}

// Its head branch is in the repo, not a fork. An issue comment's payload has no head: only the
// App's own pull requests (Claude's, always on a branch of the repo) are trusted from it, the
// others are looked up (tasks.mjs admit()). Not any bot: github-actions or another App may
// open pull requests from outsiders' input.
function trustedPull(pr, repo, bot) {
  if (pr.head) return sameRepo(pr, repo);
  return !!bot && pr.user?.login?.toLowerCase() === bot.toLowerCase();
}

// Whether a pull request's head branch is in `repo`, not a fork (whose head repo may be gone).
export function sameRepo(pr, repo) {
  const head = pr.head?.repo?.full_name;
  return !!head && head.toLowerCase() === repo.toLowerCase();
}

// The command on the first line ("work" for the trigger, "stop" for "/stop", "cancel" for
// "/cancel": stop the running run, tasks.mjs), the mode a
// "/mode <name>" line asks for (lowercase, or null), what an "/after #12" line waits for
// (parseAfter(), or null) and the rest of the comment; trigger null and the whole comment when
// there is none. The trigger is the whole first line, so "Deckhand is down" starts nothing;
// "/mode" and "/after" may follow it there ("Deckhand /mode brainstorm", "Deckhand /after #7").
export function splitTrigger(config, body) {
  const [first, ...rest] = body.split(/\r?\n/);
  if (first.trim().toLowerCase() === "/stop") return takeCommands(rest.join("\n"), "stop");
  if (first.trim().toLowerCase() === "/cancel") return takeCommands(rest.join("\n"), "cancel");
  const inline = /^(.*?)\s+(\/(?:mode|after)\s.*)$/i.exec(first);
  if (inline && normalize(inline[1]) === config.trigger) {
    // Each command its own line, as if written below; anything else on the line and it isn't
    // the trigger line ("Deckhand /mode brainstorm please").
    const lines = inline[2].trim().split(/\s+(?=\/(?:mode|after)\s)/i);
    const known = (l) => /^\/mode\s+[\w-]+$/i.test(l) || /^\/after\s/i.test(l);
    if (lines.every(known)) return takeCommands([...lines, ...rest].join("\n"), "work");
  }
  if (normalize(first) === config.trigger) return takeCommands(rest.join("\n"), "work");
  return takeCommands(body, null);
}

// Removes the "/mode <name>" and "/after …" lines. Their own lines, like "/model": the space
// keeps "/mode" and "/model" apart. The last of each wins.
function takeCommands(text, trigger) {
  let mode = null;
  let after = null;
  const kept = text.split(/\r?\n/).filter((line) => {
    const match = /^\s*\/mode\s+([\w-]+)\s*$/i.exec(line);
    if (match) mode = match[1].toLowerCase();
    const wait = /^\s*\/after(?:\s+(.*?))?\s*$/i.exec(line);
    if (wait) after = parseAfter(wait[1] ?? "");
    return !match && !wait;
  });
  return { trigger, mode, after, text: kept.join("\n").trim() };
}

// What follows "/after": { numbers } (issues or pull requests of the same repo), { none: true }
// (stop waiting) or { error } (what the reply says). Other repos are refused: their state
// isn't this repo's to watch, and failing closed costs a comment.
export function parseAfter(text) {
  const words = text.split(/[\s,]+/).filter(Boolean);
  if (words.length === 1 && words[0].toLowerCase() === "none") return { none: true };
  if (!words.length) return { error: "`/after` needs an issue: `/after #12`." };
  const numbers = [];
  for (const word of words) {
    const match = /^#(\d+)$/.exec(word);
    if (match) {
      if (!numbers.includes(Number(match[1]))) numbers.push(Number(match[1]));
      continue;
    }
    if (/^[\w.-]+\/[\w.-]+#\d+$/.test(word)) {
      return {
        error: `\`/after\` takes issues of this repository only (\`#12\`), not \`${word}\`.`,
      };
    }
    return {
      error: `\`/after\` takes issue numbers (\`/after #12 #15\`) or \`none\`, not \`${word}\`.`,
    };
  }
  return { numbers };
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// A model: a tier (best, balanced, fast: agents/), an alias (opus), an id
// (claude-opus-5-5[1m]) or a gateway's (anthropic/claude-opus-5.5, openai/gpt-5,
// meta-llama/llama-4:free).
export const MODEL_NAME = /^[\w.[\]/:-]+$/;

// An agent, on a provider or not (codex, claude@openrouter), or `default`: checked against the
// operator's when the run starts (agents/select.mjs pickProblem()).
const AGENT_NAME = /^[\w.-]+(@[\w.-]+)?$/;

// Removes "/model <name>", "/effort <level>" and "/agent <name>" lines from a comment,
// recording them in options.
export function takeOptions(text, options) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*\/(model|effort|agent)\s+(\S+)\s*$/i.exec(line);
      if (!match) return true;
      const key = match[1].toLowerCase();
      const value = key === "model" ? match[2] : match[2].toLowerCase();
      if (key === "effort" && !EFFORTS.includes(value)) return true;
      if (key === "model" && !MODEL_NAME.test(value)) return true;
      if (key === "agent" && !AGENT_NAME.test(value)) return true;
      options[key] = value;
      return false;
    })
    .join("\n")
    .trim();
}

// Whether a comment says anything besides its trigger and command lines ("/mode", "/after",
// "/model", "/effort", "/agent"): only then does it answer an issue's open questions (tasks.mjs).
export function saysMore(config, body) {
  return !!takeOptions(splitTrigger(config, body ?? "").text, {});
}

// Comments as the agent reads them, one after the other, without their "/model", "/effort"
// and "/agent" lines (collected in `options`).
export function commentsText(items, options) {
  return items
    .map((i) => takeOptions(i.text, options))
    .filter(Boolean)
    .join("\n\n---\n\n");
}

// An inbox entry, as Claude reads it: who wrote it and where, so its reply can link back.
function entry(author, url, body) {
  return `From @${author.login}${url ? ` (${url})` : ""}:\n\n${body.trim()}`;
}

// Returns { repo, id, kind, number, trigger, modeLine, text, replyTo, comment } or null to
// ignore. `modeLine`: what a "/mode <name>" line asks for, checked against the repo's modes later.
// `skip(reason)` logs why a delivery is ignored and returns null: deliveries that do nothing
// are the usual question.
//
// `config.inbox` is the repo's (repo-config.mjs): comments on its ideas or bugs issue are
// inbox entries ("idea", "bug"), and discussions in its discussions category are answered
// ("discussion"), with no trigger line. The operator's own check runs without it, before the
// repo's config is read: discussions then pass whatever their category.
export function workItem(config, event, p, skip = () => null) {
  const repo = p.repository?.full_name;
  const source = p.comment ?? p.review ?? (event === "discussion" ? p.discussion : null);
  const author = source?.user;
  const body = source?.body ?? "";
  if (event === "ping") return skip("ping (webhook configured)");
  // Onboarding's (onboarding.mjs): they never carry a comment.
  if (event === "installation" || event === "installation_repositories") {
    return skip(`${event} ${p.action ?? ""} by ${p.sender?.login ?? "?"}`);
  }
  // Fail closed: only deliveries for one of the App's installations.
  if (!p.installation?.id) return skip("not from an installation of the App");
  // The preview hook's (previewEvent()); nothing runs Claude for them.
  if (event === "pull_request" || event === "workflow_run") return skip(`${event}: no hook`);
  if (!repo || !author) return skip("not a comment");
  if (!repoAllowed(config, repo)) {
    return skip(`${repo} not in ALLOWED_REPOS`);
  }
  if (author.type === "Bot") return skip("comment by a bot");
  if (!config.users.includes(author.login.toLowerCase())) {
    return skip(`${author.login} not in ALLOWED_USERS`);
  }
  if (body.includes(MARKER)) return skip("our own reply");

  // null: skipped there, the reason logged.
  const item = Object.hasOwn(ITEMS, event) ? ITEMS[event](config, event, p, skip) : undefined;
  if (item === undefined) return skip(`${event} ${p.action ?? ""} is not handled`);
  // Checked again when a comment that waited ("/after") starts its run (waits.mjs).
  if (item) item.author = author.login;
  return item;
}

// An inbox entry's item ("idea" or "bug"): a comment on the inbox issue, or the App's comment
// for an entry sent from the dashboard (work.mjs), where `author` is who sent it and `body` its
// text without the App's line.
export function inboxItem(repo, issue, trigger, comment, author, body) {
  return issueItem(repo, issue, { comment, trigger, text: entry(author, comment.html_url, body) });
}

// A comment on an issue or a pull request (pull requests are issues to that event).
function issueCommentItem(config, event, p, skip) {
  if (p.action !== "created") return undefined;
  const repo = p.repository.full_name;
  const body = p.comment.body ?? "";
  const { trigger, mode, after, text } = splitTrigger(config, body);
  if (p.issue.pull_request) {
    return prItem(config, skip, repo, p.issue, { trigger, mode, after }, text, p.comment);
  }
  // Every comment on an inbox issue is an entry: trigger lines don't apply there, but for
  // `/cancel`, which stops the entry's run.
  const inbox =
    trigger !== "cancel" &&
    [
      ["idea", config.inbox?.ideas],
      ["bug", config.inbox?.bugs],
    ].find(([, number]) => number === p.issue.number)?.[0];
  if (inbox) return inboxItem(repo, p.issue, inbox, p.comment, p.comment.user, body);
  return issueItem(repo, p.issue, { comment: p.comment, trigger, modeLine: mode, after, text });
}

// A comment on a line of a pull request's diff: Claude gets the line and its hunk.
function reviewCommentItem(config, event, p, skip) {
  if (p.action !== "created") return undefined;
  const c = p.comment;
  const cmd = splitTrigger(config, c.body ?? "");
  const where = `Review comment on \`${c.path}\` line ${c.line ?? c.original_line}:\n\`\`\`diff\n${c.diff_hunk}\n\`\`\`\n`;
  return prItem(config, skip, p.repository.full_name, p.pull_request, cmd, where + cmd.text, {
    ...c,
    review: true,
  });
}

// A submitted review with a body. It has no reactions API: no comment for those.
function reviewItem(config, event, p, skip) {
  const body = p.review.body ?? "";
  if (p.action !== "submitted" || !body.trim()) return undefined;
  const cmd = splitTrigger(config, body);
  return prItem(config, skip, p.repository.full_name, p.pull_request, cmd, `Review: ${cmd.text}`);
}

// Each event's work item; undefined: that action isn't handled.
const ITEMS = {
  issue_comment: issueCommentItem,
  pull_request_review_comment: reviewCommentItem,
  pull_request_review: reviewItem,
  discussion: discussionItem,
  discussion_comment: discussionItem,
};

// A new discussion, or a comment on one, in the repo's discussions category: one session per
// discussion, like a brainstorm. Discussions only exist in GraphQL for writing, so the item
// keeps the node ids its reply and reactions need (comments.mjs).
function discussionItem(config, event, p, skip) {
  const d = p.discussion;
  if (p.action !== "created") return skip(`${event} ${p.action ?? ""} is not handled`);
  const category = d?.category?.name ?? "";
  if (config.inbox && normalize(category) !== config.inbox.discussions) {
    return skip(`discussion category "${category}" doesn't call Deckhand`);
  }
  const c = event === "discussion" ? null : p.comment;
  return discussionEntryItem(p.repository.full_name, d, c, (c ?? d).user, (c ?? d).body ?? "");
}

// A discussion's item ("discussion"): a new one when `c` is null, else a comment in it. From a
// webhook, or the App's post for one sent from the dashboard (discussions.mjs), where `author`
// is who sent it and `body` its text without the App's line. `d`: { number, title, html_url,
// node_id, id }; `c`: { id, node_id, html_url, parent_id }, as the webhook has them.
export function discussionEntryItem(repo, d, c, author, body) {
  const text = c
    ? entry(author, c.html_url, body)
    : `${entry(author, d.html_url, body)}\n\n(Title: ${d.title})`;
  return {
    repo,
    id: `discussion-${d.number}`,
    kind: "discussion",
    number: d.number,
    title: d.title ?? null,
    trigger: "discussion",
    text,
    replyTo: d.number,
    discussionId: d.node_id,
    // What the reply answers: the discussion itself, or a comment (its thread, see comments.mjs).
    comment: c
      ? { id: c.id, node_id: c.node_id, parent_id: c.parent_id ?? null, discussion: true }
      : { id: d.id, node_id: d.node_id, discussion: true },
  };
}

// A delivery for the repo's preview hook (previews.mjs): { repo, base, event } or null.
// Whoever opened the pull request: the hook comes from the default branch, and judges the
// event itself.
export function previewEvent(config, event, p, skip = () => null) {
  if (event !== "pull_request" && event !== "workflow_run") return null;
  const repo = p.repository?.full_name;
  if (!p.installation?.id || !repo) return skip("not from an installation of the App");
  if (!repoAllowed(config, repo)) {
    return skip(`${repo} not in ALLOWED_REPOS`);
  }
  return { repo, base: p.repository.default_branch || "main", event };
}

// An issue closed or reopened, or a pull request closed, merged or reopened, in an allowed
// repo → { repo, number, key, state } for the comments waiting for it (waits.mjs) and the
// dashboard's graph (titles.mjs), or null. `key`: its task's, "org/repo#12" or
// "org/repo#pr-5". Anyone may close an issue: what then starts is the waiting comment's run,
// whose author is checked again.
export function closedItem(config, event, p, skip = () => null) {
  if (!["closed", "reopened"].includes(p.action)) return null;
  if (event !== "issues" && event !== "pull_request") return null;
  const repo = p.repository?.full_name;
  const target = event === "issues" ? p.issue : p.pull_request;
  if (!p.installation?.id || !repo || !target) return skip("not from an installation of the App");
  if (!repoAllowed(config, repo)) {
    return skip(`${repo} not in ALLOWED_REPOS`);
  }
  const key = taskKey(repo, event === "issues" ? target.number : prId(target.number));
  if (p.action === "reopened") return { repo, number: target.number, key, state: "open" };
  // The pull_request event's own shape → the issues API's, which outcome() reads.
  const issue =
    event === "issues"
      ? target
      : { state: "closed", pull_request: { merged_at: target.merged_at ?? target.merged ?? null } };
  return { repo, number: target.number, key, state: outcome(issue) };
}

// What an `issues`, `issue_comment` or `pull_request` delivery is about, in an allowed repo →
// { repo, numbers, merged } or null: the issue or pull request, and the issue a pull request
// closes (linkedIssue(); from a comment's payload, without the head, the one it names: asking
// GitHub about it is harmless). Comments waiting for one of them ask GitHub about it again
// (waits.mjs recheck()). `merged`: the issue a pull request just merged closes.
export function touchedItems(config, event, p) {
  if (!["issues", "issue_comment", "pull_request"].includes(event)) return null;
  const repo = p.repository?.full_name;
  const target = event === "pull_request" ? p.pull_request : p.issue;
  if (!p.installation?.id || !repo || !target?.number) return null;
  if (!repoAllowed(config, repo)) return null;
  const pull = event === "pull_request" || target.pull_request;
  const issue = !pull ? null : target.head ? linkedIssue(target, repo) : closesIssue(target);
  const numbers = [target.number, ...(issue && issue !== target.number ? [issue] : [])];
  const justMerged = event === "pull_request" && p.action === "closed" && !!target.merged_at;
  return { repo, numbers, merged: justMerged ? issue : null };
}

// What an issue (GET /repos/{repo}/issues/{n}, or an `issues` payload's) means to a comment
// waiting for it: "open", "done" (closed as completed; a pull request: merged) or "not-done"
// (not planned, a duplicate; a pull request closed without merging). Issues closed before
// GitHub recorded a reason have none: completed was the only way to close one then.
export function outcome(issue) {
  if (issue.state !== "closed") return "open";
  if (issue.pull_request) return issue.pull_request.merged_at ? "done" : "not-done";
  return [null, undefined, "completed"].includes(issue.state_reason) ? "done" : "not-done";
}

// A pull request, as webhooks and the REST API describe it → its state on the dashboard.
export function prState(pr) {
  if (pr.merged || pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "ready";
}

const PR_ACTIONS = [
  "opened",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
  "closed",
  "edited",
];

// A `pull_request` delivery → { key, pr: { number, url, state, readyAt } } for the dashboard
// (pulls.mjs), or null. Its task is the issue it closes, else the pull request itself.
// `readyAt`: when it turned ready for review, which the dashboard notifies about; an edit
// or a close keeps the one recorded before (pulls.mjs).
export function pullRequest(config, event, p, now, skip = () => null) {
  if (event !== "pull_request" || !PR_ACTIONS.includes(p.action)) return null;
  const repo = p.repository?.full_name;
  const pr = p.pull_request;
  if (!p.installation?.id || !repo || !pr) return skip("not from an installation of the App");
  if (!repoAllowed(config, repo)) {
    return skip(`${repo} not in ALLOWED_REPOS`);
  }
  const issue = linkedIssue(pr, repo);
  const state = prState(pr);
  const turnedReady =
    p.action === "ready_for_review" ||
    (["opened", "reopened"].includes(p.action) && state === "ready");
  return {
    key: taskKey(repo, issue ?? prId(pr.number)),
    pr: { number: pr.number, url: pr.html_url, state, readyAt: turnedReady ? now : null },
  };
}

// `pull`: the pull request, or its issue for an issue comment. A pull request that closes an
// issue (linkedIssue()) is that issue's task, whose title the payload doesn't have (the
// dashboard fetches it, titles.mjs). One that only says it does, from an issue comment's
// payload without its head, is the pull request's own until its head is looked up
// (`claims`, see linkTo()).
function prItem(config, skip, repo, pull, { trigger, mode, after = null }, text, comment) {
  if (trigger === "stop" || mode === "brainstorm" || mode === "onboarding") {
    return skip(`${mode ?? "brainstorm"}s are on issues: pull request comments are about the code`);
  }
  const { number: pr, title } = pull;
  const item = {
    repo,
    id: prId(pr),
    kind: "pr",
    number: pr,
    title: title ?? null,
    trigger,
    modeLine: mode,
    after,
    text,
    replyTo: pr,
    comment,
  };
  const issue = linkedIssue(pull, repo, config.bot);
  if (issue) return linkTo(item, issue);
  const claims = pull.head ? null : closesIssue(pull);
  return claims ? { ...item, claims } : item;
}

// A pull request's item → that of the issue it closes, once trusted (linkedIssue()).
export function linkTo(item, issue) {
  const { claims: _, ...rest } = item;
  return { ...rest, id: String(issue), kind: "issue", number: issue, title: null };
}
