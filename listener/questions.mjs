// Issues waiting for the maintainer's answers: an `## Open questions` section in an issue's
// body labels it NEEDS_INPUT_LABEL, and an allowed user's comment takes the label off (they
// answered). Inbox runs file their issues with that section (prompts/idea.md, bug.md), and a
// hand-written issue can have one too. The questions themselves are parsed for the dashboard
// (parseQuestions()), from an issue's section or a run's reply that stopped to ask; their
// format is in ../prompts/sandbox.md. Pure, so tested on its own (../test/questions.test.mjs).
import { hasLabel } from "./comments.mjs";
import { repoAllowed } from "./config.mjs";
import { MARKER, taskKey } from "./events.mjs";

// Starts the final message of a run that stopped to ask the maintainer (../prompts/sandbox.md).
export const NEEDS_INPUT = "<!-- needs-input -->";

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
  return asks(questionsSection(body));
}

function asks(text) {
  const section = text?.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!section) return false;
  const first = section
    .split(/\n\s*\n/)[0]
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`>]/g, "")
    .trim()
    .toLowerCase();
  return !/^(none|n\/a|no (open )?questions)\b/.test(first);
}

// At most one space before it: deeper, it is nested under a question.
const ITEM = /^ ?\d{1,9}[.)]\s+(.*)$/;
const OPTION = /^\s+[-*+]\s+\[[ xX]\]\s+(.*)$/;
// A bullet or numbered line under a question that isn't an option: another format.
const LIST = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const TITLE = /^\*\*([^*]+?)(?::\*\*|\*\*:)\s*(.*)$/;
const RECOMMENDED = /\s*\(recommended\)\s*$/i;

// An "Open questions" section (or a run's questions) → { items, raw }, null when it asks
// nothing ("None"). `items`: [{ title, text, options: [{ label, recommended }] }] when every
// question follows the format, null otherwise: all or nothing, as half a form would be worse
// than the text. A paragraph before the list (an intro) or after it (the inbox link) is not a
// question.
export function parseQuestions(markdown) {
  const raw = (markdown ?? "").trim();
  if (!asks(raw)) return null;
  const other = { items: null, raw };
  const items = [];
  let item = null;
  let blank = false;
  let over = false;
  for (const line of raw.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    if (!line.trim()) {
      blank = true;
      continue;
    }
    const start = ITEM.exec(line);
    if (start) {
      // A paragraph between two questions: not one list.
      if (over) return other;
      item = question(start[1]);
      if (!item) return other;
      items.push(item);
    } else if (item && !over) {
      const option = OPTION.exec(line);
      if (option) {
        const label = option[1].replace(RECOMMENDED, "").trim();
        if (!label) return other;
        item.options.push({ label, recommended: RECOMMENDED.test(option[1]) });
      } else if (item.options.length || LIST.test(line)) {
        // Explanation lines come before the options; other lists are another format.
        if (/^\s/.test(line) || !blank) return other;
        over = true;
      } else if (/^\s/.test(line) || !blank) {
        item.text += `\n${line.trim()}`;
      } else {
        over = true;
      }
    }
    blank = false;
  }
  // Single choice: one pick at most.
  const picks = (q) => q.options.filter((o) => o.recommended).length;
  if (!items.length || items.some((q) => picks(q) > 1)) return other;
  return { items, raw };
}

function question(line) {
  const titled = TITLE.exec(line.trim());
  const text = (titled ? titled[2] : line).trim();
  if (!text) return null;
  return { title: titled ? titled[1].trim() : null, text, options: [] };
}

// The questions of a run's reply that starts with NEEDS_INPUT: its "Open questions" section
// when it has one (under "Needs your input", as the prompt's wording invites), else what
// follows its "Needs your input" heading, up to the next heading. Null when it asks nothing.
export function replyQuestions(text) {
  const reply = text ?? "";
  const at = reply.indexOf(NEEDS_INPUT);
  if (at < 0) return null;
  const after = reply.slice(at + NEEDS_INPUT.length);
  const titled = questionsSection(after);
  if (titled !== null) return parseQuestions(titled);
  const lines = after.split(/\r?\n/);
  const section = [];
  let fenced = false;
  let started = false;
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && HEADING.test(line);
    if (heading && started) break;
    if (heading || line.trim()) started = true;
    if (!heading) section.push(line);
  }
  return parseQuestions(section.join("\n"));
}

// An `issues` or `issue_comment` delivery → what it changes for the label, or null:
//   { repo, key, number, title, base, label, by, track, questions, comment, answered }
// `label`: true to add it, false to take it off, undefined to leave it. `by`: the allowed
// user whose action it is (checked again against the repo's own users), null for the App's
// bot. `track`: whether the dashboard lists the issue as waiting (undefined: unchanged).
// `bot`: the App's bot login ("<slug>[bot]"), whose issues (the inbox runs') count as allowed.
// `questions`: parseQuestions() of the body, when the issue is or stays listed. `comment`: the
// body of an issue's comment that would take the label off, which only an answer does when the
// repo's `wait_for_answers` is on (http.mjs). `answered`: the label came off an open issue.
export function inputEvent(config, event, p, bot) {
  const name = config.needsInputLabel;
  if (!name || (event !== "issues" && event !== "issue_comment")) return null;
  const repo = p.repository?.full_name;
  const issue = p.issue;
  // Fail closed: only the App's installations, on allowed repos.
  if (!p.installation?.id || !repo || !issue) return null;
  if (!repoAllowed(config, repo)) return null;
  const labelled = hasLabel(issue.labels, name);
  const change = {
    repo,
    key: taskKey(repo, issue.number),
    number: issue.number,
    title: issue.title ?? null,
    base: p.repository.default_branch,
  };
  const person = (u) =>
    !!u?.login && u.type !== "Bot" && config.users.includes(u.login.toLowerCase());
  const ours = (u) => !!bot && u?.type === "Bot" && u.login?.toLowerCase() === bot.toLowerCase();
  // Who may set it off: an allowed user (`by`) or the App's bot (null).
  const who = (u) => (person(u) ? u.login : ours(u) ? null : undefined);
  // What the dashboard shows of an issue it lists: its questions as the body has them now.
  const questions = () => parseQuestions(questionsSection(issue.body));

  if (event === "issue_comment") {
    const c = p.comment;
    if (p.action !== "created" || !labelled || !person(c?.user)) return null;
    if ((c.body ?? "").includes(MARKER)) return null;
    // Pull requests carry the label too (a run on one stopped to ask); only issues are listed,
    // and a pull request's task key isn't its number.
    if (issue.pull_request) return { ...change, title: null, label: false, by: c.user.login };
    return { ...change, label: false, by: c.user.login, track: false, comment: c.body ?? "" };
  }

  switch (p.action) {
    case "opened": {
      const by = who(issue.user);
      if (by === undefined) return null;
      if (labelled) return { ...change, track: true, questions: questions() };
      if (!hasOpenQuestions(issue.body)) return null;
      return { ...change, label: true, by, track: true, questions: questions() };
    }
    case "edited": {
      // The author's issue, edited by them, another allowed user or the bot. Only a change to
      // the section moves the label: a typo fixed elsewhere doesn't undo removing it by hand,
      // nor take off a run's.
      const by = who(p.sender);
      if (who(issue.user) === undefined || by === undefined || !p.changes?.body) return null;
      if (questionsSection(p.changes.body.from) === questionsSection(issue.body)) return null;
      const now = hasOpenQuestions(issue.body);
      // Still waiting: only what the dashboard shows changes.
      if (now === labelled) return now ? { ...change, questions: questions() } : null;
      return { ...change, label: now, by, track: now, ...(now && { questions: questions() }) };
    }
    // Whoever adds or removes it, by hand or not: the dashboard follows the issue's labels.
    case "labeled":
    case "unlabeled":
      if (!hasLabel([p.label], name)) return null;
      if (issue.state === "closed") return { ...change, track: false };
      if (p.action === "unlabeled") return { ...change, track: false, answered: true };
      return { ...change, track: true, questions: questions() };
    case "reopened":
      return labelled ? { ...change, track: true, questions: questions() } : null;
    case "closed":
    case "deleted":
    case "transferred":
      return { ...change, track: false };
    default:
      return null;
  }
}
