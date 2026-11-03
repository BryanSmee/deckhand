// What the listener writes on GitHub for a run: its reply (a comment, or in a discussion's
// thread), the reactions on the comments it handled, and the needs-input label.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { hasLabel, MARKER } from "./events.mjs";
import { getJson } from "./github.mjs";
import { reactionSubject } from "./github-writes.mjs";
import { readJson } from "../lib/files.mjs";

// GitHub's reactions have no ✅: 🚀 reads as "shipped" and isn't mistaken for a manual 👍.
// A wrap-up ("/stop") and a cancelled run's comments only lose their 👀; a `/cancel` gets 👍.
const REACTIONS = {
  ok: "rocket",
  "needs-input": "confused",
  error: "-1",
  stopped: null,
  cancelled: null,
  acknowledged: "+1",
};

// GraphQL's names for GitHub's reactions, by REST's: the listener's above, and those a run adds
// (github-graphql.mjs REACTION_CONTENT reads it the other way).
export const REACTION_ENUM = {
  "+1": "THUMBS_UP",
  "-1": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
};

// The most reactions of the listener's kept without the github service (claim()), its newest: a run's
// reaction removed then is one the listener added before that many others.
const MAX_CLAIMED = 5000;

// Whether an issue's labels hold one: events.mjs's, which replays need too.
export { hasLabel };

// Whether pull request `pr` (as GitHub has it), or issue `issue` (its number, or null: none),
// where runs put the label, waits for the maintainer's input. `github`: the App's calls.
export async function waitsForInput(github, config, repo, pr, issue) {
  const name = config.needsInputLabel;
  if (!name) return false;
  if (hasLabel(pr.labels, name)) return true;
  if (!issue) return false;
  const found = await getJson(github, repo, `/repos/${repo}/issues/${issue}`, [404, 410]);
  return hasLabel(found?.labels, name);
}

// The label `label.name` ({ name, color, description }) on the repo, made when it isn't there
// yet. Already there (422) is fine: only its colour and description are ours. `github`: the
// App's calls (server.mjs). A failure is logged: the issue it was for goes on without it.
export async function ensureLabel(github, repo, label, log = () => {}) {
  const res = await github(repo, "POST", `/repos/${repo}/labels`, label, [422]);
  if (!res.ok && res.status !== 422) log(`${repo}: the ${label.name} label: ${res.status}`);
}

// Whether a call of label() below failed: taking off a label that isn't there (404) didn't.
export const labelFailed = (res) => !res.ok && res.status !== 404;

// A discussion comment's thread: GitHub threads are one level deep, so a reply's thread is
// its comment's. { discussion, thread } (node ids), or null when `id` is no discussion comment.
// `discussion`: null when GitHub doesn't say.
export async function commentThread(graphql, repo, id) {
  const data = await graphql(
    repo,
    "query($id: ID!) { node(id: $id) { ... on DiscussionComment { id discussion { id } replyTo { id } } } }",
    { id },
  );
  const c = data?.node;
  if (!c?.id) return null;
  return { discussion: c.discussion?.id ?? null, thread: c.replyTo?.id ?? c.id };
}

// A comment in discussion `id` (a node id), in `thread`'s thread or at the top (null): the
// comment's `fields`, as GraphQL names them.
// `key`: its idempotency key, when asking again must not post it twice (a run's reply).
export async function addDiscussionComment(
  graphql,
  repo,
  { id, thread, body },
  fields = "url",
  key = null,
) {
  const data = await graphql(
    repo,
    `mutation($id: ID!, $thread: ID, $body: String!) { addDiscussionComment(input: {discussionId: $id, replyToId: $thread, body: $body}) { comment { ${fields} } } }`,
    { id, thread, body },
    ...(key ? [{ key }] : []),
  );
  return data.addDiscussionComment.comment;
}

// Replies longer than GitHub takes are cut.
function cut(text) {
  return text.length > 60000 ? text.slice(0, 60000) + "\n\n…" : text;
}

// A reply GitHub refused even so (20 000 UTF-16 code units: under its 65 536 characters
// whether it counts them, code points or UTF-8 bytes): its start, and where the rest is.
const SHORT = 20000;
function shorten(text, full) {
  const rest = full ? `[on the dashboard](${full})` : "on the dashboard";
  return `${text.slice(0, SHORT)}\n\n…\n\n_Cut: GitHub refused the whole answer. The full answer is ${rest}._`;
}

// A reply GitHub didn't take, retries included. `status`: its last answer's (null: none, or a
// GraphQL error); `reason`: that status, else what GitHub or the call said.
export class ReplyError extends Error {
  constructor(what, status, detail = "") {
    super(`${what}: ${status ?? "no answer"}${detail ? ` ${detail}` : ""}`);
    this.name = "ReplyError";
    this.status = status;
    this.reason = status ?? (detail.slice(0, 120) || "GitHub didn't answer");
  }
}

