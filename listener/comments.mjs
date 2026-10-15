// What the listener writes on GitHub for a run: its reply (a comment, or in a discussion's
// thread), the reactions on the comments it handled, and the needs-input label.
import { MARKER } from "./events.mjs";

// GitHub's reactions have no ✅: 🚀 reads as "shipped" and isn't mistaken for a manual 👍.
// A wrap-up ("/stop") only loses its 👀.
const REACTIONS = {
  ok: "rocket",
  "needs-input": "confused",
  error: "-1",
  stopped: null,
};

// GraphQL's names for the reactions above.
const REACTION_ENUM = { eyes: "EYES", rocket: "ROCKET", confused: "CONFUSED", "-1": "THUMBS_DOWN" };

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
      thread = c.node_id;
      if (c.parent_id) {
        const data = await graphql(
          target.repo,
          "query($id: ID!) { node(id: $id) { ... on DiscussionComment { replyTo { id } } } }",
          { id: c.node_id },
        );
        thread = data.node?.replyTo?.id ?? null;
      }
    }
    return graphql(
      target.repo,
      "mutation($id: ID!, $thread: ID, $body: String!) { addDiscussionComment(input: {discussionId: $id, replyToId: $thread, body: $body}) { comment { url } } }",
      { id: target.discussionId, thread, body: `${cut(text)}\n\n${MARKER}` },
    );
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
