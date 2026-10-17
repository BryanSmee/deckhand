// Pull request reviews (the built-in `review` mode, opt-in with a repo's `review` block): when
// one starts by itself, and the GitHub review the listener posts from the run's final message.
// The run's token only reads, so a prompt-injected diff can't write anything: the listener
// posts the review with its own.
//
// No loops: each pull request's reviewed head commit is kept in reviews.json, so a redelivered
// webhook, a restart or the same commit again never pays for a second review. The App's own
// review is a bot's `pull_request_review`, which workItem() ignores: a "request changes"
// starts nothing by itself.
import { repoAllowed } from "./config.mjs";
import { linkedIssue, linkTo, MARKER, prId, sameRepo, taskKey } from "./events.mjs";
import { getJson } from "./github.mjs";
import { persistentMap } from "./store.mjs";

// The repo's `severity: *` labels' names, most severe first.
export const SEVERITIES = ["critical", "high", "medium", "low"];

const HEADINGS = {
  critical: "🔴 Critical",
  high: "🟠 High",
  medium: "🟡 Medium",
  low: "⚪ Low",
};

// What a review blocks on: GitHub's REQUEST_CHANGES. Never APPROVE: an App's approval may
// count toward branch protection, and approving is the maintainer's call.
const BLOCKING = new Set(["critical", "high"]);

const VERDICTS = { approve: "approve", comment: "comment", "request-changes": "request changes" };

// A reviewed head commit is forgotten after this: the pull request is long merged or closed.
const KEEP_MS = 90 * 24 * 3600_000;

// The run's final message (prompts/review.md's format) → { summary, findings: [{ severity,
// path, line, text }], rating, verdict }, or null when it lacks the rating or the verdict.
export function parseReview(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const rating = /^\W*rating\W*\s*(\d{1,2}(?:\.\d)?)\s*\/\s*10\b/im.exec(text ?? "");
  const verdict = /^\W*verdict\W*\s*(approve|comment|request[- ]changes)\b/im.exec(text ?? "");
  if (!rating || !verdict || Number(rating[1]) > 10) return null;
  const findings = [];
  const summary = [];
  let current = null;
  let started = false;
  for (const line of lines) {
    const finding = /^\s*[-*]\s+\**\[?(critical|high|medium|low)\]?\**\s*[:–—-]?\s*(.*)$/i.exec(
      line,
    );
    if (finding) {
      started = true;
      current = { severity: finding[1].toLowerCase(), ...located(finding[2]) };
      findings.push(current);
      continue;
    }
    if (/^\W*(rating|verdict)\W/i.test(line)) {
      started = true;
      current = null;
      continue;
    }
    if (/^#+\s*findings\b/i.test(line.trim())) {
      started = true;
      current = null;
      continue;
    }
    // A finding's text goes on on indented lines.
    if (current && /^\s+\S/.test(line)) current.text += `\n${line.trim()}`;
    else if (line.trim()) current = null;
    if (!started) summary.push(line);
  }
  return {
    summary: summary.join("\n").trim(),
    findings,
    rating: Number(rating[1]),
    verdict: verdict[1].toLowerCase().replace(" ", "-"),
  };
}

// "`listener/x.mjs:42`: what" → { path, line, text }; no location: path and line null.
function located(text) {
  const m = /^`([^`\s]+?):(\d+)(?:[-–]\d+)?`\s*[:–—-]?\s*/.exec(text);
  if (!m) return { path: null, line: null, text: text.trim() };
  return { path: m[1], line: Number(m[2]), text: text.slice(m[0].length).trim() };
}

// GitHub's `event` for a parsed review (null: unparsed): changes requested on critical or high
// findings, else a comment.
export function reviewEvent(review) {
  return review?.findings.some((f) => BLOCKING.has(f.severity)) ? "REQUEST_CHANGES" : "COMMENT";
}

// The review's body: verdict and rating, the summary, then the findings by severity, each
// linked to its line at `blob` (the head commit's tree URL), when known. Unparsed: the raw text.
export function reviewBody(review, raw, footer, blob = null) {
  if (!review) {
    return `${String(raw ?? "").trim()}\n\n_The review's format couldn't be read: posted as it is, as a comment._\n\n${footer}`;
  }
  const head = `**Verdict: ${VERDICTS[review.verdict]}** · Rating: ${review.rating}/10`;
  const parts = [head];
  if (review.summary) parts.push(review.summary);
  for (const severity of SEVERITIES) {
    const found = review.findings.filter((f) => f.severity === severity);
    if (!found.length) continue;
    const items = found.map((f) => `- ${where(f, blob)}${f.text.replace(/\n/g, "\n  ")}`);
    parts.push(`### ${HEADINGS[severity]} (${found.length})\n\n${items.join("\n")}`);
  }
  if (!review.findings.length) parts.push("No findings.");
  parts.push(footer);
  return parts.join("\n\n");
}

function where({ path, line }, blob) {
  if (!path) return "";
  const label = `\`${path}:${line}\``;
  const link = blob
    ? `[${label}](${blob}/${path.split("/").map(encodeURIComponent).join("/")}#L${line})`
    : label;
  return `${link}: `;
}

// Replies longer than GitHub takes are cut (as comments.mjs's).
const cut = (text) => (text.length > 60000 ? `${text.slice(0, 60000)}\n\n…` : text);