// Waits between tries of a reply GitHub may take later (a 5xx, a rate limit).
const RETRY_DELAYS = [5000, 30000, 90000];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Whether a refusal may pass later: GitHub's 5xx, its rate limits (429, or a 403 that says so),
// no answer at all (not a GraphQL error: `refused`).
const transient = (status, detail, refused) =>
  (status === null && !refused) ||
  status >= 500 ||
  status === 429 ||
  (status === 403 && /rate limit/i.test(detail));

// `github` and `graphql`: calls as the App's installation (server.mjs). `delays`: between the
// tries of a reply (tests make them short).
export function createComments({
  config,
  github,
  graphql,
  log,
  // The github service's record of them (../github/client.mjs claim()), which its gateway reads:
  // (repo, subject, content, held) → a promise. None: `claims` alone (the tests').
  shared = null,
  claims = new Map(),
  delays = RETRY_DELAYS,
  sleep = wait,
}) {
  // The reactions the listener added on comments, on any task's (its 👀, an outcome's, a held
  // comment's 😕), by "repo subject content" (github-writes.mjs reactionSubject()), with when.
  // A run's reactions are the same bot's: GitHub keeps one per user and content, so where the
  // run's came first, the listener's POST answers with it, and the run never removes these
  // (github-writes.mjs listenerReacted). Kept by the github service, whose gateway reads them
  // (`shared`); those a listener from before it saved in reactions.json go there at start, and
  // the file goes once they are there.
  const legacy = config.dataDir ? join(config.dataDir, "reactions.json") : null;
  if (shared && legacy) {
    const all = Object.keys(readJson(legacy, {}) ?? {});
    Promise.all(all.map((key) => shared(...key.split(" "), true)))
      .then(() => {
        rmSync(legacy, { force: true });
        if (!all.length) return;
        log(
          `The listener's ${all.length} reaction(s) from reactions.json: the github service has them`,
        );
      })
      .catch((error) => log(`The listener's reactions: not handed over (${error.message})`));
  }
  const claimKey = (repo, comment, content) => {
    const reacted = { id: comment.id, type: comment.review ? "review" : "issue" };
    return `${String(repo).toLowerCase()} ${reactionSubject({ reacted })} ${content}`;
  };
  // Before GitHub is asked, so no run's removal slips in between; kept if the POST fails (a
  // run's same reaction then stays, fail closed). `held`: false once the listener took it off.
  // → whether it was noted: a reaction whose claim the github service didn't take isn't added
  // (a run could take it off otherwise: fail closed).
  async function claim(repo, comment, content, held = true) {
    if (comment.discussion) return true;
    const key = claimKey(repo, comment, content);
    if (shared) {
      try {
        await shared(...key.split(" "), held);
        return true;
      } catch (error) {
        log(`Noting the listener's reaction: ${error.message ?? error}`);
        return false;
      }
    }
    claims.delete(key);
    if (held) claims.set(key, Date.now());
    while (claims.size > MAX_CLAIMED) claims.delete(claims.keys().next().value);
    return true;
  }
  // Whether the listener added reaction `content` on `subject` (reactionSubject()'s) of `repo`.
  function listenerReacted(repo, subject, content) {
    return claims.has(`${String(repo).toLowerCase()} ${subject} ${content}`);
  }

  // Reaction failures (already removed, 403, 404…) are logged and never break a run.
  async function react(repo, comment, content) {
    const kind = comment.review ? "pulls/comments" : "issues/comments";
    if (!(await claim(repo, comment, content))) {
      log(`Reaction on comment ${comment.id}: not added, its claim not noted`);
      return null;
    }
    try {
      if (comment.discussion) {
        // Removed by content rather than id (settle()): any truthy value will do.
        await graphql(
          repo,
          "mutation($id: ID!, $content: ReactionContent!) { addReaction(input: {subjectId: $id, content: $content}) { clientMutationId } }",
          { id: comment.node_id, content: REACTION_ENUM[content] },
        );
        return content;
      }
      const res = await github(repo, "POST", `/repos/${repo}/${kind}/${comment.id}/reactions`, {
        content,
      });
      return res.ok ? (await res.json()).id : null;
    } catch (error) {
      log(`Reaction on comment ${comment.id}: ${error}`);
      return null;
    }
  }

  // 👀 on receipt; its id is kept so the run's outcome can replace it (a reaction can't be
  // edited). Reviews without a comment have no reactions API: they get none.
  function received(item) {
    if (item.comment) item.eyes = react(item.repo, item.comment, "eyes");
  }

  // Once the run that handled a comment is over: 👀 off, then the outcome's reaction.
  async function settle(item, status) {
    const { repo, comment } = item;
    if (!comment) return;
    const kind = comment.review ? "pulls/comments" : "issues/comments";
    try {
      const eyes = await item.eyes;
      if (eyes && comment.discussion) {
        await graphql(
          repo,
          "mutation($id: ID!) { removeReaction(input: {subjectId: $id, content: EYES}) { clientMutationId } }",
          { id: comment.node_id },
        );
      } else if (eyes) {
        const res = await github(
          repo,
          "DELETE",
          `/repos/${repo}/${kind}/${comment.id}/reactions/${eyes}`,
          null,
          [404],
        );
        if (res?.ok || res?.status === 404) await claim(repo, comment, "eyes", false);
      }
    } catch (error) {
      log(`Reaction on comment ${comment.id}: ${error}`);
    }
    if (REACTIONS[status]) await react(repo, comment, REACTIONS[status]);
  }

  // Posts `text` with `send(body)`, which answers { value } once posted, else { status,
  // detail, refused }: tried again after a 5xx or a rate limit, shortened once after a 422
  // (too long, most likely: `full` is where the whole answer is). What still fails throws a
  // ReplyError.
  async function deliver(what, send, text, full) {
    let body = cut(text);
    let shortened = false;
    for (let tries = 0; ;) {
      const sent = await send(`${body}\n\n${MARKER}`);
      if (!("status" in sent)) return sent.value;
      const { status, detail, refused } = sent;
      // Once: a 422 that has nothing to do with its length would come back each time.
      if ((status === 422 || /too long/i.test(detail)) && !shortened && text.length > SHORT) {
        log(`${what}: ${status ?? "too long"}, posted again shortened`);
        body = shorten(text, full);
        shortened = true;
      } else if (transient(status, detail, refused) && tries < delays.length) {
        log(`${what}: ${status ?? detail}, tried again in ${delays[tries] / 1000} s`);
        await sleep(delays[tries++]);
      } else throw new ReplyError(what, status, detail.slice(0, 200));
    }
  }

  // A comment on issue or pull request `number`: GitHub's response, or it throws (deliver()).
  // `full`: where the whole text can be read, should GitHub only take its start.
  // `key`: its idempotency key, when asking again must not post it twice (a run's reply).
  function reply(repo, number, text, { full, key } = {}) {
    const path = `/repos/${repo}/issues/${number}/comments`;
    const send = async (body) => {
      let res;
      try {
        res = await github(repo, "POST", path, { body }, [], key ? { key } : undefined);
      } catch (error) {
        return { status: null, detail: error.message ?? String(error) };
      }
      if (res.ok) return { value: res };
      const detail = await res.text().catch(() => "");
      return { status: res.status, detail };
    };
    return deliver(`GitHub POST ${path}`, send, text, full);
  }

  // Where a run's answer goes: a comment on the issue or pull request `target.replyTo`, or in
  // the discussion, in the thread of the comment it answers (`target.comment`; GitHub threads
  // are one level deep, so a reply to a reply goes to the same thread). Throws when GitHub
  // doesn't take it (deliver()). `full`: as reply()'s.
  async function answer(target, text, { full, key } = {}) {
    if (target.kind !== "discussion") {
      return reply(target.repo, target.replyTo, text, { full, key });
    }
    const c = target.comment;
    let thread = null;
    if (c?.discussion && c.node_id !== target.discussionId) {
      thread = c.parent_id
        ? ((await commentThread(graphql, target.repo, c.node_id))?.thread ?? null)
        : c.node_id;
    }
    // GraphQL's errors are thrown (graphqlData()): "<what>: <status> <errors>".
    const send = async (body) => {
      try {
        const id = target.discussionId;
        const comment = { id, thread, body };
        return { value: await addDiscussionComment(graphql, target.repo, comment, "url", key) };
      } catch (error) {
        const detail = error.message ?? String(error);
        const status = Number(/^GraphQL: (\d{3}) /.exec(detail)?.[1]) || null;
        // Its errors come with a 200, its rate limit too.
        if (/RATE_LIMITED/.test(detail)) return { status: 429, detail };
        if (status && status < 300) return { status: null, detail, refused: true };
        return { status, detail };
      }
    };
    return deliver(`A comment in discussion ${target.discussionId}`, send, text, full);
  }

  // Adding a label that doesn't exist yet creates it.
  function label(repo, number, add) {
    const name = config.needsInputLabel;
    return add
      ? github(repo, "POST", `/repos/${repo}/issues/${number}/labels`, {
          labels: [name],
        })
      : github(
          repo,
          "DELETE",
          `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`,
          null,
          [404],
        );
  }

  return { received, settle, reply, answer, label, listenerReacted };
}
