// Webhook deliveries → work items: signature check, allowlist, trigger lines. No state, so
// it is tested on its own (../test/events.test.mjs).
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalize, repoAllowed } from "./config.mjs";

// Marks our own comments, in case one ever reaches us from another account than the bot's.
export const MARKER = "<!-- deckhand -->";
// The signed "from" line's tag begins "<!--", spaces allowed, then this.
const FROM = "deckhand-from:";

// Text a dashboard user wrote, without the marks the listener puts on the App's posts (the
// marker, the signed "from" line's tag, discussions.mjs fromLine()): posted as the App, it
// would pass for Deckhand's answer or someone else's words. In one pass, each mark taken out
// as its last character comes in, so the text around it can't join into another
// ("<!-- deck<!-- deckhand -->hand -->"): what is left has none, and a run of unclosed tags
// isn't read again for each of them, as a lazy regex would (#742). Text a cut joins is read as
// it forms, not on a later pass: a marker joined inside an open tag is gone before its "-->"
// could close the tag, which runs on to the next "-->", or stays unclosed (kept) without one.
export function unmarked(text) {
  const s = String(text);
  const out = [];
  // Where the first unclosed "<!-- deckhand-from:" begins in `out`, -1 without one.
  let from = -1;
  for (let i = 0; i < s.length; i++) {
    out.push(s[i]);
    if (endsWith(out, MARKER)) out.length -= MARKER.length;
    else if (from >= 0 && endsWith(out, "-->")) {
      out.length = from;
      from = -1;
    } else if (from < 0 && endsWith(out, FROM)) from = opening(out, out.length - FROM.length);
  }
  return out.join("");
}

function endsWith(chars, tail) {
  const at = chars.length - tail.length;
  if (at < 0) return false;
  for (let i = 0; i < tail.length; i++) if (chars[at + i] !== tail[i]) return false;
  return true;
}

// Where the "<!--" before `at` begins, spaces between them allowed, -1 without one.
function opening(chars, at) {
  let i = at;
  while (i > 0 && /\s/.test(chars[i - 1])) i--;
  return i >= 4 && chars.slice(i - 4, i).join("") === "<!--" ? i - 4 : -1;
}

// A task's key: "org/repo#12" (an issue), "org/repo#pr-5" (a pull request of its own),
// "org/repo#discussion-8". `id`: its items' (prId(), String(n), discussion-<n>).
export const taskKey = (repo, id) => `${repo}#${id}`;

// Task `key` of `repo` on the dashboard at `url` (PUBLIC_URL), one of its runs open when `run`
// is given: the address dashboard/src/route.ts formatRoute() makes.
export function dashboardLink(url, repo, key, run = null) {
  return `${url}/#/${repo}?task=${encodeURIComponent(key)}${run ? `&run=${encodeURIComponent(run)}` : ""}`;
}

// GitHub's repo names ignore case: "Org/Repo" and "org/repo" are one repo.
export const sameRepo = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

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
function closesIssue(pr) {
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(pr?.body ?? "");
  return match ? Number(match[1]) : null;
}

// Its head branch is in the repo, not a fork. An issue comment's payload has no head: only the
// App's own pull requests (Claude's, always on a branch of the repo) are trusted from it, the
// others are looked up (tasks.mjs admit()). Not any bot: github-actions or another App may
// open pull requests from outsiders' input.
function trustedPull(pr, repo, bot) {
  if (pr.head) return headInRepo(pr, repo);
  return !!bot && pr.user?.login?.toLowerCase() === bot.toLowerCase();
}

// Whether a pull request's head branch is in `repo`, not a fork (whose head repo may be gone).
export function headInRepo(pr, repo) {
  return sameRepo(pr.head?.repo?.full_name, repo);
}

