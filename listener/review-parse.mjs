// Reading a review (reviews.mjs): the run's final message (parseReview(), its `deckhand-review`
// JSON block or its Markdown), and a review the App posted before (parsePostedReview()). Which
// findings and comments block, at a repo's `review.max_allowed_severity` (blocks()).
import { SEVERITIES } from "./severities.mjs";

// What a review blocks on: GitHub's REQUEST_CHANGES (and, with `review.fix`, a fix run). Never
// APPROVE: an App's approval may count toward branch protection, and approving is the
// maintainer's call. An automatic review in a fix loop or deciding an auto-merge may tolerate
// medium findings too (`review.max_allowed_severity`, reviews' tolerance()).
export const BLOCKING = new Set(["critical", "high", "medium"]);

// The severities that block with `allowed` the most severe finding that doesn't: those more
// severe than it, among those that block at all. The review prompt says them (prompts.mjs).
export function blockingSeverities(allowed = "low") {
  const limit = SEVERITIES.indexOf(allowed);
  return SEVERITIES.filter((s) => BLOCKING.has(s) && SEVERITIES.indexOf(s) < limit);
}

// The findings of `review` that block with `allowed` (blockingSeverities()).
export function above(review, allowed = "low") {
  const blocking = blockingSeverities(allowed);
  return review.findings.filter((f) => blocking.includes(f.severity));
}

// The highest rating a review can give with a finding of each severity: a model's 8/10 next
// to a high finding would contradict the verdict it is posted with.
const RATING_CAPS = { critical: 3, high: 5, medium: 8, low: 10 };

export const VERDICTS = {
  approve: "approve",
  comment: "comment",
  "request-changes": "request changes",
};

// The run's final message (prompts/review.md's format) → { summary, findings: [{ severity,
// path, line, text }], followUps: [{ title, path, line, text }], comments: [{ blocking, path,
// line, text }], rating, verdict, allowed }, or null when it lacks the rating or the verdict.
// Read from its verdict block first (a fenced `json deckhand-review` block, readBlock(), #645):
// its items are typed, so nothing is guessed. A block that doesn't validate is logged (`log`)
// and the markdown read instead (readMarkdown()), the block's own `request-changes` kept, and so
// is one the markdown says more than (saysLess(): it blocks on an item the block lacks, or
// asks for changes the block doesn't); a reply
// without one (a repo's own prompt, an older session) reads from its markdown as before it.
// The rating is capped by the most severe finding (RATING_CAPS), and anything blocking makes
// the verdict `request-changes`, whatever the message says. `allowed`: the most severe
// finding that doesn't block (`review.max_allowed_severity`, for an automatic review in a fix
// loop or deciding an auto-merge). The prompt is told the same tolerance (reviewPrompt()), but a model may still
// write `request-changes` on tolerated findings only: that verdict says nothing more than the
// findings, so it reads `comment`, and so does one with no finding at all (follow-ups and notes
// only, which never block) when every item was read for sure. Otherwise the model's
// `request-changes` stays, and blocks the merge: a finding the parser missed (a numbered list,
// say) still does.
export function parseReview(text, { allowed = "low", log = () => {} } = {}) {
  const { json, rest } = verdictBlock(text);
  const md = readMarkdown(rest);
  if (json !== null) {
    const read = readBlock(json);
    const fromBlock =
      read.block && settle({ summary: md.summary, ...read.block }, { allowed, sure: true });
    // The markdown, read as it would be alone, saying more than the block (saysLess()): one of
    // the two left something out, so the block is no surer than the markdown, read as when it
    // doesn't validate.
    const stricter =
      read.block &&
      saysLess(fromBlock, markdownAlone(md, read.block, allowed), {
        asked: md.said === "request-changes" && read.block.verdict !== "request-changes",
      });
    if (read.block && !stricter) return fromBlock;
    log(
      stricter
        ? "the review's verdict block says less than its markdown: read from its markdown"
        : `the review's verdict block doesn't validate (${read.error}): read from its markdown`,
    );
    // The model's `request-changes` stands, the block's or the markdown's: the block may be what
    // says changes are needed, and a reply that strayed from its format once may have again.
    if (blockVerdict(json) === "request-changes") md.said = "request-changes";
    md.doubtful = true;
  }
  if (md.rating === null || md.said === null) return null;
  const { summary, findings, followUps, comments, rating, said } = md;
  return settle(
    { summary, findings, followUps, comments, rating },
    { said, allowed, sure: markdownSure(md) },
  );
}

