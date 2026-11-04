// Who may do what where (#731): the access decision (policies.mjs access(), #730) as every check
// asks it, the dashboard's routes and what they list, comments, auto-pickup, discussions and
// requested reviewers. A repository's `users` (as last read: repo-settings.mjs usersOf()) still
// narrows it: a login outside them has no action there. A repository with no action for a login
// is hidden from it everywhere, its routes answering 404 as one outside ALLOWED_REPOS. A policy
// error, or a policy service away, gives no action (fail closed), never what was said before:
// policies.mjs keeps no failure.
import { actionMatches, allows } from "./policies.mjs";

// The actions on a repository, one each, that anyAction() probes; `runs:start:*` stands for
// "some mode", each mode a rule names being probed too.
const PROBES = ["tasks:read", "logs:read", "runs:manage", "repo:config:read", "runs:start:*"];

// Whether access()'s `answer` gives any action on a repository: an action a pattern allows that
// no deny covers. `runs:start:*` with `runs:start:work` denied still gives the other modes; a
// deny of `runs:start:*` (or `runs:*`, `*`) takes them all.
export function anyAction(answer) {
  if (!answer || answer.error) return false;
  const free = (action) => !answer.denied.some((d) => actionMatches(d.action, action));
  const named = answer.actions.filter((p) => typeof p === "string" && p.startsWith("runs:start:"));
  return [...PROBES, ...named].some(
    (probe) => answer.actions.some((p) => actionMatches(p, probe)) && free(probe),
  );
}

// The action a run in `mode` needs from whoever starts it.
export const startAction = (mode) => `runs:start:${mode}`;

// `policies`: policies.mjs createPolicies()'s (access()); none (some tests): every action, as
// run-policy.mjs asks nothing without them. `usersOf(repo)`: the repository's `users` as last
// read, or null when not known (ALLOWED_USERS alone then).
export function createPermissions({ policies = null, usersOf = () => null }) {
  // Outside the repository's `users`, as last read: nothing there.
  const outside = (login, repo) => {
    const users = usersOf(repo);
    return !!users && !users.includes(login.toLowerCase());
  };

  // access()'s answer for `login` on `repo` (null: server-wide), or null for none at all.
  async function answerOf(login, repo) {
    if (typeof login !== "string" || !login) return null;
    if (repo != null && outside(login, repo)) return null;
    if (!policies) return { actions: ["*"], denied: [], files: {}, error: null };
    // access() says its own failures; one it didn't foresee gives nothing too.
    return policies.access(login, repo).catch(() => null);
  }

  // Whether `login` may do `action` on `repo`, or server-wide when `repo` is null.
  async function can(login, repo, action) {
    return allows(await answerOf(login, repo), action, repo != null);
  }

  // Whether `login` sees `repo` at all: some action there.
  async function visible(login, repo) {
    if (repo == null) return false;
    return anyAction(await answerOf(login, repo));
  }

  // The repositories among `repos` (names) where `login` may do `action` (null: visible()), by
  // their names in lower case: one decision each, asked together, for a filter that can't wait
  // (http.mjs state()).
  async function which(login, repos, action = null) {
    const names = new Map();
    for (const repo of repos) if (repo) names.set(repo.toLowerCase(), repo);
    const said = await Promise.all(
      [...names].map(async ([key, repo]) => {
        const ok = action ? await can(login, repo, action) : await visible(login, repo);
        return ok && key;
      }),
    );
    return new Set(said.filter(Boolean));
  }

  return { answerOf, can, visible, which };
}