// The command on the first line ("work" for the trigger, "stop" for "/stop", "cancel" for
// "/cancel": stop the running run, tasks.mjs), the mode a
// "/mode <name>" line asks for (lowercase, or null), what an "/after #12" line waits for
// (parseAfter(), or null), the machine a "/machine <name or label>" line routes the issue to
// (parseMachine(), or null: claims.mjs) and the rest of the comment; trigger null and the whole
// comment when there is none. The trigger is the whole first line, so "Deckhand is down" starts
// nothing; "/mode", "/after", "/machine", "/model", "/effort", "/speed" and "/agent" may follow
// it there ("Deckhand /mode brainstorm", "Deckhand /agent codex"): the last four stay in the
// text, for takeOptions().
export function splitTrigger(config, body) {
  const [first, ...rest] = body.split(/\r?\n/);
  if (first.trim().toLowerCase() === "/stop") return takeCommands(rest.join("\n"), "stop");
  if (first.trim().toLowerCase() === "/cancel") return takeCommands(rest.join("\n"), "cancel");
  // Each command its own line, as if written below; anything else on the line and it isn't
  // the trigger line ("Deckhand /mode brainstorm please", "Deckhand /effort huge").
  const inline = trailingCommands(first, ["mode", "after", "machine", ...OPTIONS]);
  if (inline && normalize(inline.head) === config.trigger) {
    return takeCommands([...inline.commands, ...rest].join("\n"), "work");
  }
  if (normalize(first) === config.trigger) return takeCommands(rest.join("\n"), "work");
  return takeCommands(body, null);
}

// The run of commands (`names`, without their slash) a line ends with, each a line of its own:
// { head, commands } or null. The longest run whose commands are all known: "use /model x, then
// /effort high" still ends with "/effort high"; a command in the middle of a sentence ("use
// /effort high to …") or with a refused value ("/effort huge") ends none.
export function trailingCommands(line, names) {
  // Only from the start of a run of spaces: from inside one, the search would be quadratic.
  const start = new RegExp(`(?<!\\s)\\s+(?=\\/(?:${names.join("|")})\\s)`, "gi");
  const known = (l) =>
    /^\/mode\s+[\w-]+$/i.test(l) || /^\/(?:after|machine)\s/i.test(l) || !takeOptions(l, {});
  for (const match of line.matchAll(start)) {
    const commands = line.slice(match.index).trim().split(start);
    if (commands.every(known)) return { head: line.slice(0, match.index), commands };
  }
  return null;
}

// Removes the "/mode <name>", "/after …" and "/machine …" lines. Their own lines, like
// "/model": the space keeps "/mode" and "/model" apart. The last of each wins.
function takeCommands(text, trigger) {
  let mode = null;
  let after = null;
  let machine = null;
  const kept = text.split(/\r?\n/).filter((line) => {
    const match = /^\s*\/mode\s+([\w-]+)\s*$/i.exec(line);
    if (match) mode = match[1].toLowerCase();
    const wait = /^\s*\/after(?:\s+(.*?))?\s*$/i.exec(line);
    if (wait) after = parseAfter(wait[1] ?? "");
    const route = /^\s*\/machine(?:\s+(.*?))?\s*$/i.exec(line);
    if (route) machine = parseMachine(route[1] ?? "");
    return !match && !wait && !route;
  });
  return { trigger, mode, after, machine, text: kept.join("\n").trim() };
}

// The longest machine name a "/machine" line takes (machines.mjs's own).
const MACHINE_NAME = 64;

