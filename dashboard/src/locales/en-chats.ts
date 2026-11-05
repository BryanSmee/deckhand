// English texts of Chats (Chats.tsx, Conversation.tsx, ChatPermissions.tsx, PermissionCard.tsx, chatModel.ts): spread into the catalog (en.ts).
export const chats = {
  // The page and its list
  "chats.yours": "Your chats",
  "chats.kept": "{kept} of {limit}",
  "chats.keptTitle": "The chats you keep, of the most you may",
  "chats.newChat": "New chat",
  "chats.loading": "Loading…",
  "chats.noneAllowed": "No chats here: CHATS_PER_USER is 0.",
  "chats.atLimit":
    "You keep {kept} of {limit} chats, the most you may: delete one to start another.",
  "chats.noRepository": "No repository lets you start a chat.",
  "chats.cantRead": "Can't read your chats ({error})",
  "chats.noneOn": "No chats on {repo} yet.",
  "chats.none": "No chats yet.",
  "chats.noSuchChatOn": "No such chat on {repo}: it was deleted, or it isn't yours.",
  "chats.noSuchChat": "No such chat: it was deleted, or it isn't yours.",
  "chats.pick": "Pick a chat, or start a new one.",
  "chats.intro":
    "Start a chat to ask the agent about a repository, or to try things in a sandbox of its own. It can read the repository's issues and pull requests, but writes nothing on GitHub.",

  // The open chat's header and menu
  "chats.back": "Back to your chats",
  "chats.effort": "{effort} effort",
  "chats.close": "Close",
  "chats.menu": "Chat menu",
  "chats.permissionsItem": "Permissions…",
  "chats.resetItem": "Reset…",
  "chats.deleteItem": "Delete…",

  // Reset and Delete, asked first
  "chats.resetTitle": "Reset this chat?",
  "chats.resetSub":
    "Its sandbox stops, and its clone of the repository and the agent's session are dropped: what the agent changed there and what it remembers of this conversation are lost. The chat stays, and your next message starts from a fresh clone.",
  "chats.resetAction": "Reset the chat",
  "chats.resetting": "Resetting…",
  "chats.deleteTitle": "Delete this chat?",
  "chats.deleteSub":
    "Its sandbox stops, and the chat goes with its clone of the repository, the agent's session and the whole conversation. This can't be undone.",
  "chats.deleteAction": "Delete the chat",
  "chats.deleting": "Deleting…",
  "chats.cancel": "Cancel",

  // New chat
  "chats.newSub":
    "A sandbox of its own on the repository, read-only on GitHub. It stops after a while without a message, and starts again with the next one.",
  "chats.starting": "Starting…",
  "chats.start": "Start the chat",
  "chats.repository": "Repository",
  "chats.agent": "Agent",
  "chats.model": "Model",
  "chats.effortLabel": "Effort",
  "chats.repositoryDefault": "The repository's",
  "chats.firstMessage": "First message",
  "chats.firstMessageHelp": "Optional: it starts the sandbox. Ctrl Enter starts the chat.",

  // The chat's state (chatModel.ts)
  "chats.stateStarting": "Starting",
  "chats.stateResuming": "Resuming",
  "chats.stateWaiting": "Waiting for a slot",
  "chats.stateWorking": "Running",
  "chats.stateIdle": "Idle",
  "chats.stateStopped": "Stopped",
  "chats.noteStarting": "Its sandbox starts: a clone of the repository.",
  "chats.noteResuming": "Its sandbox starts again, in the same session.",
  "chats.noteWaiting": "Other chats' sandboxes take every slot: it starts when one is free.",
  "chats.noteWorking": "The agent is on it.",
  "chats.noteIdle": "Its sandbox waits for your next message.",
  "chats.noteStopped":
    "No sandbox now: your next message starts it again, where the chat left off.",
  "chats.noteFresh":
    "No sandbox now: your next message starts it, from a fresh clone of the repository.",
  "chats.noteRequests": {
    one: "The agent waits for your answer to its request above.",
    other: "The agent waits for your answer to its requests above.",
  },
  "chats.agentFailed": "The agent failed.",

  // The conversation
  "chats.conversation": "Conversation",
  "chats.showEarlier": {
    one: "Show earlier ({count} more sandbox run)",
    other: "Show earlier ({count} more sandbox runs)",
  },
  "chats.empty": "Ask anything about {repo}: your first message starts its sandbox.",
  "chats.unreachable":
    "You can no longer run the agent on this repository: you can only delete this chat.",
  "chats.notSent": "Not sent: {error}",
  "chats.message": "Message",
  "chats.messagePlaceholder": "Message the agent",
  "chats.noMessages": "This chat takes no messages",
  "chats.send": "Send",
  "chats.sendTitle": "Send (Enter; Shift Enter adds a line)",
  "chats.sandboxStarted": "Sandbox started {when}",
  "chats.sandboxResumed": "Sandbox resumed {when}",
  "chats.chatReset":
    "Chat reset {when}: a fresh clone and session, the agent remembers nothing above",
  "chats.sending": "Sending…",
  "chats.queued": "Queued: the agent gets it once its sandbox is ready",
  "chats.sent": "Sent",
  "chats.toolCalls": { one: "{count} tool call", other: "{count} tool calls" },
  "chats.lines": { one: "{count} line", other: "{count} lines" },
  "chats.phaseNow": "{phase}…",

  // The agent's requests for more permissions (PermissionCard.tsx)
  "chats.asksHost": "The agent asks for a host",
  "chats.asksGithub": "The agent asks for GitHub access",
  "chats.asksEngine": "The agent asks for a container engine",
  "chats.asksMount": "The agent asks for a host mount",
  "chats.asksWhat": "{asks}: {what}",
  "chats.appliesNow": "Applies to its sandbox at once.",
  "chats.appliesLater":
    "Applies when its sandbox starts again: Restart now, in the chat's permissions, once the agent has answered.",
  "chats.deniedIn": {
    one: "Denied in {count} minute without an answer.",
    other: "Denied in {count} minutes without an answer.",
  },
  "chats.approveOnce": "Approve once",
  "chats.approveChat": "Approve for this chat",
  "chats.deny": "Deny",

  // The chat's permissions (ChatPermissions.tsx)
  "chats.permissions": "Permissions",
  "chats.permissionsLoading": "Loading the permissions…",
  "chats.permissionsNote":
    "What this chat's sandbox may do, within what the operator's grants and the repository's policies give a chat. Enforced in the sandbox; changes apply at its next start.",
  "chats.permissionsDocs": "How chats are kept in",
  "chats.wouldntStart": "This chat's next run wouldn't start, whatever its permissions:",
  "chats.github": "GitHub",
  "chats.levelRead": "Read only",
  "chats.levelComment": "Comment on issues",
  "chats.levelPush": "Push its own branch and open a draft pull request",
  "chats.capabilities": "Capabilities",
  "chats.capPull": "The repository's code",
  "chats.capSetup": "Setup command",
  "chats.capImageRepo": "The repository's image",
  "chats.capImageBranch": "A pull request's image",
  "chats.capDocker": "Container engine",
  "chats.capInternet": "The open internet",
  "chats.capReadIssues": "Read issues",
  "chats.capReadPulls": "Read pull requests",
  "chats.capReadDiscussions": "Read discussions",
  "chats.capReadActions": "Read CI results",
  "chats.network": "Network",
  "chats.noHosts": "The operator grants this repository no hosts beyond those every run needs.",
  "chats.internetOn": "With the open internet on, the sandbox reaches any public host.",
  "chats.hostsNeeded":
    "The hosts every run needs (the agent's API, GitHub) stay reachable. A host the grants don't list can't be added here.",
  "chats.mounts": "Mounts",
  "chats.readWrite": "Read-write as granted",
  "chats.readOnly": "Read-only: {reason}",
  "chats.notSaved": "Not saved: this goes beyond what the chat may get.",
  "chats.savedRunning":
    "Saved. The sandbox going keeps the permissions it started with: restart it to use these.",
  "chats.savedNext": "Saved. The next message starts the sandbox with these permissions.",
  "chats.restarting": "Restarting…",
  "chats.restartNow": "Restart now",
  "chats.saving": "Saving…",
  "chats.save": "Save",
} as const;
