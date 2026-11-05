// English texts of Inbox, the task list and Sync (Inbox.tsx, TaskList.tsx, Sync.tsx): spread into the catalog (en.ts).
export const inbox = {
  // New request's idea, bug report or discussion form
  "inbox.sendIdea": "Send idea",
  "inbox.ideaTitle": "What you'd like, in a line",
  "inbox.ideaDetails": "What you'd like, and why. Markdown works.",
  "inbox.sendBug": "Send bug report",
  "inbox.bugTitle": "What goes wrong, in a line",
  "inbox.bugDetails": "What goes wrong, and how to see it. Markdown works.",
  "inbox.startDiscussion": "Start discussion",
  "inbox.discussionTitle": "The discussion's title",
  "inbox.discussionDetails": "What you'd like to talk over. Markdown works.",
  "inbox.starting": "Starting…",
  "inbox.sending": "Sending…",
  "inbox.title": "Title",
  "inbox.details": "Details",
  "inbox.detailsOptional": "Details {optional}",
  "inbox.optional": "· optional",
  "inbox.discussionHelp": "Deckhand answers in the discussion.",
  "inbox.entryHelp":
    "The inbox run turns this into a ready-to-start issue, or asks you first. End a line with /effort high, /model or /agent to pick them for its run.",

  // Once sent: the comment's or discussion's link, then its task's
  "inbox.sent": "Sent: {what}",
  "inbox.sentWithTask": "Sent: {what} · {task}",
  "inbox.theComment": "the comment",
  "inbox.theDiscussion": "the discussion",
  "inbox.itsThread": "its thread",
  "inbox.itsRun": "its run ({status})",
  "inbox.inboxTask": "the inbox's task",

  // The task list
  "taskList.search": "Search tasks",
  "taskList.state": "State",
  "taskList.filter": "Filter: {name}",
  "taskList.loading": "Loading…",
  "taskList.noRuns": "No runs yet",
  "taskList.noMatch": "No task matches “{query}”",
  "taskList.noneInState": "Nothing in this state",

  // The task list's chips (format.ts CHIPS)
  "chips.all": "All",
  "chips.running": "Running",
  "chips.input": "Needs you",
  "chips.review": "Ready",
  "chips.done": "Done",
  "chips.error": "Error",

  // Sync with GitHub
  "sync.upToDate": "Up to date with GitHub",
  "sync.synced": "Synced: {done}",
  "sync.redelivered": {
    one: "{count} missed delivery asked again",
    other: "{count} missed deliveries asked again",
  },
  "sync.pulls": { one: "{count} pull request updated", other: "{count} pull requests updated" },
  "sync.conflicts": { one: "{count} rebase run started", other: "{count} rebase runs started" },
  "sync.failed": "Couldn't sync ({error})",
} as const;
