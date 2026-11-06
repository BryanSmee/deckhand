// English texts of a task's Review tab (ReviewTab.tsx): the last review's head, its sections and
// the follow-ups' filing. Spread into the English catalog (en.ts).
export const review = {
  "reviewTab.missing":
    "No review of Deckhand's to show here: GitHub refused the last one, posted as a comment on the pull request instead, or it isn't in Deckhand's format.",
  "reviewTab.readFailed": "Couldn't read the last review: {error}",
  "reviewTab.readAgainFailed": "Couldn't read it again: {error}",
  "reviewTab.tryAgain": "Try again",
  "reviewTab.reading": "Reading the last review",
  // The merge's banner: "Merged #30 by Deckhand today 14:02".
  "reviewTab.merged": "Merged #{number}",
  "reviewTab.mergedBy": "Merged #{number} by {who}",
  "reviewTab.mergedAt": "{merged} {when}",

  // Its head: "Requests changes · R2 · 6/10 · reviewed abc1234 · today 14:02 · On GitHub ↗".
  "reviewTab.requestChanges": "Requests changes",
  "reviewTab.comment": "Comment",
  "reviewTab.approve": "Approve",
  "reviewTab.maintainer": "A maintainer's review",
  "reviewTab.afterRound": "Review after fix round {round}",
  "reviewTab.first": "First review",
  "reviewTab.round": "R{round}",
  "reviewTab.rating": "{rating}/10",
  "reviewTab.reviewed": "reviewed {sha}",
  "reviewTab.outdated": "Outdated: head is now {head}",
  "reviewTab.github": "On GitHub",

  // Must fix, by severity.
  "reviewTab.mustFix": "Must fix",
  "reviewTab.nothingToFix": "Nothing to fix.",
  "reviewTab.critical": "Critical",
  "reviewTab.high": "High",
  "reviewTab.medium": "Medium",
  "reviewTab.low": "Low",
  "reviewTab.mergedWith": "merged with",
  "reviewTab.tolerated": "tolerated",
  "reviewTab.toleratedHelp": "The repo's review.max_allowed_severity is {severity}",
  "reviewTab.toFix": "to fix",

  // Follow-ups, and why one has no issue yet.
  "reviewTab.followUps": "Follow-ups",
  "reviewTab.followUpsMerged": "For other issues: Deckhand files each one now that it is merged.",
  "reviewTab.followUpsOpen": "For other issues: Deckhand files each one once it is merged.",
  "reviewTab.issueOpen": "open",
  "reviewTab.issueClosed": "closed",
  "reviewTab.filingAfterMerge": "filed after merge",
  "reviewTab.filingFailed": "filing failed: GitHub refused the issue",
  "reviewTab.filingLeft": "not filed: past the follow-ups Deckhand files per pull request",
  "reviewTab.filingOff": "not filed: left to you (review.follow_ups: false)",
  "reviewTab.filingUnread": "not known: the repo's config can't be read",
  "reviewTab.filingNotFiled": "not filed: nothing filed it at the merge",
  "reviewTab.filingUnknown": "filed before Deckhand kept which issue",

  // Comments, blocking or not.
  "reviewTab.comments": "Comments",
  "reviewTab.blocking": "blocking",
  "reviewTab.note": "note",
} as const;