// Whether the markdown's items were all read for sure (settle()): no finding is sure only when
// the Must fix section said `None.` and every line under it and Comments was read.
const markdownSure = ({ findings, none, unsure, doubtful }) =>
  !doubtful && (findings.length > 0 || (none && !unsure));

// The markdown's review settled as it would be alone, to hold a verdict block to it: without
// its own verdict, it only blocks on its items; without its own rating, the block's.
const markdownAlone = (md, block, allowed) =>
  settle(
    { ...md, rating: md.rating ?? block.rating },
    { said: md.said ?? "comment", allowed, sure: markdownSure(md) },
  );

// Whether settled review `block` says less than `md` in anything that blocks, is posted as a
// finding or a follow-up, or reaches the policies (`input.review`): `asked`, the markdown's
// `request-changes` where the block's own verdict isn't (where both say it, the typed block
// decides whether it reads `comment`, whatever the markdown's own doubts), blocking where the
// block doesn't, a higher rating, fewer findings at any severity and above, fewer blocking
// comments or follow-ups (each one a filed issue), or a finding or blocking comment of the
// markdown's with a place that the block has nothing as severe at. The model wrote both: they
// differ only when one left something out, and the markdown may be the right one.
function saysLess(block, md, { asked }) {
  if (asked || (blocks(md, md.allowed) && !blocks(block, block.allowed))) return true;
  if (md.rating < block.rating || md.followUps.length > block.followUps.length) return true;
  const rank = (item) => (item.severity ? SEVERITIES.indexOf(item.severity) : RANK_BLOCKING);
  const atLeast = (review, limit) => review.findings.filter((f) => rank(f) <= limit).length;
  if (SEVERITIES.some((_, limit) => atLeast(md, limit) > atLeast(block, limit))) return true;
  const mdBlocking = blockingComments(md);
  const blockBlocking = blockingComments(block);
  if (mdBlocking.length > blockBlocking.length) return true;
  const theirs = [...block.findings, ...blockBlocking];
  return [...md.findings, ...mdBlocking].some(
    (item) =>
      item.path !== null &&
      !theirs.some((b) => b.path === item.path && b.line === item.line && rank(b) <= rank(item)),
  );
}

// A blocking comment's rank among the severities (saysLess()): as a medium finding, which caps
// the rating as it does; a finding as severe or more stands for it at its place.
const RANK_BLOCKING = SEVERITIES.indexOf("medium");

// The review from its items, its rating capped and its verdict decided (parseReview()): `said`,
// the model's verdict (a block's `verdict`, unless given), reads `comment` when it asked for
// changes on nothing blocking but tolerated findings, or on no finding at all, and the items
// were all read for sure (`sure`).
function settle(
  { summary, findings, followUps, comments, rating, verdict },
  { said = verdict, allowed, sure },
) {
  // An `unclear` comment blocks when the model asked for changes (its kind unread, it may be
  // why); with the model's `comment`, it is shown, not blocking.
  const review = {
    summary,
    findings,
    followUps,
    comments,
    unclearBlocks: said === "request-changes",
    allowed,
  };
  const tolerated = findings.some((f) => BLOCKING.has(f.severity));
  const caps = [
    ...findings.map((f) => RATING_CAPS[f.severity]),
    ...(blockingComments(review).length ? [RATING_CAPS.medium] : []),
  ];
  return {
    ...review,
    rating: Math.min(rating, ...caps),
    verdict: blocks(review, allowed)
      ? "request-changes"
      : sure && (tolerated || !findings.length) && said === "request-changes"
        ? "comment"
        : said,
  };
}

