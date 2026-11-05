// English texts of New request and Analyze runs (NewRequest.tsx, Analyze.tsx): spread into the catalog (en.ts).
export const request = {
  // New request: the dialog, its kinds and what each one does
  "request.title": "New request",
  "request.cancel": "Cancel",
  "request.kind": "Kind",
  "request.repository": "Repository",
  "request.kindIdea": "Idea",
  "request.kindBug": "Bug report",
  "request.kindDiscussion": "Discussion",
  "request.kindAnalyze": "Analyze runs",
  "request.subInbox": "Goes to its repository's inbox, for the inbox run to pick up.",
  "request.subDiscussion": "Starts a discussion in its repository: Deckhand answers there.",
  "request.subAnalyze":
    "A run reads a digest of the runs you pick and replies on a new issue with what would make them faster or more reliable. It changes no code.",

  // New request: why no repository is offered, a sentence per kind
  "request.cantAnalyze": "You can't start an analysis on any of these repositories.",
  "request.cantSendIdeas": "You can't send ideas to any of these repositories.",
  "request.cantSendBugs": "You can't send bug reports to any of these repositories.",
  "request.cantSendDiscussions": "You can't send discussions to any of these repositories.",
  "request.nothingToAnalyze": "No repository has runs to analyze yet.",
  "request.repoNoIdeas": "{repo} has no inbox for ideas.",
  "request.repoNoBugs": "{repo} has no inbox for bug reports.",
  "request.repoNoDiscussions": "{repo} has no inbox for discussions.",
  "request.noIdeas": "No repository has an inbox for ideas.",
  "request.noBugs": "No repository has an inbox for bug reports.",
  "request.noDiscussions": "No repository has an inbox for discussions.",
  "request.loading": "Loading…",
  "request.setUp": "Set one up",

  // Analyze runs: the form
  "request.analysis": "Analysis",
  "request.runsToRead": "Runs to read",
  "request.pickOneOrMore": "Pick 1 run or more.",
  "request.pickUpTo": "Pick from 1 to {max} runs.",
  "request.mostRecent": "The most recent.",
  "request.mostRecentMax": "The most recent, {max} at most.",
  "request.kinds": "Kinds",
  "request.noFinishedRuns": "No finished runs yet.",
  "request.outcomes": "Outcomes",
  "request.outcomeOk": "Success",
  "request.outcomeError": "Error",
  "request.outcomeNeedsInput": "Needs input",
  "request.outcomeInterrupted": "Interrupted",
  "request.outcomeCancelled": "Cancelled",
  "request.warning":
    "This is a large run: it uses the operator's Claude budget, on the model of light runs.",

  // Analyze runs: the footer's action
  "request.analyze": "Analyze",
  "request.analyzeRuns": { one: "Analyze {count} run", other: "Analyze {count} runs" },
  "request.starting": "Starting…",

  // Analyze runs: the preview
  "request.counting": "Counting the runs…",
  "request.matching": {
    one: "{count} run matches, about {tokens} tokens to read.",
    other: "{count} runs match, about {tokens} tokens to read.",
  },
  "request.leftOut": {
    one: "{count} older run left out: over the digest's cap.",
    other: "{count} older runs left out: over the digest's cap.",
  },
  "request.noMatch": "No run matches: pick other kinds or outcomes.",

  // Analyze runs: once started
  "request.started": "Started: {issue}",
  "request.issue": "issue #{number}",
  "request.itsRun": "its run",
  "request.itsRunStatus": "its run ({status})",
} as const;
