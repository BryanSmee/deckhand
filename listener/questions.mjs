// Issues waiting for the maintainer's answers: an `## Open questions` section in an issue's
// body labels it NEEDS_INPUT_LABEL, and an allowed user's comment, or a box ticked in every
// question, takes the label off (they answered). Inbox runs file their issues with that section
// (prompts/idea.md, bug.md), and a hand-written issue can have one too. The questions
// themselves are parsed for the dashboard (parseQuestions()), from an issue's section or a
// run's reply that stopped to ask; their format is in ../prompts/sandbox.md. Pure, so tested on
// its own (../test/questions.test.mjs), apart from applyInput(), which acts on what a delivery
// changes.
import { hasLabel, labelFailed } from "./comments.mjs";
import { repoAllowed } from "./config.mjs";
import { MARKER, prId, saysMore, taskKey } from "./events.mjs";
import { CONFIG_FILE, effectiveConfig } from "./repo-config.mjs";
import { Refused } from "../lib/http.mjs";

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
const OPTION = /^\s+[-*+]\s+\[([ xX])\]\s+(.*)$/;
// A bullet or numbered line under a question that isn't an option: another format, unless
// it is a bullet explanation line (BULLET) that options follow. A box that isn't an option
// (empty, mistyped: up to three characters in its brackets, not a link) is neither.
const LIST = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const BULLET = /^\s+[-*+]\s+(\S.*)$/;
const BOX = /^\[[^\]]{0,3}\](?!\()/;
const TITLE = /^\*\*([^*]+?)(?::\*\*|\*\*:)\s*(.*)$/;
const RECOMMENDED = /\s*\(recommended\)\s*$/i;

// An "Open questions" section (or a run's questions) → { items, raw }, null when it asks
// nothing ("None"). `items`: [{ title, text, options: [{ label, recommended, checked }] }]
// when every question follows the format, null otherwise: all or nothing, as half a form would
// be worse than the text. `checked`: the option's box is ticked ("[x]"), the maintainer's
// answer. A paragraph before the list (an intro) or after it (the inbox link) is not a
// question.
export function parseQuestions(markdown) {
  const raw = (markdown ?? "").trim();
  if (!asks(raw)) return null;
  const other = { items: null, raw };
  const items = [];
  let item = null;
  let blank = false;
  let over = false;
  // The question has a bullet explanation line: agents write one as the options' list
  // starts right below. It is one only if options follow it, else the bullets are a list.
  let loose = false;
  for (const line of raw.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    if (!line.trim()) {
      blank = true;
      continue;
    }
    const start = ITEM.exec(line);
    if (start) {
      // A paragraph between two questions: not one list.
      if (over || loose) return other;
      item = question(start[1]);
      if (!item) return other;
      items.push(item);
    } else if (item && !over) {
      const option = OPTION.exec(line);
      const bullet = !item.options.length && BULLET.exec(line);
      if (option) {
        const label = option[2].replace(RECOMMENDED, "").trim();
        if (!label) return other;
        loose = false;
        item.options.push({
          label,
          recommended: RECOMMENDED.test(option[2]),
          checked: option[1] !== " ",
        });
      } else if (bullet && !BOX.test(bullet[1])) {
        item.text += `\n${bullet[1].trim()}`;
        loose = true;
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
  if (loose || !items.length || items.some((q) => picks(q) > 1)) return other;
  return { items, raw };
}

// Whether parsed questions (parseQuestions()) are all answered by their ticked boxes: every
// one has options, and one of them ticked. A free-text question needs a comment.
export function allTicked(questions) {
  const items = questions?.items;
  return !!items?.length && items.every((q) => q.options.some((o) => o.checked));
}

// Whether an issue's body still waits for answers: its section asks something, and its boxes
// don't answer it all (allTicked()).
export function stillAsks(body) {
  return hasOpenQuestions(body) && !allTicked(parseQuestions(questionsSection(body)));
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

// An `issues`, `issue_comment` or `pull_request` delivery → what it changes for the label, or
// null:
//   { repo, key, number, title, base, label, by, track, questions, comment, answered }
// `label`: true to add it, false to take it off, undefined to leave it. `by`: the allowed
// user whose action it is (checked again against the repo's own users), null for the App's
// bot. `track`: whether the dashboard lists the issue as waiting (undefined: unchanged).
// `bot`: the App's bot login ("<slug>[bot]"), whose issues (the inbox runs') count as allowed.
// `questions`: parseQuestions() of the body, when the issue is or stays listed. `comment`: the
// body of an issue's comment that would take the label off, which only an answer does when the
// repo's `wait_for_answers` is on (http.mjs). `answered`: the label came off an open issue.
// `reply`: a run's reply its ticked boxes may answer (tickedReply()). `ignoredTicks`: the
// section is fully ticked by ticks that answer nothing, the bot's say (editedInput()); `ticked`:
// the label comes off for its ticks. `unlabelled`: { by }, the label taken off the issue or
// pull request by someone other than the App's bot, which sets its task's last run's questions
// aside; `relabelled`: { by }, put back on a pull request, which makes them ask again.
export function inputEvent(config, event, p, bot) {
  const name = config.needsInputLabel;
  if (event === "pull_request") return name ? pullLabel(config, p, name, bot) : null;
  if (!name || (event !== "issues" && event !== "issue_comment")) return null;
  const repo = p.repository?.full_name;
  const issue = p.issue;
  // Fail closed: only the App's installations, on allowed repos.
  if (!p.installation?.id || !repo || !issue) return null;
  if (!repoAllowed(config, repo)) return null;
  const change = {
    repo,
    key: taskKey(repo, issue.number),
    number: issue.number,
    title: issue.title ?? null,
    base: p.repository.default_branch,
  };
  const person = (u) =>
    !!u?.login && u.type !== "Bot" && config.users.includes(u.login.toLowerCase());
  const ours = (u) => isBot(u, bot);
  const ctx = {
    p,
    issue,
    name,
    bot,
    change,
    person,
    labelled: hasLabel(issue.labels, name),
    // Who may set it off: an allowed user (`by`) or the App's bot (null).
    who: (u) => (person(u) ? u.login : ours(u) ? null : undefined),
    // What the dashboard shows of an issue it lists: its questions as the body has them now.
    questions: () => parseQuestions(questionsSection(issue.body)),
  };
  if (event === "issue_comment")
    return p.action === "edited" ? tickedReply(ctx) : commentInput(ctx);
  return ISSUE_ACTIONS[p.action]?.(ctx) ?? null;
}

// The label taken off a pull request, or put back, by someone other than the App's bot: GitHub
// says so in a `pull_request` delivery, never an `issues` one. Only the questions of the pull
// request's own task's run are set aside (`unlabelled`, applyInput()), or ask again
// (`relabelled`): pull requests aren't in the list of issues waiting for input, whose entry
// does that for an issue (board.mjs), and nothing waits for their answers (waits.mjs).
function pullLabel(config, p, name, bot) {
  const repo = p.repository?.full_name;
  const pull = p.pull_request;
  const action = { unlabeled: "unlabelled", labeled: "relabelled" }[p.action];
  // Fail closed: only the App's installations, on allowed repos.
  if (!action || !p.installation?.id || !repo || !pull?.number) return null;
  if (!repoAllowed(config, repo) || !hasLabel([p.label], name)) return null;
  // The bot's own: a run starting or asking, a comment that may answer.
  if (isBot(p.sender, bot)) return null;
  return {
    repo,
    key: taskKey(repo, prId(pull.number)),
    number: pull.number,
    title: null,
    base: p.repository.default_branch,
    [action]: { by: p.sender?.login ?? null },
  };
}

// The App's own bot: its removals of the label are the listener's (a run starting, a comment
// taking it off), which answer none of a run's questions.
const isBot = (u, bot) =>
  !!bot && u?.type === "Bot" && u.login?.toLowerCase() === bot.toLowerCase();

// An allowed user's comment on a labelled issue or pull request: it may answer the questions.
function commentInput({ p, issue, change, person, labelled }) {
  const c = p.comment;
  if (p.action !== "created" || !labelled || !person(c?.user)) return null;
  if ((c.body ?? "").includes(MARKER)) return null;
  // Pull requests carry the label too (a run on one stopped to ask); only issues are listed,
  // and a pull request's task key isn't its number.
  if (issue.pull_request) return { ...change, title: null, label: false, by: c.user.login };
  return { ...change, label: false, by: c.user.login, track: false, comment: c.body ?? "" };
}

// An allowed user ticking the boxes of a run's reply that stopped to ask (the App's comment,
// starting with NEEDS_INPUT): an edit of the ticks that leaves one in every question may answer
// them, as a reply would (work.mjs ticked() continues the run's session). `reply`: { pr, items },
// the reply's questions as the edit has them.
function tickedReply({ p, issue, change, person, who }) {
  const c = p.comment;
  if (who(c?.user) !== null || !person(p.sender) || !p.changes?.body) return null;
  const now = replyQuestions(c.body);
  const ticks = (q) => JSON.stringify(q?.items?.map((i) => i.options.map((o) => o.checked)));
  // Which boxes are a person's, and so the answers, is work.mjs ticked()'s: it knows the run's.
  if (!allTicked(now) || ticks(now) === ticks(replyQuestions(p.changes.body.from))) return null;
  const pr = !!issue.pull_request;
  const reply = { pr, items: now.items };
  return { ...change, ...(pr && { title: null }), by: p.sender.login, reply };
}

// A new issue: listed when labelled already, labelled when it opens with questions.
function openedInput({ issue, change, labelled, who, questions }) {
  const by = who(issue.user);
  if (by === undefined) return null;
  if (labelled) return { ...change, track: true, questions: questions() };
  // Ticks at open are the author's: the bot's (an inbox run's) answer nothing.
  if (!(by === null ? hasOpenQuestions(issue.body) : stillAsks(issue.body))) return null;
  return { ...change, label: true, by, track: true, questions: questions() };
}

// The author's issue, edited by them, another allowed user or the bot. Only a change to the
// section moves the label: a typo fixed elsewhere doesn't undo removing it by hand, nor take
// off a run's. Ticking a box of every question answers them (stillAsks()), as a comment would;
// unticking them asks again. Only a person's ticks answer: the bot's change nothing.
function editedInput({ p, issue, change, labelled, who, questions }) {
  const by = who(p.sender);
  if (!p.changes?.body) return null;
  if (questionsSection(p.changes.body.from) === questionsSection(issue.body)) return null;
  const ticked = allTicked(parseQuestions(questionsSection(issue.body)));
  const listed = issue.state !== "closed";
  // Ticks the listener doesn't take for answers: the bot's (a run ticking its own picks), or
  // anyone's on an issue or by a sender it doesn't act for. The label stays as it is, and a
  // labelled issue's entry keeps `ignoredTicks` (inputs.mjs), so wait_for_answers doesn't take
  // them for answers either (tasks.mjs unanswered()); an allowed user's edit clears it.
  if (who(issue.user) === undefined || by === undefined || (by === null && ticked)) {
    if (!labelled || !ticked) return null;
    return { ...change, track: listed, questions: questions(), ignoredTicks: true };
  }
  const now = stillAsks(issue.body);
  const asking = { track: listed, questions: questions(), ignoredTicks: false };
  // Still waiting: listed (labelled, it should be already), with its questions as they are now.
  if (now === labelled) return now ? { ...change, ...asking } : null;
  if (now) return { ...change, label: true, by, ...asking };
  // `ticked`: its ticks took the label off, so a refusal keeps them as ignored (applyInput()).
  return { ...change, label: false, by, track: false, answered: listed, ticked };
}

// Whoever adds or removes it, by hand or not: the dashboard follows the issue's labels. Taken
// off by someone other than the App's bot, the questions of the issue's task's last run no
// longer wait either (`unlabelled`: { by }, applyInput()). The bot takes it off when a run
// starts, or for a comment that may answer them (commentInput()), even one that starts
// nothing: the run's questions still wait then. A pull request's label comes as a
// `pull_request` delivery (pullLabel()).
function labelInput({ p, issue, name, change, questions, bot }) {
  if (!hasLabel([p.label], name)) return null;
  if (issue.state === "closed") return { ...change, track: false };
  if (p.action === "unlabeled") {
    const by = p.sender?.login ?? null;
    const unlabelled = !isBot(p.sender, bot) && { unlabelled: { by } };
    return { ...change, track: false, answered: true, ...unlabelled };
  }
  return { ...change, track: true, questions: questions() };
}

// A reopened issue still labelled is listed again.
function reopenedInput({ change, labelled, questions }) {
  return labelled ? { ...change, track: true, questions: questions() } : null;
}

// An issue gone from the repo's open ones leaves the list.
function goneInput({ change }) {
  return { ...change, track: false };
}

// An `issues` delivery's action → what it changes (inputEvent()); others change nothing. No
// prototype, so an action named like an Object method finds nothing.
const ISSUE_ACTIONS = {
  __proto__: null,
  opened: openedInput,
  edited: editedInput,
  labeled: labelInput,
  unlabeled: labelInput,
  reopened: reopenedInput,
  closed: goneInput,
  deleted: goneInput,
  transferred: goneInput,
};

// Open questions in an issue, or an answer to them (inputEvent()): the needs-input label and
// the dashboard's list of issues waiting for input (inputs.mjs). `ctx` (server.mjs): the
// listener's state and services.
export async function applyInput(ctx, change) {
  const { config, log, skip } = ctx;
  const { repo, key, number, title, base, label, by, track, questions: asked } = change;
  if (title) ctx.titles.set(key, title);
  // A run's reply answered by its ticks: it goes on as the dashboard's answers would, checks
  // included (work.mjs ticked()).
  if (change.reply) {
    const { pr, items } = change.reply;
    // Refused (closed, not among the repo's users…): said in the log only, as for a comment.
    const said = await ctx.workApi
      .ticked(repo, by, { number, pr, items })
      .catch((error) =>
        error instanceof Refused ? `ticks: ${error.message}` : Promise.reject(error),
      );
    return log(`${key}: ${said}`);
  }
  if (label !== undefined && by) {
    // The repo's own users narrow the operator's.
    const { settings, errors } = await ctx.repoSettings(repo, base);
    if (errors.length) return skip(`${key}: ${CONFIG_FILE} of ${repo} has errors`);
    const seen = effectiveConfig(config, settings);
    if (!seen.users.includes(by.toLowerCase())) {
      // Their ticks answer nothing: wait_for_answers ignores them too (tasks.mjs).
      if (change.ticked) ctx.inputs.update(key, undefined, true);
      return skip(`${key}: ${by} not among ${repo}'s users`);
    }
    // A trigger line alone answers nothing: the issue still waits (tasks.mjs holdBack()).
    if (
      settings.waitForAnswers &&
      change.comment !== undefined &&
      !saysMore(seen, change.comment)
    ) {
      return skip(`${key}: ${by}'s comment answers nothing, the label stays`);
    }
  }
  if (label !== undefined) {
    const res = await ctx.label(repo, number, label);
    if (labelFailed(res)) return log(`${key}: label: ${res.status}`);
    log(`${key}: ${label ? "open questions, labelled" : "answered, label removed"}`);
  }
  const { ignoredTicks } = change;
  if (track !== undefined) ctx.inputs.set(key, track, asked, ignoredTicks);
  else if (asked !== undefined) ctx.inputs.update(key, asked, ignoredTicks);
  // The label taken off by a person: the questions of its task's last run, if it asked, are set
  // aside, so the task no longer shows as waiting for input (board.mjs).
  if (change.unlabelled) {
    const aside = ctx.dismissals.setAsideOn(ctx.runs, key, change.unlabelled.by);
    if (aside) log(`${aside}: label removed, its last run's questions set aside`);
  }
  // A pull request's label put back: its run's questions wait again.
  if (change.relabelled) {
    const back = ctx.dismissals.restoreOn(ctx.runs, key);
    if (back) log(`${back}: label put back, its last run's questions wait again`);
  }
  // Answered: a comment that waited for the answers starts (waits.mjs).
  if (change.answered) await ctx.waits.answered(repo, number);
}
