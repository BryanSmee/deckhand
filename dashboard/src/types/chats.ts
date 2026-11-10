import type { Run } from "./state";

// GET and POST api/chats/<id>/permissions (listener/chats.mjs, listener/profiles.mjs): a chat's
// permissions profile, what it may hold (its `ceiling`: what a chat run of its repository gets
// from the policies, the config and the operator's grant) and what its next run gets of it
// (`effective`). A profile's null field means everything the ceiling allows. `errors`: what
// would stop its next run whatever the profile; `running`: a sandbox is going, which keeps the
// permissions it started with. A POST beyond the ceiling answers 422 with `errors`, one per
// refusal.
export type GithubLevel = "read" | "comment" | "push";

export interface ProfileMount {
  target: string;
  readOnly: boolean;
}

export interface ChatProfile {
  github: GithubLevel;
  capabilities: string[] | null;
  hosts: string[] | null;
  mounts: ProfileMount[] | null;
}

export interface ChatCeiling {
  capabilities: {
    name: string;
    what: string;
    needs: string[];
    allowed: boolean;
    // On whatever the profile says: `reason` says why.
    required: boolean;
    reason: string | null;
  }[];
  hosts: string[];
  mounts: { target: string; writable: boolean; reason: string | null }[];
  github: { level: GithubLevel; allowed: boolean; reason: string | null }[];
}

export interface ChatPermissions {
  profile: ChatProfile;
  ceiling: ChatCeiling;
  effective: {
    github: GithubLevel;
    capabilities: string[];
    hosts: string[];
    mounts: ProfileMount[];
  };
  errors: string[];
  running: boolean;
}

// A chat's agent's request for more permissions, waiting for its owner (listener/requests.mjs,
// #479): `what` names it ("a container engine", "registry.npmjs.org"); `reason` is the agent's,
// one line, cut and redacted, shown as text; `live`: an approval applies to the sandbox going
// (a host), else at its next start; denied at `expiresAt` without an answer.
export type PermissionKind = "host" | "github" | "engine" | "mount";
export type PermissionAnswer = "once" | "chat" | "deny";

export interface PermissionRequest {
  id: string;
  kind: PermissionKind;
  what: string;
  reason: string;
  live: boolean;
  state: "pending" | "granted" | "denied" | "refused";
  message: string | null;
  at: number;
  expiresAt: number;
}

// A user's chat with the agent on one of the repositories (listener/chats.mjs view()), its
// owner's alone. `status`: "running" while its agent works on a message (or its sandbox starts,
// or a message waits for a slot: `queued`), "idle" while its sandbox waits for the next one,
// "stopped" without a sandbox. `reachable`: false once its owner may no longer run the agent
// there (ALLOWED_USERS, the repo's `users`, the access decision): no runs then, Delete only.
export type ChatStatus = "running" | "idle" | "stopped";

export interface Chat {
  id: string;
  owner: string;
  repo: string;
  base: string;
  // As created; null: the repository's.
  agent: string | null;
  model: string | null;
  effort: string | null;
  // Its first message's first line; null before one.
  title: string | null;
  createdAt: number;
  lastActiveAt: number;
  resetAt: number | null;
  status: ChatStatus;
  queued: boolean;
  reachable: boolean;
  // Its messages not delivered yet: shown until a run's log has them.
  pending: { text: string; queuedAt: number }[];
  // Its agent's requests for more permissions, waiting for an answer, oldest first.
  requests: PermissionRequest[];
  // Its runs, newest first: their logs are the conversation.
  runs: Run[];
}

// GET api/chats: the user's chats, most recently active first; how many they may keep
// (CHATS_PER_USER: a repository's `chats.per_user` may lower it there); the repositories New
// chat offers, the agents the operator configured ("claude@anthropic", with its label), the
// models' tiers ("best", "balanced", "fast") and the efforts.
export interface Chats {
  chats: Chat[];
  limit: number;
  repos: string[];
  agents: { name: string; label: string }[];
  models: string[];
  efforts: string[];
}
