// A repository's pull request lifecycle (listener/review-graph.mjs lifecycleGraph()), in
// GET api/repos/<owner>/<repo>/config's `workflow`: its steps and what moves a pull request
// between them, with the repo's `review:` and `conflicts:` settings applied.

export type WorkflowNodeId =
  "ready" | "ci" | "ci-fix" | "review" | "fix" | "merge" | "rebase" | "done";

// on: it runs; off: the settings turn it off (`key` turns it on); refused: a missing grant or
// the policies refused it (`reasons`); depends: allowed on the sample, but a rule may refuse
// another pull request (`reasons`: the files of those rules).
export type WorkflowState = "on" | "off" | "refused" | "depends";

export interface WorkflowReason {
  // What refused it (a grant's problem, a deny rule's message, or which layer allowed nothing).
  message?: string;
  // The layer that said it, when the policies did.
  layer?: "operator" | "repo";
  // For depends: the file and the rule in it that may refuse.
  file?: string;
  rule?: string;
}

export interface WorkflowNode {
  id: WorkflowNodeId;
  // Its place on a fixed grid: the column, left to right, and the row.
  rank: number;
  lane: number;
  state: WorkflowState;
  // The .deckhand.yaml key that turns it on.
  key: string;
  // Its own numbers, null when unset: `rounds`, `minutes`, `severity`, `method`.
  settings: {
    rounds?: number | null;
    minutes?: number | null;
    severity?: string | null;
    method?: string | null;
  };
  // The policies' decision asked before it runs, and the operator's grant it needs.
  decision?: "review" | "fix" | "merge";
  grant?: string;
  reasons: WorkflowReason[];
}

// The conditions that take an edge (listener/review-graph.mjs CONDITIONS).
export type WorkflowCondition =
  | "ready"
  | "passed"
  | "ci-over"
  | "failed"
  | "pushed"
  | "nothing-pushed"
  | "blocking"
  | "clean"
  | "rounds-out"
  | "fixed"
  | "merged"
  | "conflict"
  | "rebased";

export interface WorkflowEdge {
  from: WorkflowNodeId;
  to: WorkflowNodeId;
  when: WorkflowCondition[];
  // A loop going back to an earlier step, drawn as an arc below.
  back: boolean;
}

export interface Workflow {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  // The policies were asked, on a sample pull request (Deckhand's own, CI passed, its review
  // clean): their states say what they said of it.
  sample: boolean;
}