// `lines` without the fence a reply is wrapped whole in, as the prompt's example is (#933):
// its opening line would start the summary, and the posted review would be a code block from
// there on; its closing line, after the verdict, would read as stray text. A fence that opens
// the reply and closes before its last line is the summary's own code block, and stays.
function unwrapped(lines) {
  const first = lines.findIndex((line) => line.trim());
  const open = /^ {0,3}(`{3,}|~{3,})[^`]*$/.exec(lines[first] ?? "");
  if (!open) return lines;
  let close = first + 1;
  while (close < lines.length) {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[close]);
    if (fence && fence[1][0] === open[1][0] && fence[1].length >= open[1].length) break;
    close++;
  }
  if (lines.slice(close + 1).some((line) => line.trim())) return lines;
  return lines.slice(first + 1, close);
}

// The opening line of the review's verdict block (prompts/review.md).
const BLOCK_OPEN = /^ {0,3}(`{3,}|~{3,})\s*json\s+deckhand-review\s*$/i;

// `text` → { json, rest }: the last verdict block's contents (null: none), and the text without
// any verdict block, for the markdown (their JSON lines would read as its text, an earlier
// block's `"verdict": …` as its verdict). Other fences are no concern: a reply wrapped whole in
// one, as the prompt's example is, still has its block. An unclosed block runs to the end, so
// it fails to validate rather than passing for markdown.
function verdictBlock(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const rest = [];
  let json = null;
  for (let from = 0; from < lines.length; from++) {
    const open = BLOCK_OPEN.exec(lines[from]);
    if (!open) {
      rest.push(lines[from]);
      continue;
    }
    let to = from + 1;
    while (to < lines.length) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[to]);
      if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) break;
      to++;
    }
    json = lines.slice(from + 1, to).join("\n");
    from = to;
  }
  return { json, rest: rest.join("\n") };
}

// A verdict block's JSON → { block: { findings, followUps, comments, rating, verdict } } or
// { error }: what doesn't validate, for the log. Each list is required (empty when there is
// nothing); an item's `path` and `line` go together, or are both left out or null.
function readBlock(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return { error: "not JSON" };
  }
  if (!isObject(data)) return { error: "not an object" };
  const rating = data.rating;
  if (typeof rating !== "number" || !/^(?:10|\d)(?:\.\d)?$/.test(String(rating)) || rating > 10) {
    return { error: "`rating` isn't a number from 0 to 10, with one decimal at most" };
  }
  if (!Object.hasOwn(VERDICTS, data.verdict)) return { error: "`verdict` is unknown" };
  const block = { findings: [], followUps: [], comments: [], rating, verdict: data.verdict };
  for (const [key, read] of Object.entries(BLOCK_ITEMS)) {
    if (!Array.isArray(data[key])) return { error: `\`${key}\` isn't a list` };
    for (const [i, item] of data[key].entries()) {
      const at = isObject(item) ? place(item) : null;
      const own = at && read(item);
      if (!own) return { error: `\`${key}[${i}]\` doesn't validate` };
      if (own.skip) continue;
      block[key].push({ ...own, ...at });
    }
  }
  return { block };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const filled = (value) => typeof value === "string" && value.trim() !== "";

// Each list of the verdict block → its item's own fields, or null when they don't validate.
const BLOCK_ITEMS = {
  findings: (f) => (SEVERITIES.includes(f.severity) ? { severity: f.severity } : null),
  // "None" as a title files nothing (NOTHING), as in the markdown. No bold in it: the title is
  // posted in bold, and read back to its first `**` (parsePostedReview()).
  followUps: (f) =>
    filled(f.title)
      ? NOTHING.test(titleOf(f.title))
        ? { skip: true }
        : { title: titleOf(f.title.replace(/\*\*|__/g, "")) }
      : null,
  comments: (c) => (typeof c.blocking === "boolean" ? { blocking: c.blocking } : null),
};

