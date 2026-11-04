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
import { startAction } from "./permissions.mjs";
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

// The key that signs the "from" lines (fromLine()), from the App's webhook secret: edge's to
// know (#506), and kept across restarts. The orchestrator, which posts them, asks edge for their
// tags (tagger()).
export const fromKey = (secret) =>
  secret ? createHmac("sha256", secret).update("deckhand-from").digest() : null;

// The tag of `user`'s `text`: whitespace aside, as GitHub may give it back with \r\n. Edge
// computes them (../edge/internal.mjs), which holds the webhook secret the key comes from.
export const fromTag = (key, user, text) =>
  createHmac("sha256", key)
    .update(`${user.toLowerCase()}\n${text.replace(/\s+/g, " ").trim()}`)
    .digest("base64url")
    .slice(0, 32);

// The line that says who wrote an App post from the dashboard, as the dashboard shows it,
// signed (`key`: fromKey()'s) for that text: a run posts as the App too, and could otherwise
// write the line under its own text, or under someone else's name.
export function fromLine(user, text, key) {
  return taggedLine(user, key ? fromTag(key, user, text) : null);
}

// The line with its tag, from wherever it came (tagger()); none: unsigned.
function taggedLine(user, tag) {
  const line = `From the dashboard by @${user}`;
  return tag ? `${line} <!-- deckhand-from:${user}:${tag} -->` : line;
}

// The App's post of `user`'s `text`, from the dashboard: the text, then who wrote it.
export function fromDashboard(user, text, key) {
  return `${text.trim()}\n\n${fromLine(user, text.trim(), key)}`;
}

// What tags the "from" lines: `tags([{ user, text }])` → their tags (null for none), edge's
// (../edge/client.mjs tags()), or, from a key (fromKey()'s, the tests'), computed here.
export function tagger({ tags = null, key = () => null } = {}) {
  const all =
    tags ??
    (async (items) => {
      const k = key();
      return items.map(({ user, text }) => (k ? fromTag(k, user, text) : null));
    });
  return {
    // fromDashboard()'s, signed by `all`.
    async post(user, text) {
      const [tag] = await all([{ user, text: text.trim() }]);
      return `${text.trim()}\n\n${taggedLine(user, tag)}`;
    },
    // A verifier for postOf() of the nodes given: their "from" lines' tags asked at once.
    async verifier(nodes) {
      const claims = [];
      for (const node of nodes) {
        const body = node?.body ?? "";
        const from = FROM.exec(body);
        if (from) claims.push({ user: from[1], text: body.slice(0, from.index).trim() });
      }
      const tags = await all(claims);
      const known = new Map(claims.map((c, i) => [`${c.user}\n${c.text}`, tags[i]]));
      return (user, text, tag) => {
        const expected = known.get(`${user}\n${text}`);
        return !!expected && same(tag, expected);
      };
    },
  };
}

const FROM = /\n*From the dashboard by @([\w-]+)[ \t]*<!-- deckhand-from:([\w-]+):([\w-]+) -->\s*$/;

const AUTHOR = "author { login __typename }";
const POST = `id databaseId url body createdAt ${AUTHOR}`;
const THREAD = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { ${POST} number title category { name } comments(last: ${COMMENTS}) { totalCount nodes { ${POST} replies(last: ${REPLIES}) { totalCount nodes { ${POST} } } } } } } }`;

// Whether `node` is the App's own post (`bot`: its login).
function byApp(node, bot) {
  const login = node?.author?.login;
  return (
    node?.author?.__typename === "Bot" &&
    !!bot &&
    login?.replace(/\[bot\]$/i, "").toLowerCase() === bot.replace(/\[bot\]$/i, "").toLowerCase()
  );
}

// A post as the dashboard shows it: { id, url, author, deckhand, at, body }. The App's posts
// are Deckhand's answers (they end with the marker, left out), or a dashboard user's (the last
// line says who, with a tag `key` (fromKey()'s, or a verifier from tagger()) signed for its
// text; left out too). Only the App's own: anyone may write that line. Any other App post is
// shown as the App's: a run's, say, whatever its last line claims.
export function postOf(node, bot, key = null) {
  const verify =
    typeof key === "function" ? key : (user, text, tag) => same(tag, fromTag(key, user, text));
  const login = node.author?.login ?? null;
  const app = byApp(node, bot);
  let body = node.body ?? "";
  let author = login;
  let deckhand = false;
  if (app && body.trimEnd().endsWith(MARKER)) {
    deckhand = true;
    body = body.trimEnd().slice(0, -MARKER.length).trim();
  } else if (app && key) {
    const from = FROM.exec(body);
    const text = from && body.slice(0, from.index).trim();
    if (from && from[1].toLowerCase() === from[2].toLowerCase() && verify(from[1], text, from[3])) {
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
  // The key of the dashboard's "from" lines (fromKey()), or null without an App; or what tags
  // them, edge's (tagger() `tags`).
  key = () => null,
  tags = null,
  // Who may do what where (permissions.mjs): reading a thread, starting or commenting on one.
  permissions = null,
  now = Date.now,
  log = () => {},
}) {
  const from = tagger({ tags, key });
  // "owner/repo#n" → { at, read: Promise<thread> }
  const threads = new Map();

  const split = (repo) => repo.split("/");

  // accept(), then the policies' refusal (run-policy.mjs: `refused`, already replied in the
  // discussion) as the dashboard's answer.
  async function queued(item) {
    await accept(item);
    if (item.refused) refuse(403, item.refused);
  }

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
    const nodes = [
      d,
      ...(d.comments?.nodes ?? []).flatMap((c) => [c, ...(c.replies?.nodes ?? [])]),
    ];
    // The App's own posts only: anyone may end a comment with a "from" line.
    const verify = await from.verifier(nodes.filter((n) => n?.body && byApp(n, config.bot)));
    return { node: d, thread: threadOf(d, config.bot, verify) };
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
        body: await from.post(user, body),
      },
    );
    const d = made.createDiscussion.discussion;
    const item = {
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
    };
    await accept(item);
    // Refused by the policies (their reply is in it): the discussion made for it is closed, as a
    // refused Analyze's issue (analysis.mjs), and their reply is the form's answer.
    if (item.refused) {
      await graphql(
        repo,
        "mutation($id: ID!) { closeDiscussion(input: {discussionId: $id, reason: OUTDATED}) { discussion { id } } }",
        { id: d.id },
      ).catch((error) =>
        log(`${repo}#discussion-${d.number}: closing it: ${error.message ?? error}`),
      );
      refuse(403, item.refused);
    }
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
      { id: d.id, thread, body: await from.post(user, text) },
      "id databaseId url replyTo { databaseId }",
    );
    // Shown on the next read, not in THREAD_MS.
    threads.delete(`${repo.toLowerCase()}#${number}`);
    await queued({
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
    permissions,
    action: ({ what }) => (what === "thread" ? "tasks:read" : startAction("discussion")),
    named: nameOf,
    publicUrl,
    log,
  });

  return { handle };
}
