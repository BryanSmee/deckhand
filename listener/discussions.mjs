// Discussions from the dashboard: start one in the repo's discussions category, read its
// thread, reply in it. GitHub stays the source of truth: each post is the App's, written there
// first (GraphQL: discussions have no REST API for writing), and the run is the one a
// discussion or comment of that user would start, queued here since the App's own posts never
// reach admit().
//
//   POST /api/repos/<owner>/<repo>/discussions                { title, body }
//   GET  /api/repos/<owner>/<repo>/discussions/<n>            the discussion and its comments
//                                                             (GitHub asked at most once per
//                                                             THREAD_MS)
//   POST /api/repos/<owner>/<repo>/discussions/<n>/comments   { text, replyTo? }: replyTo, a
//                                                             comment's node id, for its thread
import { createHmac } from "node:crypto";
import { MAX_TEXT } from "./answers.mjs";
import { addDiscussionComment, commentThread } from "./comments.mjs";
import { normalize, repoAllowed } from "./config.mjs";
import { MARKER, discussionEntryItem, taskKey, unmarked } from "./events.mjs";
import { same } from "./html.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { readJsonBody, refuse, send } from "../lib/http.mjs";
import { apiRoute } from "./web.mjs";

// How long a thread is kept: the dashboard polls it while it is open.
export const THREAD_MS = 15_000;
// GitHub's own limit for a discussion's title.
export const MAX_TITLE = 256;
// The text, and the JSON around it (escapes).
const MAX_BODY = 4 * MAX_TEXT + 4 * MAX_TITLE;
// How many comments, and replies to each, a thread shows: the latest.
const COMMENTS = 100;
const REPLIES = 50;

// The key that signs the "from" lines (fromLine()), from the App's webhook secret: the
// listener's to know, and kept across restarts.
export const fromKey = (secret) =>
  secret ? createHmac("sha256", secret).update("deckhand-from").digest() : null;

// The tag of `user`'s `text`: whitespace aside, as GitHub may give it back with \r\n.
const fromTag = (key, user, text) =>
  createHmac("sha256", key)
    .update(`${user.toLowerCase()}\n${text.replace(/\s+/g, " ").trim()}`)
    .digest("base64url")
    .slice(0, 32);

// The line that says who wrote an App post from the dashboard, as the dashboard shows it,
// signed (`key`: fromKey()'s) for that text: a run posts as the App too, and could otherwise
// write the line under its own text, or under someone else's name.
export function fromLine(user, text, key) {
  const line = `From the dashboard by @${user}`;
  return key ? `${line} <!-- deckhand-from:${user}:${fromTag(key, user, text)} -->` : line;
}

// The App's post of `user`'s `text`, from the dashboard: the text, then who wrote it.
export function fromDashboard(user, text, key) {
  return `${text.trim()}\n\n${fromLine(user, text.trim(), key)}`;
}

const FROM = /\n*From the dashboard by @([\w-]+)[ \t]*<!-- deckhand-from:([\w-]+):([\w-]+) -->\s*$/;

