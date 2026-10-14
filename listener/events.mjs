// Webhook deliveries → work items: signature check, allowlist, trigger lines. No state, so
// it is tested on its own (../test/events.test.mjs).
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalize } from "./config.mjs";

// Marks our own comments, in case one ever reaches us from another account than the bot's.
export const MARKER = "<!-- deckhand -->";

// GitHub's X-Hub-Signature-256 for the raw body, compared in constant time.
export function verified(secret, signature, body) {
  if (!secret) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(signature ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The issue a pull request belongs to, from the "Closes #12" Claude puts in its description.
export function linkedIssue(prBody) {
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(prBody ?? "");
  return match ? Number(match[1]) : null;
}

// The command on the first line ("work" for the trigger, "stop" for "/stop"), the mode a
// "/mode <name>" line asks for (lowercase, or null) and the rest of the comment; trigger null
// and the whole comment when there is none. The trigger is the whole first line, so "Deckhand
// is down" starts nothing; "/mode" may follow it there ("Deckhand /mode brainstorm").
export function splitTrigger(config, body) {
  const [first, ...rest] = body.split(/\r?\n/);
  if (first.trim().toLowerCase() === "/stop") return takeMode(rest.join("\n"), "stop");
  const inline = /^(.*?)\s+(\/mode\s+[\w-]+)\s*$/i.exec(first);
  if (inline && normalize(inline[1]) === config.trigger) {
    return takeMode([inline[2], ...rest].join("\n"), "work");
  }
  if (normalize(first) === config.trigger) return takeMode(rest.join("\n"), "work");
  return takeMode(body, null);
}

// Removes a "/mode <name>" line. Its own line, like "/model": the space keeps the two apart.
function takeMode(text, trigger) {
  let mode = null;
  const kept = text.split(/\r?\n/).filter((line) => {
    const match = /^\s*\/mode\s+([\w-]+)\s*$/i.exec(line);
    if (match) mode = match[1].toLowerCase();
    return !match;
  });
  return { trigger, mode, text: kept.join("\n").trim() };
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Removes "/model <name>" and "/effort <level>" lines from a comment, recording them in options.
export function takeOptions(text, options) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*\/(model|effort)\s+([\w.[\]-]+)\s*$/i.exec(line);
      if (!match) return true;
      const [, key, value] = match;
      if (key.toLowerCase() === "effort" && !EFFORTS.includes(value.toLowerCase())) return true;
      options[key.toLowerCase()] = key.toLowerCase() === "effort" ? value.toLowerCase() : value;
      return false;
    })
    .join("\n")
    .trim();
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
  if (event === "installation" || event === "installation_repositories") {
    return skip(`${event} ${p.action ?? ""} by ${p.sender?.login ?? "?"}`);
  }
  // Fail closed: only deliveries for one of the App's installations.
  if (!p.installation?.id) return skip("not from an installation of the App");
  // The preview hook's (previewEvent()); nothing runs Claude for them.
  if (event === "pull_request" || event === "workflow_run") return skip(`${event}: no hook`);
  if (!repo || !author) return skip("not a comment");
  if (config.repos.length && !config.repos.includes(repo.toLowerCase())) {
    return skip(`${repo} not in ALLOWED_REPOS`);
  }
  if (author.type === "Bot") return skip("comment by a bot");
  if (!config.users.includes(author.login.toLowerCase())) {
    return skip(`${author.login} not in ALLOWED_USERS`);
  }
  if (body.includes(MARKER)) return skip("our own reply");

  if (event === "discussion" || event === "discussion_comment") {
    return discussionItem(config, event, p, skip);
  }
  if (event === "issue_comment" && p.action === "created") {
    const { trigger, mode, text } = splitTrigger(config, body);
    if (!p.issue.pull_request) {
      const n = p.issue.number;
      // Every comment on an inbox issue is an entry: trigger lines don't apply there.
      const inbox = [
        ["idea", config.inbox?.ideas],
        ["bug", config.inbox?.bugs],
      ].find(([, number]) => number === n)?.[0];
      if (inbox) {
        return {
          repo,
          id: String(n),
          kind: "issue",
          number: n,
          title: p.issue.title ?? null,
          trigger: inbox,
          text: entry(author, p.comment.html_url, body),
          replyTo: n,
          comment: p.comment,
        };
      }
      return {
        repo,
        id: String(n),
        kind: "issue",
        number: n,
        title: p.issue.title ?? null,
        trigger,
        modeLine: mode,
        text,
        replyTo: n,
        comment: p.comment,
      };
    }
    const pr = { number: p.issue.number, title: p.issue.title, body: p.issue.body };
    return prItem(skip, repo, pr, { trigger, mode }, text, p.comment);
  }
  if (event === "pull_request_review_comment" && p.action === "created") {
    const cmd = splitTrigger(config, body);
    const c = p.comment;
    const where = `Review comment on \`${c.path}\` line ${c.line ?? c.original_line}:\n\`\`\`diff\n${c.diff_hunk}\n\`\`\`\n`;
    return prItem(skip, repo, p.pull_request, cmd, where + cmd.text, {
      ...c,
      review: true,
    });
  }
  if (event === "pull_request_review" && p.action === "submitted" && body.trim()) {
    const cmd = splitTrigger(config, body);
    return prItem(skip, repo, p.pull_request, cmd, `Review: ${cmd.text}`);
  }
  return skip(`${event} ${p.action ?? ""} is not handled`);
}

// A new discussion, or a comment on one, in the repo's discussions category: one session per
// discussion, like a brainstorm. Discussions only exist in GraphQL for writing, so the item
// keeps the node ids its reply and reactions need (server.mjs).
function discussionItem(config, event, p, skip) {
  const d = p.discussion;
  if (p.action !== "created") return skip(`${event} ${p.action ?? ""} is not handled`);
  const category = d?.category?.name ?? "";
  if (config.inbox && normalize(category) !== config.inbox.discussions) {
    return skip(`discussion category "${category}" doesn't call Claude`);
  }
  const c = event === "discussion" ? null : p.comment;
  const text = c
    ? entry(c.user, c.html_url, c.body ?? "")
    : `${entry(d.user, d.html_url, d.body ?? "")}\n\n(Title: ${d.title})`;
  return {
    repo: p.repository.full_name,
    id: `discussion-${d.number}`,
    kind: "discussion",
    number: d.number,
    title: d.title ?? null,
    trigger: "discussion",
    text,
    replyTo: d.number,
    discussionId: d.node_id,
    // What the reply answers: the discussion itself, or a comment (its thread, see server.mjs).
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
  if (config.repos.length && !config.repos.includes(repo.toLowerCase())) {
    return skip(`${repo} not in ALLOWED_REPOS`);
  }
  return { repo, base: p.repository.default_branch || "main", event };
}

// `pr`: { number, title, body }. A pull request that closes an issue is that issue's task,
// whose title the payload doesn't have (the dashboard fetches it, titles.mjs).
function prItem(skip, repo, { number: pr, title, body: prBody }, { trigger, mode }, text, comment) {
  if (trigger === "stop" || mode === "brainstorm") {
    return skip("brainstorms are on issues: pull request comments are about the code");
  }
  const issue = linkedIssue(prBody);
  return issue
    ? {
        repo,
        id: String(issue),
        kind: "issue",
        number: issue,
        title: null,
        trigger,
        modeLine: mode,
        text,
        replyTo: pr,
        comment,
      }
    : {
        repo,
        id: `pr-${pr}`,
        kind: "pr",
        number: pr,
        title: title ?? null,
        trigger,
        modeLine: mode,
        text,
        replyTo: pr,
        comment,
      };
}
