// Answers to a task's open questions, sent from the dashboard's form (work.mjs `answer`): the
// body checked, and the comment that stands for them on GitHub. Pure, so tested on its own
// (../test/answers.test.mjs).
//
// The questions are api/state's (questions.mjs parseQuestions(), on the board's task): parsed
// (`items`) the form sends one answer per question, `{ options: [i], text }`; not parsed, one
// free text for them all.
import { unmarked } from "./events.mjs";
import { refuse } from "./web.mjs";

// GitHub keeps 65536 characters of a comment (comments.mjs cuts longer ones): answers stay
// well under, with room for the questions' titles.
export const MAX_TEXT = 20_000;
const MAX_QUESTIONS = 50;

const text = (s) => typeof s === "string" && s.length <= MAX_TEXT;

// The body asked for (parsed JSON), checked: { number, pr, answers, text, then } with either
// `answers` (one per question) or `text`. `then`: the work area's action to take once they are
// in (the graph's drag that asked for them), as sent: work.mjs checks it. Throws Refused.
export function parseAnswers(body) {
  const { number, pr = false, answers, then = null } = body ?? {};
  const free = typeof body?.text === "string" ? unmarked(body.text) : body?.text;
  if (!Number.isSafeInteger(number) || number <= 0) refuse(400, "`number` is an issue number.");
  if (typeof pr !== "boolean") refuse(400, "`pr` is true or false.");
  if ((answers === undefined) === (free === undefined)) {
    refuse(400, "Send either `answers` or `text`.");
  }
  if (free !== undefined) {
    if (!text(free)) refuse(400, `\`text\` is a string of at most ${MAX_TEXT} characters.`);
    if (!free.trim()) refuse(400, "Nothing to send: the answer is empty.");
    return { number, pr, answers: null, text: free.trim(), then };
  }
  if (!Array.isArray(answers) || answers.length > MAX_QUESTIONS) {
    refuse(400, "`answers` is a list, one per question.");
  }
  const checked = answers.map((a) => {
    const { options = [] } = a ?? {};
    const note = typeof a?.text === "string" ? unmarked(a.text) : (a?.text ?? "");
    const index = (i) => Number.isSafeInteger(i) && i >= 0;
    if (!Array.isArray(options) || !options.every(index)) {
      refuse(400, "An answer's `options` are the indexes of the options ticked.");
    }
    if (!text(note)) refuse(400, `An answer's \`text\` is at most ${MAX_TEXT} characters.`);
    // One option per question, and a note (prompts/sandbox.md "Open questions").
    const picked = [...new Set(options)];
    if (picked.length > 1) refuse(400, "One option per question: its note says the rest.");
    return { options: picked, text: note.trim() };
  });
  const total = checked.reduce((n, a) => n + a.text.length, 0);
  if (total > MAX_TEXT) refuse(413, `The answers are longer than ${MAX_TEXT} characters.`);
  if (!checked.some(answered)) refuse(400, "Nothing to send: every answer is empty.");
  return { number, pr, answers: checked, text: null, then };
}

const answered = (a) => a.options.length > 0 || !!a.text;

// One line of markdown: the question's title, or its text when it has none.
const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const nameOf = (q) => (q.title ? `**${oneLine(q.title)}**` : oneLine(q.text ?? ""));

// A note as a list item: its lines indented, so a blank line or a list in it doesn't end it.
const item = (s) => `   - ${s.replace(/\n/g, "\n     ")}`;

// The App's comment for `user`'s answers to `items`, and the numbers (1-based) of the questions
// left without one: { comment, open }. `where`: how they came. Throws Refused when the answers
// don't fit the questions (they changed since the form was drawn).
export function answersComment(user, items, asked, where = "from the dashboard") {
  const head = `Answers from @${user}, ${where}:`;
  if (asked.text !== null) return { comment: `${head}\n\n${asked.text}`, open: [] };
  if (!items) refuse(409, "These questions aren't in the format any more: answer in one text.");
  if (asked.answers.length !== items.length) {
    refuse(409, "The questions changed since the form was shown: reload it.");
  }
  const open = [];
  const lines = items.map((q, i) => {
    const a = asked.answers[i];
    const options = q.options ?? [];
    if (a.options.some((n) => n >= options.length)) {
      refuse(409, "The questions changed since the form was shown: reload it.");
    }
    if (!answered(a)) open.push(i + 1);
    const picks = a.options.map((n) => `   - [x] ${oneLine(options[n].label)}`);
    const note = a.text ? [item(a.text)] : [];
    const none = answered(a) ? [] : [item("_Not answered yet._")];
    return [`${i + 1}. ${nameOf(q)}`, ...picks, ...note, ...none].join("\n");
  });
  const still = open.length ? [`Still open: ${open.map((n) => `question ${n}`).join(", ")}.`] : [];
  return {
    comment: [head, "", ...lines, ...(still.length ? ["", ...still] : [])].join("\n"),
    open,
  };
}
