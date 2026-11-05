// English texts of the board: its toolbar and drags (Board.tsx, dnd.ts), the graph
// (GraphDrawing.tsx, GraphLegend.tsx, graphModel.ts) and the lanes (Lanes.tsx, lanes.ts): spread
// into the catalog (en.ts).
export const board = {
  // Board.tsx: its toolbar, options and notices.
  "board.startIn": "Start in",
  "board.startInBox": "Start in {select}",
  "board.showClosed": "Show closed",
  "board.showClosedHelp": "Issues closed as completed or not planned, and merged pull requests",
  "board.graph": "Graph",
  "board.lanes": "Lanes",
  "board.view": "Board view",
  "board.options": "Board options",
  "board.canvas": "What waits for what",
  "board.zoomOut": "Zoom out",
  "board.zoomIn": "Zoom in",
  "board.zoomReset": "Back to 100%",
  "board.zoomResetLabel": "Zoom {percent}%: back to 100%",
  "board.percent": "{percent}%",
  "board.fit": "Fit",
  "board.notALink":
    "That isn't a link to one of {repo}'s issues: drag an issue's card from the work queue, or its link.",

  // Board.tsx: what letting a drag go does, said where it would happen. `{ref}` is "#31", or
  // drag.theIssue for a link not read yet; `{node}` the node's "#19".
  "drag.theIssue": "the issue",
  "drag.moveAfter": "Move #{number} after {node} in line",
  "drag.moveBefore": "Move #{number} before {node} in line",
  "drag.leaveLine": "Queue #{number} after {node}: it leaves the line",
  "drag.queueAfter": "Queue {ref} after {node}",
  "drag.layOutAfter": "Lay out {ref} after {node}",
  "drag.removeWait": "Remove {ref}'s wait",
  "drag.startWork": "Start work on {ref}",
  "drag.layOut": "Lay out {ref} and its sub-issues",
  "drag.start": "Start {ref}",
  "drag.startIn": "Start {ref} in {mode}",
  // The same, its open questions answered first.
  "drag.answerQueueAfter": "Answer {ref}, then queue after {node}",
  "drag.answerLayOutAfter": "Answer {ref}, then lay out after {node}",
  "drag.answerStartWork": "Answer {ref}, then start work on it",
  "drag.answerLayOut": "Answer {ref}, then lay it out and its sub-issues",
  "drag.answerStart": "Answer {ref}, then start",
  "drag.answerStartIn": "Answer {ref}, then start in {mode}",

  // graphModel.ts: the legend's tones, and what each means.
  "graph.lookRunning": "Running",
  "graph.lookRunningMeans": "being worked on",
  "graph.lookInput": "Needs you",
  "graph.lookInputMeans": "questions to answer, or a brainstorm's turn",
  "graph.lookReady": "Ready for review",
  "graph.lookReadyMeans": "CI passed, no conflict, review loop clean",
  "graph.lookError": "Error",
  "graph.lookErrorMeans": "failed: what waits for it keeps waiting",
  "graph.lookWaiting": "Waiting",
  "graph.lookWaitingMeans":
    "for a blocker, queued, or nothing started; faded: closed as completed, not merged",
  "graph.lookMerged": "Merged",
  "graph.lookMergedMeans": "its pull request is merged",

  // graphModel.ts: what a node or card says while an action on it is on its way.
  "graph.starting": "Starting…",
  "graph.queueing": "Queueing…",
  "graph.layingOut": "Laying out…",
  "graph.removingWait": "Removing its wait…",
  "graph.backToBacklog": "Back to the backlog…",
  "graph.stopping": "Stopping…",
  "graph.sending": "Sending…",

  // graphModel.ts: a node's state, where the list's word won't do.
  "graph.mergedByDeckhand": "Merged by Deckhand",
  "graph.merged": "Merged",
  "graph.implemented": "Implemented",
  "graph.inputPrReady": "Needs input, PR ready",
  "graph.notPlanned": "Closed, not planned",
  "graph.runDone": "Run done",
  "graph.open": "Open",

  // graphModel.ts ordinal(): a place in the run order, by Intl.PluralRules' ordinal forms.
  "graph.ordinalZero": "{n}th",
  "graph.ordinalOne": "{n}st",
  "graph.ordinalTwo": "{n}nd",
  "graph.ordinalFew": "{n}rd",
  "graph.ordinalMany": "{n}th",
  "graph.ordinalOther": "{n}th",

  // GraphDrawing.tsx: a node, and why there is nothing to draw (the lanes' too).
  "graph.untitled": "{kind} {ref}",
  "graph.nodeTitle": "{title} ({status})",
  "graph.nodeLabel": "{node}: {status}{details}",
  "graph.labelInLine": ", {place} in line",
  "graph.labelQuestions": { one: ", {count} question", other: ", {count} questions" },
  "graph.labelWaits": { one: ", waits for {count} issue", other: ", waits for {count} issues" },
  "graph.placeTitle": "{place} in line to start",
  "graph.issuesOf": "Issues of {repo}",
  "graph.loading": "Loading…",
  "graph.nothingOpen": "Nothing open here. {show}",
  "graph.showClosedIssues": "Show closed issues",
  "graph.empty": "No issues here yet. Drop one here to start it.",

  // GraphLegend.tsx.
  "graph.legend": "Legend",
  "graph.waitsFor": "waits for",
  "graph.waitsForHelp": "It starts once the issue the arrow comes from is done",

  // Lanes.tsx, and lanes.ts's name for a lane nothing names.
  "lanes.andMore": { one: "{first} and {count} more", other: "{first} and {count} more" },
  "lanes.empty": "No issues here yet.",
  "lanes.alone": "On their own",
  "lanes.lane": "Lane {name}",
  "lanes.name": "Lane name",
  "lanes.namePlaceholder": "Empty: its name goes",
  "lanes.rename": "Rename the lane {name}",
  "lanes.saving": "Saving…",
  "lanes.save": "Save",
  "lanes.cancel": "Cancel",
} as const;
