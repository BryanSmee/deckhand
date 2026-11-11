import type { ConfigProblem, ContextRow, Grant, HostRow, MountRow, SettingRow } from "./config";
import type { Workflow } from "./workflow";

// configured: its default branch has .deckhand.yaml; invalid: it has, but no run starts (the
// file has errors, or asks for what the operator's grants refuse); onboarding: its onboarding
// issue is open; unknown: GitHub didn't say.
export type RepoStatus = "configured" | "invalid" | "onboarding" | "not-onboarded" | "unknown";

export interface Repo {
  repo: string;
  url: string;
  private: boolean;
  // false: its issues are disabled, so it can't be onboarded.
  issues: boolean;
  status: RepoStatus;
  issue: { number: number; url: string } | null;
  // When its config was last read from GitHub; null when it couldn't be. Sent, not shown: the
  // config panel says when it read its own.
  readAt: number | null;
  // Its `review.merge` merges Deckhand's pull requests with no human review: on in its config,
  // granted, and allowed for its visibility (listener/grants.mjs autoMergeProblems()).
  autoMerge: boolean;
  // Only with api/repos?backlog=1: a configured repo's open issues with no live task, as its
  // last backlog read had them (listener/work.mjs counts()), and when that read started; null
  // before its first read, or when the signed-in user isn't among its users. Absent on the
  // other rows. `more`: that read was one full page of 100 issues and pull requests, so there
  // may be more than `count` ("100+").
  backlog?: { count: number; more: boolean; readAt: number } | null;
}

// Where the App is managed on GitHub (repos.mjs appLinks()). installUrl: GitHub's page that
// installs it on an account, or configures an installation; settingsUrl: its permissions,
// events and webhook. missingEvents, missingPermissions: what its settings lack of what Deckhand
// asks for (listener/github-app.mjs APP_EVENTS, APP_PERMISSIONS: "actions: read"), as read at
// the listener's start and with each listing of the repositories. installations: each account it is installed on, with that
// installation's own page, where an owner accepts the App's new permissions, and those it has
// yet to accept (`missing`).
export interface AppLinks {
  name: string;
  installUrl: string;
  settingsUrl: string;
  missingEvents: string[];
  missingPermissions: string[];
  installations: { account: string | null; url: string; missing: string[] }[];
}

// GET api/repos, and POST api/repos/refresh (429 when refreshed a moment ago).
export interface Repos {
  repos: Repo[];
  // When the installations' repositories were last listed.
  listedAt: number;
  // Null before the App is set up (the dashboard isn't served then anyway).
  app: AppLinks | null;
}

// POST api/repos/<owner>/<repo>/onboard
export interface Onboarded {
  repo?: Repo;
  opened?: boolean;
  error?: string;
}

// GET api/repos/<owner>/<repo>/config, read from GitHub at each request, and POST
// api/repos/<owner>/<repo>/refresh (the same; 429 when refreshed a moment ago).
export interface RepoConfig {
  repo: Repo;
  base: string;
  // null: no .deckhand.yaml on its default branch, the operator's defaults apply.
  // `url`: the file on GitHub; `editUrl`: GitHub's editor for it.
  file: { text: string; sha: string; url: string; editUrl: string } | null;
  errors: ConfigProblem[];
  warnings: ConfigProblem[];
  // The operator's grants have errors: no run starts here (or anywhere, everyRepo). `file`:
  // the one to fix in the grants folder, when there is one.
  grantsError: { file: string | null; message: string; everyRepo: boolean } | null;
  effective: {
    settings: SettingRow[];
    hosts: HostRow[];
    mounts: MountRow[];
    contextRepos: ContextRow[];
    grant: Grant | null;
  };
  // The policy files that apply, from the operator's grants folder and the repo's
  // .deckhand/policy/ on its default branch (listener/policies.mjs describe()).
  policies: Policies;
  // What each mode's runs get (listener/capabilities.mjs, repos.mjs capabilityView()).
  capabilities: Capabilities;
  // Its pull request lifecycle (listener/review-graph.mjs, repos.mjs workflowView()); absent
  // from listeners before #899.
  workflow?: Workflow;
  readAt: number;
}

// A capability of the catalogue (listener/capabilities.mjs): what it gives, the capabilities it
// needs, the .deckhand.yaml keys that ask for it (none: the policies alone decide), the grant
// that gates it (`docker`…: the operator's `allow_grant` rules) and what enforces it.
export interface CapabilityInfo {
  name: string;
  what: string;
  needs: string[];
  config: string[];
  grant: string | null;
  enforcedBy: string;
}

// What a mode's runs get of a capability: used, or why not: a deny rule ("denied", `reason` its
// messages), no allow rule of a layer that must give it ("not-allowed"), the config doesn't ask
// for it ("not-asked"), the operator's grant doesn't give it ("not-granted"). `files`: the
// policy files that decided, the allow rules that gave it or the deny rules that refused it.
export interface CapabilityRow {
  name: string;
  status: "used" | "denied" | "not-allowed" | "not-asked" | "not-granted";
  used: boolean;
  // `file` null: a rule Deckhand couldn't place in a file (indented, say), which counts all the same.
  files: { layer: "operator" | "repo"; file: string | null }[];
  reason: string | null;
}

// A mode's runs, as one started by a comment on an issue, not a fork's: each capability, those
// used, what stops them (`errors`: a broken dependency, a risky combination, a grant missing)
// and the warnings. `custom`: one of the repo's own `modes:`.
export interface ModeCapabilities {
  mode: string;
  custom: boolean;
  capabilities: CapabilityRow[];
  used: string[];
  errors: string[];
  warnings: string[];
}

// `error`: the policies couldn't be evaluated ("policy error: …"): no run starts, `modes` empty.
export interface Capabilities {
  catalogue: CapabilityInfo[];
  modes: ModeCapabilities[];
  error: string | null;
}

// A policy file: Deckhand's own defaults ("deckhand", in its image) and the operator's, one
// layer where the operator's file replaces Deckhand's of its name, or the repo's, a layer of its
// own that replaces nothing. `replaces`: "deckhand" for an operator's file that replaces one,
// null for none. The replaced file is listed too, not `active`: no decision evaluates it.
// `rules`: the `allow_*` and `deny_*` rules it defines. `url`: the repo's file on GitHub. `text`:
// its source, redacted, cut at 20 KB (`truncated`); sent by the config endpoint only, never in
// api/state.
export interface PolicyFile {
  name: string;
  source: "deckhand" | "operator" | "repo";
  replaces: "deckhand" | null;
  active: boolean;
  rules: string[];
  url: string | null;
  text: string;
  truncated: boolean;
}

// An error of the config check: `layer`, the one whose check said it (null: none, a folder that
// can't be read), `file` and `row` where opa placed it (both null when it didn't: a timeout, a
// folder that can't be read). `text`: the whole error on one line.
export interface PolicyError {
  layer?: "operator" | "repo" | null;
  // A repo's allow rule for a decision none of its modes makes: an error of its config check,
  // which refuses nothing, being ignored.
  ignored?: boolean;
  file: string | null;
  row: number | null;
  message: string;
  text: string;
}

// `errors`: the config check's (compile errors, a folder that can't be read): every decision a
// policy is asked for refuses until they are fixed, but a repo's ignored allow rule (`ignored`),
// which refuses nothing. `warnings`: rules nobody evaluates, a repo file named as one it no
// longer replaces.
export interface Policies {
  files: PolicyFile[];
  errors: PolicyError[];
  warnings: string[];
}