// Posts the run's final message `text` on pull request `number` as one review (POST
// /repos/{repo}/pulls/{n}/reviews), at its current head commit. The App can't request changes
// on its own pull request (GitHub answers 422): then a comment review, the verdict in its
// text. A review GitHub refuses otherwise goes as a plain comment (`reply`): nothing is lost.
// `github`: the App's calls (server.mjs).
export async function postReview({ github, reply, log = () => {} }, repo, number, text, footer) {
  const review = parseReview(text);
  let pr = null;
  try {
    pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
  } catch (error) {
    log(`${repo}#${number}: looking the pull request up for its review: ${error.message}`);
  }
  const sha = pr?.head?.sha ?? null;
  const site = pr?.base?.repo?.html_url;
  const blob = sha && site ? `${site}/blob/${sha}` : null;
  const body = `${cut(reviewBody(review, text, footer, blob))}\n\n${MARKER}`;
  const post = (event) =>
    github(
      repo,
      "POST",
      `/repos/${repo}/pulls/${number}/reviews`,
      { body, event, ...(sha ? { commit_id: sha } : {}) },
      [422],
    );
  let event = reviewEvent(review);
  let res = await post(event);
  if (res.status === 422 && event !== "COMMENT") res = await post((event = "COMMENT"));
  if (res.ok) return { event, review };
  log(`${repo}#${number}: the review was refused (${res.status}), posted as a comment`);
  await reply(repo, number, body.replace(`\n\n${MARKER}`, ""));
  return { event: null, review };
}

// A `pull_request` delivery that may start a review by itself → { repo, base, pr, author }, or
// null. Only a pull request that turned ready (marked ready, or opened as ready), on a branch
// of the repo (never a fork's), opened by the App (Deckhand's own) or an allowed user: other
// bots and outsiders never cost a review. `author`: the user, checked again with the repo's
// `users`; null for the App's.
export function reviewCandidate(config, event, p, skip = () => null) {
  if (event !== "pull_request") return null;
  const pr = p.pull_request;
  const ready = p.action === "ready_for_review" || (p.action === "opened" && pr && !pr.draft);
  if (!ready) return null;
  const repo = p.repository?.full_name;
  if (!p.installation?.id || !repo) return skip("not from an installation of the App");
  if (!repoAllowed(config, repo)) return skip(`${repo} not in ALLOWED_REPOS`);
  if (pr.state && pr.state !== "open") return skip(`review: #${pr.number} isn't open`);
  if (!sameRepo(pr, repo)) return skip(`review: #${pr.number} is from a fork`);
  const login = pr.user?.login?.toLowerCase() ?? "";
  const own = !!config.bot && login === config.bot.toLowerCase();
  if (!own && (pr.user?.type === "Bot" || !config.users.includes(login))) {
    return skip(`review: #${pr.number} by ${pr.user?.login ?? "?"}, not an allowed user`);
  }
  const base = p.repository.default_branch || "main";
  return { repo, base, pr, author: own ? null : pr.user.login };
}

// `repoSettings(repo, base)`: the repo's settings from its default branch; `accept(item)`:
// queues a work item (tasks.mjs). `now`: the clock, for forgetting old pull requests.
export function createReviews({
  path,
  config,
  repoSettings,
  accept,
  log = () => {},
  now = Date.now,
}) {
  // "org/repo#pr-5" → { head, at } of its last automatic review.
  const reviewed = persistentMap(path);

  // A `pull_request` delivery: a review run, if the repo's `review.on` asks for one and this
  // head commit hasn't had one.
  async function consider(event, payload, skip = () => null) {
    const found = reviewCandidate(config, event, payload, skip);
    if (!found) return null;
    const { repo, base, pr, author } = found;
    const { settings, errors } = await repoSettings(repo, base);
    // A broken config: its next comment's reply says why; nothing is posted for a webhook.
    if (errors.length) return skip(`review: ${repo}'s config has errors`);
    if (settings.review?.on !== "ready") return skip(`review: not on in ${repo}`);
    if (author && !settings.users.includes(author.toLowerCase())) {
      return skip(`review: ${author} not in ${repo}'s users`);
    }
    const key = taskKey(repo, prId(pr.number));
    const head = pr.head?.sha ?? null;
    if (head && reviewed.get(key)?.head === head) {
      return skip(`review: #${pr.number} at ${head.slice(0, 7)} was reviewed already`);
    }
    remember(key, head);
    log(`${key}: pull request #${pr.number} is ready, starting a review`);
    const item = {
      repo,
      id: prId(pr.number),
      kind: "pr",
      number: pr.number,
      title: pr.title ?? null,
      trigger: "review",
      modeLine: null,
      after: null,
      text: "",
      replyTo: pr.number,
      comment: null,
      base,
      settings,
      // Checked again when it runs (tasks.mjs noLongerAllowed()); the App's has none.
      ...(author ? { author } : {}),
      reason: "review",
    };
    // Deckhand's own pull request is its issue's task, like a comment on it (events.mjs).
    const issue = linkedIssue(pr, repo, config.bot);
    await accept(issue ? linkTo(item, issue) : item);
    return item;
  }

  function remember(key, head) {
    const cutoff = now() - KEEP_MS;
    for (const [k, v] of reviewed) if (v.at < cutoff) reviewed.delete(k);
    reviewed.set(key, { head, at: now() });
    reviewed.save();
  }

  return { consider };
}
