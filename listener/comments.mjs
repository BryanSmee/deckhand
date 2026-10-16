// What the listener writes on GitHub for a run: its reply (a comment, or in a discussion's
// thread), the reactions on the comments it handled, and the needs-input label.
import { MARKER } from "./events.mjs";

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

// GraphQL's names for the reactions above.
const REACTION_ENUM = {
  eyes: "EYES",
  rocket: "ROCKET",
  confused: "CONFUSED",
  "-1": "THUMBS_DOWN",
  "+1": "THUMBS_UP",
};

// Whether `labels` (an issue's, as GitHub has them: names or { name }) hold `name`. GitHub's
// label names are case-insensitive: a "Needs-Input" set by hand is the same label.
export function hasLabel(labels, name) {
  if (!name) return false;
  const wanted = name.toLowerCase();
  return (labels ?? []).some(
    (l) => (typeof l === "string" ? l : l?.name)?.toLowerCase() === wanted,
  );
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
export async function addDiscussionComment(graphql, repo, { id, thread, body }, fields = "url") {
  const data = await graphql(
    repo,
    `mutation($id: ID!, $thread: ID, $body: String!) { addDiscussionComment(input: {discussionId: $id, replyToId: $thread, body: $body}) { comment { ${fields} } } }`,
    { id, thread, body },
  );
  return data.addDiscussionComment.comment;
}

// Replies longer than GitHub takes are cut.
function cut(text) {
  return text.length > 60000 ? text.slice(0, 60000) + "\n\n…" : text;
}

// `github` and `graphql`: calls as the App's installation (server.mjs).
export function createComments({ config, github, graphql, log }) {
  // Reaction failures (already removed, 403, 404…) are logged and never break a run.
  async function react(repo, comment, content) {
    const kind = comment.review ? "pulls/comments" : "issues/comments";
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
        await github(
          repo,
          "DELETE",
          `/repos/${repo}/${kind}/${comment.id}/reactions/${eyes}`,
          null,
          [404],
        );
      }
    } catch (error) {
      log(`Reaction on comment ${comment.id}: ${error}`);
    }
    if (REACTIONS[status]) await react(repo, comment, REACTIONS[status]);
  }

  function reply(repo, number, text) {
    return github(repo, "POST", `/repos/${repo}/issues/${number}/comments`, {
      body: `${cut(text)}\n\n${MARKER}`,
    });
  }

  // Where a run's answer goes: a comment on the issue or pull request `target.replyTo`, or in
  // the discussion, in the thread of the comment it answers (`target.comment`; GitHub threads
  // are one level deep, so a reply to a reply goes to the same thread).
  async function answer(target, text) {
    if (target.kind !== "discussion") return reply(target.repo, target.replyTo, text);
    const c = target.comment;
    let thread = null;
    if (c?.discussion && c.node_id !== target.discussionId) {
      thread = c.parent_id
        ? ((await commentThread(graphql, target.repo, c.node_id))?.thread ?? null)
        : c.node_id;
    }
    return addDiscussionComment(graphql, target.repo, {
      id: target.discussionId,
      thread,
      body: `${cut(text)}\n\n${MARKER}`,
    });
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

  return { received, settle, reply, answer, label };
}
