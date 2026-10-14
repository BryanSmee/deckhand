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

// The command on the first line ("work", "brainstorm" or "stop") and the rest of the comment;
// trigger null and the whole comment when there is none.
export function splitTrigger(config, body) {
  const [first, ...rest] = body.split(/\r?\n/);
  const line = normalize(first);
  const trigger =
    line === config.trigger
      ? "work"
      : line === config.brainstormTrigger
        ? "brainstorm"
        : line === config.stopTrigger || first.trim().toLowerCase() === "/stop"
          ? "stop"
          : null;
  return trigger ? { trigger, text: rest.join("\n").trim() } : { trigger: null, text: body.trim() };
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

// Returns { repo, id, kind, number, trigger, text, replyTo, comment } or null to ignore.
// `skip(reason)` logs why a delivery is ignored and returns null: deliveries that do nothing
// are the usual question.
export function workItem(config, event, p, skip = () => null) {
  const repo = p.repository?.full_name;
  const author = (p.comment ?? p.review)?.user;
  const body = (p.comment ?? p.review)?.body ?? "";
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

  if (event === "issue_comment" && p.action === "created") {
    const { trigger, text } = splitTrigger(config, body);
    if (!p.issue.pull_request) {
      const n = p.issue.number;
      return {
        repo,
        id: String(n),
        kind: "issue",
        number: n,
        trigger,
        text,
        replyTo: n,
        comment: p.comment,
      };
    }
    return prItem(skip, repo, p.issue.number, p.issue.body, trigger, text, p.comment);
  }
  if (event === "pull_request_review_comment" && p.action === "created") {
    const { trigger, text } = splitTrigger(config, body);
    const c = p.comment;
    const where = `Review comment on \`${c.path}\` line ${c.line ?? c.original_line}:\n\`\`\`diff\n${c.diff_hunk}\n\`\`\`\n`;
    return prItem(skip, repo, p.pull_request.number, p.pull_request.body, trigger, where + text, {
      ...c,
      review: true,
    });
  }
  if (event === "pull_request_review" && p.action === "submitted" && body.trim()) {
    const { trigger, text } = splitTrigger(config, body);
    return prItem(
      skip,
      repo,
      p.pull_request.number,
      p.pull_request.body,
      trigger,
      `Review: ${text}`,
    );
  }
  return skip(`${event} ${p.action ?? ""} is not handled`);
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

function prItem(skip, repo, pr, prBody, trigger, text, comment) {
  if (trigger === "brainstorm" || trigger === "stop") {
    return skip("brainstorms are on issues: pull request comments are about the code");
  }
  const issue = linkedIssue(prBody);
  return issue
    ? {
        repo,
        id: String(issue),
        kind: "issue",
        number: issue,
        trigger,
        text,
        replyTo: pr,
        comment,
      }
    : {
        repo,
        id: `pr-${pr}`,
        kind: "pr",
        number: pr,
        trigger,
        text,
        replyTo: pr,
        comment,
      };
}
