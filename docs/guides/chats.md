# Chats

A chat is a conversation a user has with the agent on one repository, from the dashboard
rather than an issue (`/api/chats`, [Chats](../contributing/runs.md#chats)). It runs in
the repository's image, with its grants (hosts, setup) and under its `users`, in volumes of
its own, and its answers stay in the conversation: Deckhand's default policies
(`policy/mode-chat.rego`) give it the code, its setup and its reads, no branch, no engine and
no GitHub write. Only its owner sees it, on the dashboard's Chats page (`#/chats` for every
repository's, `#/<owner>/<repo>/chats` for one's, as its tasks and board): the chats they keep
against `CHATS_PER_USER`, New chat (the repository, then the agent, model and effort), the
conversation, and each chat's menu: its permissions (#478), Reset and Delete.

- `CHATS_PER_USER` (2) is how many chats a user keeps, running or not, across the
  repositories; a repository's `chats.per_user` may lower it ([repo-config/issues.md](../repo-config/issues.md#chats)).
  `0`: no chats.
- `MAX_RUNNING_CHATS` (2) is how many chats' sandboxes run at once, apart from
  `MAX_PARALLEL`: chats never hold an issue's run back, nor the other way round. A message
  waits for a slot otherwise. `0`: none start, and messages are refused.
- `CHAT_IDLE_MINUTES` (30): a chat's sandbox waits that long after the user's last message
  or the agent's last answer, whichever came later, then stops. The next message starts it
  again, in the same conversation, with the clone's commits and branches but not its
  uncommitted files.
- `CHAT_PERMISSION_TIMEOUT` (10, in minutes, at most 60): a chat's agent that lacks something
  (a host, the engine, a mount) asks its user from the conversation (#479), who approves it once,
  for the chat, or denies it; no answer within that time denies it. It asks only for what your
  grants and the policies allow the repository's chats: the rest is refused at once, the agent
  told that only you widen it, in the grants folder ([security.md](../security/policies.md#chats)).

With Claude Code, a chat's sandbox waits between messages, and each message goes to it.
Codex and the Antigravity CLI take no message while they run: each message of a chat with one
of them is a run of its own, a new sandbox in the same conversation, which stops once it has
answered.

A chat's reset drops its volumes and its conversation, and keeps it; deleting it removes its
volumes and its runs' logs too. A user taken out of `ALLOWED_USERS` or a repository's `users`,
or whose [access](../repo-config/policies.md#access) there no longer gives `runs:start:chat`, can no longer
send a message there, and their chat's sandbox stops; its volumes stay until it
is deleted.