// What follows "/machine": { want } (a name of one of its author's machines, or a label they
// carry, as written), { none: true } (back to sandboxes) or { error } (what the reply says).
export function parseMachine(text) {
  const want = text.trim();
  if (!want) {
    return {
      error: "`/machine` needs a machine: its name or a label (`/machine unreal`), or `none`.",
    };
  }
  if (want.toLowerCase() === "none") return { none: true };
  if (want.length > MACHINE_NAME || /\p{Cc}/u.test(want)) {
    return {
      error: `\`/machine\` takes a machine's name or a label, ${MACHINE_NAME} characters at most.`,
    };
  }
  return { want };
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

// Claude Code's fast mode (`/speed fast`): the same model, faster output, a higher price.
// Agents without it run at normal speed (agents/select.mjs speedFor()).
export const SPEEDS = ["normal", "fast"];

// The commands takeOptions() records, without their slash.
const OPTIONS = ["model", "effort", "speed", "agent"];

// A model: a tier (best, balanced, fast: agents/), an alias (opus), an id
// (claude-opus-5-5[1m]) or a gateway's (anthropic/claude-opus-5.5, openai/gpt-5,
// meta-llama/llama-4:free).
export const MODEL_NAME = /^[\w.[\]/:-]+$/;

// An agent, on a provider or not (codex, claude@openrouter), or `default`: checked against the
// operator's when the run starts (agents/select.mjs pickProblem()).
const AGENT_NAME = /^[\w.-]+(@[\w.-]+)?$/;

// Removes "/model <name>", "/effort <level>", "/speed <speed>" and "/agent <name>" lines from a
// comment, recording them in options.
export function takeOptions(text, options) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*\/(model|effort|speed|agent)\s+(\S+)\s*$/i.exec(line);
      if (!match) return true;
      const key = match[1].toLowerCase();
      const value = key === "model" ? match[2] : match[2].toLowerCase();
      if (key === "effort" && !EFFORTS.includes(value)) return true;
      if (key === "speed" && !SPEEDS.includes(value)) return true;
      if (key === "model" && !MODEL_NAME.test(value)) return true;
      if (key === "agent" && !AGENT_NAME.test(value)) return true;
      options[key] = value;
      return false;
    })
    .join("\n")
    .trim();
}

// Whether a comment says anything besides its trigger and command lines ("/mode", "/after",
// "/model", "/effort", "/speed", "/agent"): only then does it answer an issue's open questions (tasks.mjs).
export function saysMore(config, body) {
  return !!takeOptions(splitTrigger(config, body ?? "").text, {});
}

// Comments as the agent reads them, one after the other, without their "/model", "/effort",
// "/speed" and "/agent" lines (collected in `options`).
export function commentsText(items, options) {
  return items
    .map((i) => takeOptions(i.text, options))
    .filter(Boolean)
    .join("\n\n---\n\n");
}

