// The repository config page's rows (GET api/repos/<owner>/<repo>/config's `effective` and its
// file's problems: listener/repo-view.mjs, repos.mjs).

// Where a value comes from: the repo's .deckhand.yaml, the operator (environment, grants
// folder), or the repo's, refused (a refused host or mount stops every run), or unknown (it
// needs a grant, and the operator's grants have errors: not judged until they're fixed).
export type Source = "repo" | "operator" | "refused" | "unknown";

// One setting a run reads (listener/repo-view.mjs settingRows()); `key` is its YAML key.
// Refused: it needs a grant the operator doesn't give (dockerfile, docker).
// `line`: where .deckhand.yaml sets it (null: it doesn't).
export interface SettingRow {
  key: string;
  value: string;
  source: Source;
  note: string | null;
  line: number | null;
}

export interface HostRow {
  host: string;
  // Only the operator's grants folder lists hosts.
  source: "operator";
  // Where it comes from: "always", or its grants file ("grants/default.yaml").
  note: string | null;
}

// A mount the repo asks for, at `path` in the sandbox.
export interface MountRow {
  path: string;
  source: Exclude<Source, "operator">;
  readOnly: boolean;
  note: string | null;
  line: number | null;
}

// A repository the repo's runs read (`context_repos`), at `ref` (null: its default branch), in
// `folder` of the sandbox. Granted ("repo"): `pattern`, the operator's that grants it; refused:
// it stops every run, `note` says why; unknown: the operator's grants have errors.
export interface ContextRow {
  repo: string;
  ref: string | null;
  folder: string;
  pattern: string | null;
  source: Exclude<Source, "operator">;
  note: string | null;
  line: number | null;
}

// What the operator grants the repo, and the files of its grants folder it comes from
// (default.yaml, <owner>/<repo>.yaml); none: nothing beyond what every repository gets. The
// yes-or-no grants below are the operator's policies' (#498): `allow_grant` rules of its
// policy files (`grantFiles`: those that have one; none: nothing granted), each named as the
// rules name it (listener/grants.mjs GRANTS).
export interface Grant {
  files: string[];
  grantFiles: string[];
  allowDockerfile: boolean;
  allowBranchDockerImages: boolean;
  allowDocker: boolean;
  // `/mode research`: the open internet, without the repository's code or a token.
  allowResearch: boolean;
  // Pushes that change .github/workflows/ (the git gateway's token gets `workflows: write`).
  allowWorkflows: boolean;
  // With it, workflows that only run from the default branch may use secrets (`workflow_secrets`).
  allowWorkflowSecrets: boolean;
  // `review.merge` may merge Deckhand's pull requests (`auto_merge`); "public": on a public
  // repository too (`auto_merge_public`).
  allowAutoMerge: boolean | "public";
  // Its tasks may run on its users' own machines, with its `machines:` (`machines`).
  allowMachines: boolean;
  hosts: string[];
  // Those whose plain HTTP answers the egress proxy keeps in its cache.
  cachedHosts: string[];
  // The patterns of the repositories it may read (`context_repos`: "acme/templates-*").
  contextRepos: string[];
  mounts: { root: string; readOnly: boolean }[];
  // The organization projects (v2) its runs add items to and the listener moves its issues on
  // ("acme/3"): `allow_projects`.
  allowProjects: string[];
  limits: { cpus: string; memory: string; pids: number };
}

// One of a .deckhand.yaml's errors or warnings (repo-config.mjs fileLines()): the key it is
// about ("modes.review.agent"), and the line of that key, or of the syntax error; null when
// the check doesn't know them. `fix`: how to fix an error (null for a warning).
export interface ConfigProblem {
  key: string | null;
  message: string;
  line: number | null;
  fix: string | null;
}
