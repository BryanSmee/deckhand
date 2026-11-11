// What the signed-in user may do (api/state's `access`, #732), for the controls to show only
// what the orchestrator wouldn't refuse: useCan() in any component, from the Provider App puts
// around the page. Each control's action is the one its route needs (listener/work.mjs,
// repos.mjs, discussions.mjs, http.mjs).
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Access, RepoAccess } from "./types";

export interface Can {
  // An action on `repo`: "tasks:read", "logs:read", "runs:manage", "repo:config:read",
  // "repo:config:write".
  repo: (repo: string | null | undefined, action: RepoAction) => boolean;
  // A run started in `mode` on `repo` (`runs:start:<mode>`).
  start: (repo: string | null | undefined, mode: string) => boolean;
  // A server-wide action: "server:read", "server:sync".
  server: (action: ServerAction) => boolean;
  // A run started in `mode` on some repository: New request's kinds.
  anywhere: (mode: string) => boolean;
}

export type RepoAction =
  | "tasks:read"
  | "logs:read"
  | "runs:manage"
  | "repo:config:read"
  | "repo:config:write";
export type ServerAction = "server:read" | "server:sync";

// A mode's pattern (a name, or a prefix ending in `*`) covering `mode`.
const covers = (pattern: string, mode: string) =>
  pattern.endsWith("*") ? mode.startsWith(pattern.slice(0, -1)) : pattern === mode;

// Everything: a listener from before access sends none, and the specs that aren't about it.
export const EVERYTHING: Can = {
  repo: () => true,
  start: () => true,
  server: () => true,
  anywhere: () => true,
};

// `access` as Can's: a repository it doesn't name has no action (fail closed).
export function canFrom(access: Access | undefined): Can {
  if (!access) return EVERYTHING;
  const of = (repo: string | null | undefined) => (repo ? access.repos[repo.toLowerCase()] : null);
  const starts = (mine: RepoAccess | null | undefined, mode: string) =>
    !!mine &&
    mine.starts.some((p) => covers(p, mode)) &&
    !mine.startsDenied.some((p) => covers(p, mode));
  return {
    repo: (repo, action) => !!of(repo)?.actions.includes(action),
    start: (repo, mode) => starts(of(repo), mode),
    server: (action) => access.server.includes(action),
    anywhere: (mode) => Object.values(access.repos).some((mine) => starts(mine, mode)),
  };
}

export const AccessContext = createContext<Can>(EVERYTHING);

export const useCan = () => useContext(AccessContext);