// An inbox entry, as Claude reads it: who wrote it and where, so its reply can link back.
// Entries have no trigger line: "/model", "/effort", "/speed" and "/agent" may end any of their lines
// ("Do X /effort high"), put on lines of their own for takeOptions(). "/mode" and "/after"
// don't apply to entries: they stay text, and so do code blocks and quotes, where a bug report
// shows a command rather than gives one.
function entry(author, url, body) {
  let fenced = false;
  const lines = body
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced || /^\s*(```|~~~|>)/.test(line)) return line;
      const run = trailingCommands(line, OPTIONS);
      return run ? [run.head.trimEnd(), ...run.commands].filter(Boolean).join("\n") : line;
    });
  return `From @${author.login}${url ? ` (${url})` : ""}:\n\n${lines.join("\n")}`;
}

// What a skip() of the operator's checks passes as its second argument: the delivery is refused
// (a repo out of ALLOWED_REPOS, an author out of ALLOWED_USERS, not from an installation), not
// merely of no use (its metric, metrics.mjs deliveryResult()).
export const REFUSED = "refused";

// Returns { repo, id, kind, number, trigger, modeLine, text, replyTo, comment } or null to
// ignore. `modeLine`: what a "/mode <name>" line asks for, checked against the repo's modes later.
// `skip(reason, REFUSED?)` logs why a delivery is ignored and returns null: deliveries that do nothing
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
  if (!p.installation?.id) return skip("not from an installation of the App", REFUSED);
  // A pull request's state and CI's runs: reviews.mjs follows them, nothing runs Claude for them.
  if (event === "pull_request" || event === "workflow_run") return skip(`${event}: nothing to run`);
  if (!repo || !author) return skip("not a comment");
  if (!repoAllowed(config, repo)) {
    return skip(`${repo} not in ALLOWED_REPOS`, REFUSED);
  }
  if (author.type === "Bot") return skip("comment by a bot");
  if (!config.users.includes(author.login.toLowerCase())) {
    return skip(`${author.login} not in ALLOWED_USERS`, REFUSED);
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
  const { trigger, mode, after, machine, text } = splitTrigger(config, body);
  if (p.issue.pull_request) {
    return prItem(config, skip, repo, p.issue, { trigger, mode, after, machine }, text, p.comment);
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
  return issueItem(repo, p.issue, {
    comment: p.comment,
    trigger,
    modeLine: mode,
    after,
    machine,
    text,
  });
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
    return skip(`${repo} not in ALLOWED_REPOS`, REFUSED);
  }
  const key = taskKey(repo, event === "issues" ? target.number : prId(target.number));
  if (p.action === "reopened") return { repo, number: target.number, key, state: "open" };
  // The pull_request event's own shape → the issues API's, which issueOutcome() reads.
  const issue =
    event === "issues"
      ? target
      : { state: "closed", pull_request: { merged_at: target.merged_at ?? target.merged ?? null } };
  return { repo, number: target.number, key, state: issueOutcome(issue) };
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
export function issueOutcome(issue) {
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
  // A push to its branch: its size and commit count change.
  "synchronize",
];

// A `pull_request` delivery → { key, pr: { number, url, state, readyAt, …size } } for the
// dashboard (pulls.mjs), or null. Its task is the issue it closes, else the pull request itself.
// `readyAt`: when it turned ready for review, which the dashboard notifies about; an edit
// or a close keeps the one recorded before (pulls.mjs).
export function pullRequest(config, event, p, now, skip = () => null) {
  if (event !== "pull_request" || !PR_ACTIONS.includes(p.action)) return null;
  const repo = p.repository?.full_name;
  const pr = p.pull_request;
  if (!p.installation?.id || !repo || !pr) return skip("not from an installation of the App");
  if (!repoAllowed(config, repo)) {
    return skip(`${repo} not in ALLOWED_REPOS`, REFUSED);
  }
  const turnedReady =
    p.action === "ready_for_review" ||
    (["opened", "reopened"].includes(p.action) && prState(pr) === "ready");
  return pullEntry(repo, pr, turnedReady ? now : null);
}

// A redelivered `pull_request` delivery (redeliveries.mjs), with the pull request as GitHub
// has it now (`current`): its payload is as old as the attempt that failed, maybe older than
// deliveries handled since. An action the pull request no longer matches (ready since merged,
// a draft since made ready, a label put back since it came off or taken off since it was put
// on) becomes `edited`: its current state is recorded, and nothing turns ready, closes, starts
// a review or moves a run's questions from it. `replayed_updated_at`: the pull request's
// `updated_at` in the payload, when the delivery happened, which `current` no longer says.
export function replayedPull(payload, current) {
  const state = prState(current);
  const open = state === "ready" || state === "draft";
  const labelled = () => hasLabel(current.labels, payload.label?.name);
  const still =
    {
      ready_for_review: state === "ready",
      converted_to_draft: state === "draft",
      opened: open,
      reopened: open,
      closed: !open,
      labeled: labelled(),
      unlabeled: !labelled(),
    }[payload.action] ?? true;
  return {
    ...payload,
    action: still ? payload.action : "edited",
    pull_request: current,
    replayed_updated_at: payload.pull_request?.updated_at ?? null,
  };
}

// A redelivered `issues` delivery (redeliveries.mjs), checked against the issue as GitHub has
// it now (`current`): its label or close action, when the issue no longer matches it (the label
// put back since it came off or taken off since, reopened since it closed or closed since),
// becomes `edited`, which sets no run's questions aside (questions.mjs) and closes nothing. Its
// own payload stays: when it happened is what it says (`updated_at`, `closed_at`).
export function replayedIssue(payload, current) {
  const open = current.state !== "closed";
  const labelled = () => hasLabel(current.labels, payload.label?.name);
  const still =
    {
      labeled: labelled,
      unlabeled: () => !labelled(),
      closed: () => !open,
      reopened: () => open,
    }[payload.action]?.() ?? true;
  return still ? payload : { ...payload, action: "edited" };
}

// Whether `labels` (an issue's or pull request's, as GitHub has them: names or { name }) hold
// `name`. GitHub's label names are case-insensitive: a "Needs-Input" set by hand is the same
// label.
export function hasLabel(labels, name) {
  if (!name) return false;
  const wanted = name.toLowerCase();
  return (labels ?? []).some(
    (l) => (typeof l === "string" ? l : l?.name)?.toLowerCase() === wanted,
  );
}

// A pull request as GitHub has it → { key, pr } for the dashboard (pulls.mjs record()): the
// task of the issue it closes, else its own. `readyAt`: when it turned ready, if it just did.
// Its size and commit count when GitHub sent them: a single pull request and webhooks have
// them, listings don't. `head`: its head commit, whose CI the dashboard shows (pulls.mjs), with
// `updatedAt`, and which it compares with the last review's (a commit pushed after it, #535).
export function pullEntry(repo, pr, readyAt = null) {
  return {
    key: taskKey(repo, linkedIssue(pr, repo) ?? prId(pr.number)),
    pr: {
      number: pr.number,
      url: pr.html_url,
      state: prState(pr),
      readyAt,
      ...pullSize(pr),
      ...mergeConflict(pr),
      ...(typeof pr.head?.sha === "string" && { head: pr.head.sha }),
      // When GitHub last changed it: an older delivery handled late doesn't move the head back.
      ...(Number.isFinite(Date.parse(pr.updated_at)) && { updatedAt: Date.parse(pr.updated_at) }),
    },
  };
}

// A delivery that says CI changed on a commit (an Actions run requested, going or completed, a
// check suite completed, a commit status posted) → { repo, sha }, or null.
export function ciDelivery(config, event, p) {
  const sha =
    event === "workflow_run"
      ? p.workflow_run?.head_sha
      : event === "check_suite"
        ? p.check_suite?.head_sha
        : event === "status"
          ? p.sha
          : null;
  const repo = p.repository?.full_name;
  if (typeof sha !== "string" || !sha || !p.installation?.id || !repo) return null;
  return repoAllowed(config, repo) ? { repo, sha } : null;
}

// A `check_suite` or `status` delivery (github-app.mjs QUIET_EVENTS) as edge passes it on: only
// what ciDelivery() reads of it, or null when it reads nothing (another repo's, no commit). A
// status's payload holds the whole commit, its branches and repository.
export function quietPayload(config, event, p) {
  const ci = ciDelivery(config, event, p);
  if (!ci) return null;
  return {
    ...(p.action && { action: p.action }),
    installation: { id: p.installation.id },
    repository: { full_name: ci.repo },
    ...(event === "check_suite" ? { check_suite: { head_sha: ci.sha } } : { sha: ci.sha }),
  };
}

// { conflict } of a pull request as GitHub has it: whether it conflicts with its base, once
// GitHub computed it; {} while it hasn't (`mergeable: null`, as webhooks often send it), so the
// one known stays (pulls.mjs record()). Merely behind its base isn't a conflict.
export function mergeConflict(pr) {
  if (typeof pr?.mergeable !== "boolean" || pr.mergeable_state === "unknown") return {};
  return { conflict: pr.mergeable === false || pr.mergeable_state === "dirty" };
}

// A pull request's size fields, the dashboard's name → GitHub's.
export const PULL_SIZE = {
  additions: "additions",
  deletions: "deletions",
  changedFiles: "changed_files",
  commits: "commits",
};

// { additions, deletions, changedFiles, commits } of a pull request as GitHub has it, those it
// has.
export function pullSize(pr) {
  return Object.fromEntries(
    Object.entries(PULL_SIZE)
      .filter(([, field]) => Number.isInteger(pr?.[field]))
      .map(([name, field]) => [name, pr[field]]),
  );
}

// `pull`: the pull request, or its issue for an issue comment. A pull request that closes an
// issue (linkedIssue()) is that issue's task, whose title the payload doesn't have (the
// dashboard fetches it, titles.mjs). One that only says it does, from an issue comment's
// payload without its head, is the pull request's own until its head is looked up
// (`claims`, see linkTo()). Brainstorms, `/stop` and onboarding are refused there by Deckhand's
// policy/run.rego (`allow_run`, run-policy.mjs), which an operator may replace.
function prItem(
  config,
  skip,
  repo,
  pull,
  { trigger, mode, after = null, machine = null },
  text,
  comment,
) {
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
    machine,
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