const AUTHOR = "author { login __typename }";
const POST = `id databaseId url body createdAt ${AUTHOR}`;
const THREAD = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { ${POST} number title category { name } comments(last: ${COMMENTS}) { totalCount nodes { ${POST} replies(last: ${REPLIES}) { totalCount nodes { ${POST} } } } } } } }`;

// A post as the dashboard shows it: { id, url, author, deckhand, at, body }. The App's posts
// are Deckhand's answers (they end with the marker, left out), or a dashboard user's (the last
// line says who, with a tag `key` (fromKey()'s) signed for its text; left out too). Only the
// App's own: anyone may write that line. Any other App post is shown as the App's: a run's,
// say, whatever its last line claims.
export function postOf(node, bot, key = null) {
  const login = node.author?.login ?? null;
  const app =
    node.author?.__typename === "Bot" &&
    !!bot &&
    login?.replace(/\[bot\]$/i, "").toLowerCase() === bot.replace(/\[bot\]$/i, "").toLowerCase();
  let body = node.body ?? "";
  let author = login;
  let deckhand = false;
  if (app && body.trimEnd().endsWith(MARKER)) {
    deckhand = true;
    body = body.trimEnd().slice(0, -MARKER.length).trim();
  } else if (app && key) {
    const from = FROM.exec(body);
    const text = from && body.slice(0, from.index).trim();
    if (
      from &&
      from[1].toLowerCase() === from[2].toLowerCase() &&
      same(from[3], fromTag(key, from[1], text))
    ) {
      author = from[1];
      body = text;
    }
  }
  return { id: node.id, url: node.url ?? null, author, deckhand, at: node.createdAt ?? null, body };
}

// The GraphQL discussion → the dashboard's thread: the opening post, then each comment with its
// replies. `more`: comments (or replies) older than those shown, on GitHub only. `key`: postOf()'s.
export function threadOf(d, bot, key = null) {
  const comments = d.comments?.nodes ?? [];
  return {
    number: d.number,
    title: d.title ?? null,
    url: d.url ?? null,
    post: postOf(d, bot, key),
    more: Math.max(0, (d.comments?.totalCount ?? 0) - comments.length),
    comments: comments.map((c) => ({
      ...postOf(c, bot, key),
      more: Math.max(0, (c.replies?.totalCount ?? 0) - (c.replies?.nodes?.length ?? 0)),
      replies: (c.replies?.nodes ?? []).map((r) => postOf(r, bot, key)),
    })),
  };
}

// `graphql(repo, query, variables)`: the App's calls, throwing on errors (github.mjs).
// `checkedRepo(repo, user)`: the dashboard's checks for the repo (repo-check.mjs): { settings, base }.
// `nameOf(repo)`: GitHub's spelling of its name (repo-check.mjs). `accept(item)` (tasks.mjs).
export function createDiscussionApi({
  config,
  graphql,
  checkedRepo,
  nameOf = async (repo) => repo,
  accept,
  publicUrl = () => null,
  // The key of the dashboard's "from" lines (fromKey()), or null without an App.
  key = () => null,
  now = Date.now,
  log = () => {},
}) {
  // "owner/repo#n" → { at, read: Promise<thread> }
  const threads = new Map();

  const split = (repo) => repo.split("/");

  // The repo's checks, and its discussions category: { settings, base, category }.
  async function checked(repo, user) {
    const { settings, base } = await checkedRepo(repo, user);
    const category = settings.inbox?.discussions;
    if (!category) {
      refuse(
        409,
        `${repo} has no discussions category: see \`inbox.discussions\` in its ${CONFIG_FILE}.`,
      );
    }
    return { settings, base, category };
  }

  // A read that GitHub answers with NOT_FOUND (a discussion or node that isn't there): null.
  // github.mjs graphql() throws on GraphQL's errors, which come with a 200.
  async function lookup(repo, query, variables) {
    try {
      return await graphql(repo, query, variables);
    } catch (error) {
      if (/"type":"NOT_FOUND"/.test(error.message ?? "")) return null;
      throw error;
    }
  }

  // Discussion `number`, in the category: { node, thread } (the GraphQL node and the
  // dashboard's thread). Refused when it isn't one, or is in another category: those are never
  // read, here as for webhooks.
  async function discussion(repo, number, category) {
    const [owner, name] = split(repo);
    const data = await lookup(repo, THREAD, { owner, name, number });
    const d = data?.repository?.discussion;
    if (!d) refuse(404, `#${number} isn't a discussion of ${repo}.`);
    if (normalize(d.category?.name ?? "") !== category) {
      refuse(404, `#${number} isn't in ${repo}'s discussions category.`);
    }
    return { node: d, thread: threadOf(d, config.bot, key()) };
  }

  // The checks and the thread are read together, and kept: each poll would ask GitHub for the
  // repo and its config otherwise. Another user is checked against the users read then.
  async function read(res, repo, user, number) {
    const key = `${repo.toLowerCase()}#${number}`;
    let known = threads.get(key);
    if (!known || now() - known.at >= THREAD_MS) {
      const read = checked(repo, user).then(async ({ settings, category }) => ({
        users: settings.users,
        thread: (await discussion(repo, number, category)).thread,
      }));
      known = { at: now(), read };
      threads.set(key, known);
      // A failure or a refusal is not kept: the next poll asks again.
      read.catch(() => threads.get(key) === known && threads.delete(key));
    }
    const { users, thread } = await known.read;
    const login = user.toLowerCase();
    if (!config.users.includes(login)) refuse(403, `${user} is not in ALLOWED_USERS.`);
    if (!users.includes(login)) refuse(403, `${user} is not among ${repo}'s users.`);
    send(res, 200, { ...thread, readAt: known.at });
  }

  // A new discussion in the category, as the App, then the run a new discussion there starts.
  async function start(repo, user, { title, body }) {
    const { settings, base, category } = await checked(repo, user);
    const [owner, name] = split(repo);
    const data = await graphql(
      repo,
      "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id hasDiscussionsEnabled discussionCategories(first: 100) { nodes { id name } } } }",
      { owner, name },
    );
    const r = data.repository;
    const found = (r?.discussionCategories?.nodes ?? []).find(
      (c) => normalize(c.name) === category,
    );
    if (!r?.hasDiscussionsEnabled || !found) {
      refuse(
        409,
        `${repo} has no discussion category "${category}": create it in its Discussions (turn them on in its settings first), as \`inbox.discussions\` in its ${CONFIG_FILE} names it.`,
      );
    }
    const made = await graphql(
      repo,
      "mutation($repo: ID!, $category: ID!, $title: String!, $body: String!) { createDiscussion(input: {repositoryId: $repo, categoryId: $category, title: $title, body: $body}) { discussion { id databaseId number title url } } }",
      {
        repo: r.id,
        category: found.id,
        title: title.trim(),
        body: fromDashboard(user, body, key()),
      },
    );
    const d = made.createDiscussion.discussion;
    await accept({
      ...discussionEntryItem(
        repo,
        { number: d.number, title: d.title, html_url: d.url, node_id: d.id, id: d.databaseId },
        null,
        { login: user },
        body,
      ),
      author: user,
      base,
      settings,
      // For the policies' `input.trigger` (run-policy.mjs).
      dashboard: true,
    });
    return {
      message: `Discussion #${d.number} started.`,
      url: d.url,
      number: d.number,
      task: taskKey(repo, `discussion-${d.number}`),
    };
  }

  // A comment in discussion `number`, in `replyTo`'s thread when given (GitHub threads are one
  // level deep: a reply's thread is its comment's), then the run a comment there starts. A
  // run going takes it mid-run, as a GitHub comment (tasks.mjs accept()).
  async function comment(repo, user, number, { text, replyTo }) {
    const { settings, base, category } = await checked(repo, user);
    const { node: d } = await discussion(repo, number, category);
    let thread = null;
    if (replyTo) {
      const found = await commentThread(lookup, repo, replyTo);
      if (found?.discussion !== d.id) refuse(404, `That comment isn't in discussion #${number}.`);
      thread = found.thread;
    }
    const c = await addDiscussionComment(
      graphql,
      repo,
      { id: d.id, thread, body: fromDashboard(user, text, key()) },
      "id databaseId url replyTo { databaseId }",
    );
    // Shown on the next read, not in THREAD_MS.
    threads.delete(`${repo.toLowerCase()}#${number}`);
    await accept({
      ...discussionEntryItem(
        repo,
        { number: d.number, title: d.title, html_url: d.url, node_id: d.id, id: d.databaseId },
        { id: c.databaseId, node_id: c.id, html_url: c.url, parent_id: c.replyTo?.databaseId },
        { login: user },
        text,
      ),
      author: user,
      base,
      settings,
      // For the policies' `input.trigger` (run-policy.mjs).
      dashboard: true,
    });
    return { message: `Sent to discussion #${number}.`, url: c.url };
  }

  // A text field: a string, not blank, not over `max`, without the App's marks (unmarked()).
  function field(value, what, max) {
    if (typeof value !== "string" || !unmarked(value).trim()) refuse(400, `Write ${what}.`);
    if (value.length > max)
      refuse(413, `The ${what.replace(/^(a|an|the) /, "")} is over ${max} characters.`);
    return unmarked(value);
  }

  async function started(req, res, user, repo) {
    const body = (await readJsonBody(req, MAX_BODY)) ?? {};
    const title = field(body.title, "a title", MAX_TITLE);
    const text = field(body.body, "the discussion's text", MAX_TEXT);
    log(`Discussions: ${user} starts one in ${repo}`);
    send(res, 200, await start(repo, user, { title, body: text }));
  }

  async function commented(req, res, user, repo, number) {
    const body = (await readJsonBody(req, MAX_BODY)) ?? {};
    const text = field(body.text, "a comment", MAX_TEXT);
    const replyTo = body.replyTo ?? null;
    if (replyTo !== null && (typeof replyTo !== "string" || !/^[\w=-]+$/.test(replyTo))) {
      refuse(400, "`replyTo` is a comment's node id.");
    }
    log(`Discussions: ${user} comments on ${repo} discussion #${number}`);
    send(res, 200, await comment(repo, user, number, { text, replyTo }));
  }

  // A route of discussion <n>: one past what JavaScript counts exactly is none.
  const numbered =
    (handler) =>
    (req, res, user, repo, { number }) =>
      Number.isSafeInteger(number)
        ? handler(req, res, user, repo, number)
        : send(res, 404, { error: "No such discussion." });

  // Handles /api/repos/<owner>/<repo>/discussions[/<n>[/comments]]; false for any other path.
  const handle = apiRoute({
    name: "Discussions",
    route: (pathname) => {
      const one = /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/discussions(?:\/(\d+)(\/comments)?)?$/.exec(
        pathname,
      );
      if (!one) return null;
      const what = !one[3] ? "start" : one[4] ? "comment" : "thread";
      return { repo: `${one[1]}/${one[2]}`, what, number: one[3] ? Number(one[3]) : null };
    },
    posts: { start: started, comment: numbered(commented) },
    gets: { thread: numbered((req, res, user, repo, number) => read(res, repo, user, number)) },
    allowed: (repo) => repoAllowed(config, repo),
    named: nameOf,
    publicUrl,
    log,
  });

  return { handle };
}
