// The user's actions (listener/permissions.mjs): server-wide ("server:read", "server:sync"),
// and on each repository they see, by its name in lower case. A repo they don't see isn't in
// it: no action there.
export interface Access {
  server: string[];
  repos: Record<string, RepoAccess>;
}

// What the user may do on a repository: `actions`, among "tasks:read", "logs:read",
// "runs:manage" and "repo:config:read"; `starts`, the modes they may start runs in (a mode's
// name, or a prefix ending in `*`: "*" for every mode), unless `startsDenied` covers them.
export interface RepoAccess {
  actions: string[];
  starts: string[];
  startsDenied: string[];
}

// GET api/access, for Settings › Access (server:read only): each of ALLOWED_USERS's actions,
// server-wide and on each repository the App's installations list, with the files that decided
// them (listener/http-state.mjs accessReport()). `error`: why the repositories can't be listed.
export interface AccessReport {
  users: UserAccess[];
  repos: string[];
  error: string | null;
}

export interface UserAccess {
  login: string;
  server: AccessDecision;
  repos: (AccessDecision & { repo: string })[];
}

// One decision (listener/policies.mjs access()): each action pattern allowed ("runs:start:*",
// "*"), with the operator's files whose rule gives it; each deny, with its file and layer (the
// repo's .deckhand/policy/ or the operator's); `error`, why nothing is given (a policy error);
// `outside`, the login isn't in the repo's `users` (.deckhand.yaml), so nothing there.
export interface AccessDecision {
  actions: { action: string; files: string[] }[];
  denied: {
    action: string;
    reason: string | null;
    file: string | null;
    layer: "operator" | "repo";
  }[];
  error: string | null;
  outside: boolean;
}
