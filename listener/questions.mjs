// Issues waiting for the maintainer's answers: an `## Open questions` section in an issue's
// body labels it NEEDS_INPUT_LABEL, and an allowed user's comment takes the label off (they
// answered). Inbox runs file their issues with that section (prompts/idea.md, bug.md), and a
// hand-written issue can have one too. Pure, so tested on its own (../test/questions.test.mjs).
import { MARKER } from "./events.mjs";

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;

// The text of the body's "Open questions" section, up to the next heading of the same level
// or above, trimmed; null without one.
export function questionsSection(body) {
  let level = 0;
  let lines = null;
  let fenced = false;
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (lines) {
      if (heading && heading[1].length <= level) break;
      lines.push(line);
    } else if (heading && /^open questions:?$/i.test(heading[2].replace(/[*_]/g, "").trim())) {
      level = heading[1].length;
      lines = [];
    }
  }
  return lines && lines.join("\n").trim();
}

// Whether the section asks anything. Its first paragraph decides: inbox issues end with a
// line linking the inbox comment they come from, which falls in the section, after "None".
export function hasOpenQuestions(body) {
  const section = questionsSection(body)
    ?.replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (!section) return false;
  const first = section
    .split(/\n\s*\n/)[0]
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`>]/g, "")
    .trim()
    .toLowerCase();
  return !/^(none|n\/a|no (open )?questions)\b/.test(first);
}

const has = (labels, name) =>
  (labels ?? []).some((l) => (l.name ?? l).toLowerCase() === name.toLowerCase());

// An `issues` or `issue_comment` delivery → what it changes for the label, or null:
//   { repo, key, number, title, base, label, by, track }
// `label`: true to add it, false to take it off, undefined to leave it. `by`: the allowed
// user whose action it is (checked again against the repo's own users), null for the App's
// bot. `track`: whether the dashboard lists the issue as waiting (undefined: unchanged).
// `bot`: the App's bot login ("<slug>[bot]"), whose issues (the inbox runs') count as allowed.
export function inputEvent(config, event, p, bot) {
  const name = config.needsInputLabel;
  if (!name || (event !== "issues" && event !== "issue_comment")) return null;
  const repo = p.repository?.full_name;
  const issue = p.issue;
  // Fail closed: only the App's installations, on allowed repos.
  if (!p.installation?.id || !repo || !issue) return null;
  if (config.repos.length && !config.repos.includes(repo.toLowerCase())) return null;
  const labelled = has(issue.labels, name);
  const change = {
    repo,
    key: `${repo}#${issue.number}`,
    number: issue.number,
    title: issue.title ?? null,
    base: p.repository.default_branch,
  };
  const person = (u) =>
    !!u?.login && u.type !== "Bot" && config.users.includes(u.login.toLowerCase());
  const ours = (u) => !!bot && u?.type === "Bot" && u.login?.toLowerCase() === bot.toLowerCase();
  // Who may set it off: an allowed user (`by`) or the App's bot (null).
  const who = (u) => (person(u) ? u.login : ours(u) ? null : undefined);

  if (event === "issue_comment") {
    const c = p.comment;
    if (p.action !== "created" || !labelled || !person(c?.user)) return null;
    if ((c.body ?? "").includes(MARKER)) return null;
    // Pull requests carry the label too (a run on one stopped to ask); only issues are listed,
    // and a pull request's task key isn't its number.
    if (issue.pull_request) return { ...change, title: null, label: false, by: c.user.login };
    return { ...change, label: false, by: c.user.login, track: false };
  }

  switch (p.action) {
    case "opened": {
      const by = who(issue.user);
      if (by === undefined) return null;
      if (labelled) return { ...change, track: true };
      return hasOpenQuestions(issue.body) ? { ...change, label: true, by, track: true } : null;
    }
    case "edited": {
      // The author's issue, edited by them, another allowed user or the bot. Only a change to
      // the section moves the label: a typo fixed elsewhere doesn't undo removing it by hand,
      // nor take off a run's.
      const by = who(p.sender);
      if (who(issue.user) === undefined || by === undefined || !p.changes?.body) return null;
      if (questionsSection(p.changes.body.from) === questionsSection(issue.body)) return null;
      const now = hasOpenQuestions(issue.body);
      if (now === labelled) return null;
      return { ...change, label: now, by, track: now };
    }
    // Whoever adds or removes it, by hand or not: the dashboard follows the issue's labels.
    case "labeled":
    case "unlabeled":
      if (!has([p.label], name)) return null;
      return { ...change, track: p.action === "labeled" && issue.state !== "closed" };
    case "reopened":
      return labelled ? { ...change, track: true } : null;
    case "closed":
    case "deleted":
    case "transferred":
      return { ...change, track: false };
    default:
      return null;
  }
}