// A block's item → { path, line, text } (as located()'s), or null: no text, a path that
// couldn't be posted in backticks, or a line without its path or a path without its line.
function place(item) {
  if (!filled(item.text)) return null;
  const path = item.path ?? null;
  const line = item.line ?? null;
  if ((path === null) !== (line === null)) return null;
  if (path !== null && (typeof path !== "string" || !/^[^`\s]+$/.test(path))) return null;
  if (line !== null && !(Number.isInteger(line) && line > 0)) return null;
  // No blank line: a posted item ends at one (parsePostedReview()).
  return { path, line, text: item.text.trim().replace(/\n\s*\n/g, "\n") };
}

// The verdict a block that doesn't validate still says, or null.
function blockVerdict(json) {
  try {
    const data = JSON.parse(json);
    // "request changes" too, as the markdown's is read.
    return isObject(data) && typeof data.verdict === "string"
      ? data.verdict.toLowerCase().replace(" ", "-")
      : null;
  } catch {
    return /"verdict"\s*:\s*"request[- ]changes"/i.test(json) ? "request-changes" : null;
  }
}

// The review's markdown (prompts/review.md's sections) → { summary, findings, followUps,
// comments, rating, said, none, unsure, doubtful }: `rating` and `said` (the model's verdict)
// null when it lacks them. Its three sections: `## Must fix` (the findings; a `## Findings`
// heading, as replies before the sections and repos' own prompts have it, reads the same),
// `## Follow-ups` (for other issues: Deckhand files them once the pull request is merged,
// fileFollowUps()) and `## Comments` (each `blocking` or a `note`). Severity bullets before any
// heading are findings, as before the sections. Follow-ups and notes never block nor cap the
// rating; a blocking comment blocks whatever `allowed` says, and caps the rating as a medium
// finding does. `none`: its Must fix section says `None.`; `unsure` and `doubtful`: what it
// couldn't read, which keeps the model's `request-changes` (settle()).
function readMarkdown(text) {
  const lines = unwrapped(String(text ?? "").split(/\r?\n/));
  const rating = /^\W*rating\W*\s*(\d{1,2}(?:\.\d)?)\s*\/\s*10\b/im.exec(text ?? "");
  const verdict = /^\W*verdict\W*\s*(approve|comment|request[- ]changes)\b/im.exec(text ?? "");
  const findings = [];
  const followUps = [];
  const comments = [];
  const summary = [];
  // "findings" before any heading too; "follow-ups", "comments" under theirs.
  let section = "findings";
  let current = null;
  let started = false;
  let none = false;
  // A line under Must fix or Comments the parser can't read (a comment without its kind, text
  // that isn't an item): the model's `request-changes` then stands, `None.` or not.
  let unsure = false;
  // A comment the parser can't tell blocking or not, or an item under Follow-ups that isn't one
  // (a misplaced comment or finding): the model's `request-changes` stands whatever else the
  // reply has, tolerated findings included, as it may be a blocking comment.
  let doubtful = false;
  // The depth of the section's heading ("##": 2): a deeper one is inside it.
  let depth = 0;
  for (const line of lines) {
    const heading = /^(#+)\s*(must[- ]fix|findings|follow[- ]?ups?|comments)\b/i.exec(line.trim());
    if (heading) {
      started = true;
      current = null;
      depth = heading[1].length;
      const name = heading[2].toLowerCase();
      section = name.startsWith("follow")
        ? "follow-ups"
        : name === "comments"
          ? "comments"
          : "findings";
      continue;
    }
    // Any other heading after the review's own: a deeper one stays inside its section (a
    // severity's "### 🟠 High (1)" under Must fix, as Deckhand posts them); one as deep or less
    // (`## Checks`, `## Acceptance criteria`, `## Blocking comments`) ends it. Under it, only
    // what reads as a finding or a comment is an item (bullet()), never a follow-up; anything
    // else keeps the model's `request-changes`.
    const other = started && /^(#+)\s/.exec(line.trim());
    if (other) {
      current = null;
      if (section === "other" || other[1].length <= depth) section = "other";
      continue;
    }
    // "None." under a heading, as a bullet or not: no item. Under Must fix, the review says it
    // has no finding (`none`), which lets its verdict read `comment` below.
    if (
      started &&
      /^\s*(?:(?:[-*+]|\d+[.)])\s+)?[*_`]*(?:none|nothing|n\/a)\b[^\w]*$/i.test(line)
    ) {
      if (section === "findings") none = true;
      current = null;
      continue;
    }
    const found = bullet(section, line, started);
    if (found) {
      const { unmarked, misplaced, comment, skip, ...item } = found;
      if (unmarked || misplaced) unsure = doubtful = true;
      started = true;
      if (skip) {
        current = null;
        continue;
      }
      current = item;
      const into = comment ? "comments" : item.severity ? "findings" : section;
      ({ findings, "follow-ups": followUps, comments })[into].push(item);
      continue;
    }
    if (/^\W*(rating|verdict)\W/i.test(line)) {
      started = true;
      current = null;
      continue;
    }
    // An item's text goes on on indented lines.
    if (current && /^\s+\S/.test(line)) current.text += `\n${line.trim()}`;
    else if (line.trim()) {
      current = null;
      if (started && ["findings", "comments"].includes(section) && /^\S/.test(line)) {
        unsure = true;
      }
      if (section === "other" && /^\S/.test(line)) unsure = doubtful = true;
    }
    if (!started) summary.push(line);
  }
  return {
    summary: summary.join("\n").trim(),
    findings,
    followUps,
    comments,
    rating: rating && Number(rating[1]) <= 10 ? Number(rating[1]) : null,
    said: verdict ? verdict[1].toLowerCase().replace(" ", "-") : null,
    none,
    unsure,
    doubtful,
  };
}

// An unindented bullet or numbered item of `section` → its item, or null. A finding's
// severity ends in emphasis, a bracket or a separator: not "- Highlights…" in the summary, nor
// an indented sub-bullet of a finding's text, which would otherwise cap the rating, block and,
// with `review.fix`, start the fix run. A follow-up starts with its title in bold (none
// without); a comment
// with its kind, `blocking` or `note` (`non-blocking`, `nit` too), in bold, italics, backticks
// or brackets, or bare before a separator. A comment without one is a note marked `unmarked`:
// it doesn't block, but parseReview() keeps the model's verdict then, as missing a blocking
// one would fail open.
// `started`: a heading or an item came before, so a bullet under Must fix that is no finding
// is no summary's either.
function bullet(section, line, started = true) {
  const lead = /^(?:[-*+]|\d+[.)])\s+(?=\S)/.exec(line);
  if (!lead) return null;
  if (section === "other") {
    // A finding or a comment under another heading: read as one (a blocking one blocks); a
    // note keeps the model's verdict. Anything else is no item, and keeps it too.
    const rest = line.slice(lead[0].length);
    const severity = bullet("findings", line, false);
    if (severity?.severity) return severity;
    const kind = commentKind(rest);
    if (!kind) return { misplaced: true, skip: true };
    if (kind[1].toLowerCase() !== "blocking") return { ...note(kind[2]), misplaced: true };
    return { comment: true, blocking: true, ...located(kind[2]) };
  }
  const rest = line.slice(lead[0].length);
  if (section === "findings") {
    const m =
      /^[*_`]*\[?(critical|high|medium|low)(?:\][*_`]*|[*_`]+|\s*[:–—])\s*[:–—-]?\s*(.*)$/i.exec(
        rest,
      );
    if (m) return { severity: m[1].toLowerCase(), ...located(m[2]) };
    // A comment under Must fix, moved to its section: a blocking one blocks there as anywhere;
    // a note is `misplaced` too, and the model's verdict stands. Anything else after a heading
    // (a follow-up there, an item under a heading the parser doesn't know): an `unclear`
    // comment, shown rather than lost.
    const kind = commentKind(rest);
    if (!kind) {
      if (!started || NOTHING.test(titleOf(located(rest).text))) return null;
      return { ...note(rest), unclear: true, misplaced: true };
    }
    if (kind[1].toLowerCase() !== "blocking") return { ...note(kind[2]), misplaced: true };
    return { comment: true, blocking: true, ...located(kind[2]) };
  }
  if (section === "follow-ups") {
    // A comment's kind or a severity as its lead, in any form the Comments section reads: a
    // comment or a finding under the wrong heading, never filed but moved to Comments, so the
    // review still shows it. A blocking comment blocks there as anywhere (as under Must fix); a
    // note is a note, and a finding `unclear`; both `misplaced`, so the model's verdict stands.
    const kind = commentKind(rest);
    if (kind?.[1].toLowerCase() === "blocking") {
      return { comment: true, blocking: true, ...located(kind[2]) };
    }
    if (kind) return { ...note(kind[2]), misplaced: true };
    if (MISPLACED_SEVERITY.test(rest)) return { ...note(rest), unclear: true, misplaced: true };
    // Only with its title in bold: each one becomes a public issue after the merge.
    const m = /^(?:\*\*(.+?)\*\*|__(.+?)__)\s*[:–—-]?\s*(.*)$/.exec(rest);
    // Another form is no follow-up; unless it says there is none ("- No follow-ups."), it is
    // something the parser can't read: an `unclear` comment, and the verdict stands too.
    if (!m) {
      if (NOTHING.test(titleOf(located(rest).text))) return null;
      return { ...note(rest), unclear: true, misplaced: true };
    }
    const title = titleOf(m[1] ?? m[2]);
    // "**No follow-ups.**", "**None found**": nothing to file.
    if (NOTHING.test(title)) return null;
    return { title, ...located(m[3]) };
  }
  const m = commentKind(rest);
  // Its kind unread: neither a note nor blocking, but `unclear`, as posted and as the fix run
  // reads it (fixMessage()).
  if (!m) return { blocking: false, unclear: true, ...located(rest), unmarked: true };
  return { blocking: m[1].toLowerCase() === "blocking", ...located(m[2]) };
}

// A comment that doesn't block, moved to Comments from another section.
const note = (text) => ({ comment: true, blocking: false, ...located(text) });

// A comment's kind leading `rest` (a bullet's text) → [, kind, text], or null: `blocking` or
// `note` (`non-blocking`, `nit` too, "blocking comment"), in bold, italics, backticks,
// brackets or parentheses, or bare before a separator.
function commentKind(rest) {
  const kind = String.raw`(blocking|non[- ]blocking|note|nit)(?:\s+(?:comment|remark|question))?`;
  return (
    new RegExp(String.raw`^[*_\`\[(]+\s*${kind}\s*[:–—]?\s*[*_\`\])]+\s*[:–—-]?\s*(.*)$`, "i").exec(
      rest,
    ) ?? new RegExp(String.raw`^${kind}(?:\s*[:–—]|\s+-)\s*(.*)$`, "i").exec(rest)
  );
}

// A severity leading a bullet, as a finding's ("**high**", "[high]", "high:", "🟠 High:"),
// emphasis or a separator after it: not a title that starts with the word ("**High memory**").
const MISPLACED_SEVERITY =
  /^[*_`[]*(?:\p{Extended_Pictographic}️?\s*)?[*_`[]*(critical|high|medium|low)(?:[\]*_`]+|\s*[:–—]|\s+-\s)/iu;

// A follow-up's title saying there is none: "No follow-ups.", "None found", "Nothing to file".
const NOTHING =
  /^(?:n\/a|(?:no|none|nothing)(?:\s+(?:follow[- ]?ups?|issues?|found|here|left|needed|so far|to (?:file|report|add|list)))*)\W*$/i;

// A follow-up's title, on one line, as long as GitHub takes an issue's (256).
// A separator the model put inside the bold ("**Share the helper:**") is no part of it.
export const titleOf = (text) =>
  String(text)
    .replace(/\s+/g, " ")
    .replace(/\s*[:–—-]\s*$/, "")
    .trim()
    .slice(0, 256);

// The comments of `review` that block (all of its blocking ones, whatever its tolerance).
// An `unclear` one (its kind unread, or an item under the wrong heading) blocks too when the
// model asked for changes (`unclearBlocks`: it may be why): the fix run is told to treat it as
// blocking (fixMessage()), so the loop, the event and the merge do the same. With the model's
// `comment`, it is shown, not blocking: posted as a note (commentSection()), and read back as
// one. A posted review's `unclear` comments are those that blocked (parsePostedReview()).
export const unclearBlocking = (review, c) => c.unclear && review.unclearBlocks !== false;
export const blockingComments = (review) =>
  (review.comments ?? []).filter((c) => c.blocking || unclearBlocking(review, c));

// Whether `review` blocks with `allowed`: a finding above it, or a blocking comment.
export const blocks = (review, allowed = "low") =>
  above(review, allowed).length + blockingComments(review).length > 0;

// The head line of a review the listener posted (reviewBody()).
export const REVIEW_HEAD =
  /^\*\*Verdict: (approve|comment|request changes)\*\* · Rating: (\d{1,2}(?:\.\d)?)\/10$/;

// A review the listener posted (reviewBody()'s, as GitHub keeps it) → parseReview()'s
// { summary, findings, followUps, comments, rating, verdict, allowed }, or null when it isn't
// one (the raw text of an unparsed review). The items are read back from their sections, their
// links taken off; a review posted before the sections has findings only. The summary isn't
// kept: a fix run's message has the items only (fixMessage()). `allowed`: the tolerance it is
// read with now.
export function parsePostedReview(body, { allowed = "low" } = {}) {
  const text = String(body ?? "");
  const head = new RegExp(REVIEW_HEAD.source, "m").exec(text);
  if (!head) return null;
  const findings = [];
  const followUps = [];
  const comments = [];
  // The section (a severity of the findings, "follow-ups", "comments"), from its heading to
  // the blank line after its last item (an item's own blank lines are indented): what follows
  // the sections is the footer.
  let section = null;
  let current = null;
  for (const line of text.slice(head.index + head[0].length).split(/\r?\n/)) {
    const severity = /^### \S+ (Critical|High|Medium|Low) \(\d+\)$/.exec(line);
    const other = /^## (Follow-ups|Comments) \(\d+\)$/.exec(line);
    if (severity || other) {
      section = severity ? severity[1].toLowerCase() : other[1].toLowerCase();
      current = null;
    } else if (!line) {
      if (current) section = current = null;
    } else if (section && line.startsWith("- ")) {
      current = postedItem(section, line.slice(2));
      if (section === "follow-ups") followUps.push(current);
      else if (section === "comments") comments.push(current);
      else findings.push(current);
    } else if (current && line.startsWith("  ")) {
      current.text = `${current.text}\n${line.slice(2)}`.trim();
    }
  }
  return {
    summary: "",
    findings,
    followUps,
    comments,
    rating: Number(head[2]),
    verdict: head[1].replace(" ", "-"),
    // Only an unclear comment that blocked is posted as one (commentSection()).
    unclearBlocks: true,
    allowed,
  };
}

// A posted item's line (without its "- ") in `section` → its item, as parseReview()'s.
function postedItem(section, line) {
  // A follow-up's title, a comment's kind: in bold, before the place.
  const lead = /^\*\*(.+?)\*\*(?: |$)/.exec(line);
  const rest = lead ? line.slice(lead[0].length) : line;
  // The link ends at its line's anchor: a path may have parentheses ("app/(shop)/x.tsx").
  const at = located(rest.replace(/^\[(`[^`]+`)\]\(\S*?#L\d+\)/, "$1"));
  if (section === "follow-ups") return { title: lead?.[1] ?? "", ...at };
  if (section === "comments") {
    const unclear = lead?.[1] === "unclear" ? { unclear: true } : {};
    return { blocking: lead?.[1] === "blocking", ...unclear, ...at };
  }
  return { severity: section, ...at };
}

// "`listener/x.mjs:42`: what" → { path, line, text }; no location: path and line null.
function located(text) {
  const m = /^`([^`\s]+?):(\d+)(?:[-–]\d+)?`\s*[:–—-]?\s*/.exec(text);
  if (!m) return { path: null, line: null, text: text.trim() };
  return { path: m[1], line: Number(m[2]), text: text.slice(m[0].length).trim() };
}
