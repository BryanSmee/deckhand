// Who may do what where (#731): the access decision (policies.mjs access(), #730) as every check
// asks it, the dashboard's routes and what they list, comments, auto-pickup, discussions and
// requested reviewers. A repository's `users` (as last read: repo-settings.mjs usersOf()) still
// narrows it: a login outside them has no action there. A repository with no action for a login
// is hidden from it everywhere, its routes answering 404 as one outside ALLOWED_REPOS. A policy
// error, or a policy service away, gives no action (fail closed), never what was said before:
// policies.mjs keeps no failure.
import { taskKey } from "./events.mjs";
import { actionMatches, allows, SERVER_ACTIONS } from "./policies.mjs";

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

// decide()'s refusal as a log line says it: no `action` (null: no action at all) for `login`, or
// a decision that failed, which refuses as much (fail closed) but is no one's refusal.
export function refusal(said, login, action) {
  if (said.error) return `${login}'s ${action ?? "access"} can't be decided (${said.error})`;
  return `${login} has no ${action ?? "action"} here`;
}

// Whether a comment's (`item`'s) author may do `action` (null: anything) on its repo, `log`
// saying why not after `what`: refused, or not decided, which refuses as much. Either way
// nothing is said on GitHub. No `permissions`: every action, as without policies.
export async function itemMay(permissions, log, item, action, what = "") {
  if (!permissions) return true;
  const said = await permissions.decide(item.author, item.repo, action);
  if (!said.ok) {
    log(`${taskKey(item.repo, item.id)}: ${what}${refusal(said, item.author, action)}`);
  }
  return said.ok;
}

// The action a run in `mode` needs from whoever starts it.
export const startAction = (mode) => `runs:start:${mode}`;

// The actions on a repository the dashboard has controls for (#732), besides the starts.
const SHOWN_ACTIONS = ["tasks:read", "logs:read", "runs:manage", "repo:config:read"];
const START = startAction("");

// What an action's pattern, given or denied, says of the modes a run may start in: a mode's
// name, a prefix ending in `*` ("*": every mode), or null for none (`tasks:read`, `server:*`).
// `runs:*` and `*` cover every mode; `runs:start:re*` the modes starting with "re".
export function modePattern(pattern) {
  if (typeof pattern !== "string") return null;
  if (!pattern.endsWith("*")) return pattern.startsWith(START) ? pattern.slice(START.length) : null;
  const prefix = pattern.slice(0, -1);
  if (START.startsWith(prefix)) return "*";
  return prefix.startsWith(START) ? `${prefix.slice(START.length)}*` : null;
}

// access()'s answer on a repository as the dashboard reads it (api/state's `access.repos`):
// `actions`, those of SHOWN_ACTIONS it gives; `starts`, the modes it may start runs in
// (modePattern()'s), unless `startsDenied` covers them, as allows() decides a mode's start.
// No answer (outside the repo's `users`), or one that failed: nothing.
export function repoActions(answer) {
  if (!answer || answer.error) return { actions: [], starts: [], startsDenied: [] };
  const modes = (patterns) => [...new Set(patterns.map(modePattern).filter((m) => m !== null))];
  return {
    actions: SHOWN_ACTIONS.filter((a) => allows(answer, a, true)),
    starts: modes(answer.actions),
    startsDenied: modes(answer.denied.map((d) => d.action)),
  };
}

// The server-wide actions access()'s server-wide `answer` gives (api/state's `access.server`).
export const serverActions = (answer) => SERVER_ACTIONS.filter((a) => allows(answer, a, false));

// access()'s answer as Settings › Access shows it (api/access): each action allowed, with the
// operator's files whose rule gives it, and each deny, with its file and layer (its reason too:
// the page is the operator's, server:read). `outside`: not in the repo's `users`, so nothing.
function reported(answer, outside = false) {
  if (outside) return { actions: [], denied: [], error: null, outside: true };
  if (!answer) return { actions: [], denied: [], error: "no answer", outside: false };
  return {
    actions: answer.actions.map((action) => ({ action, files: [...(answer.files[action] ?? [])] })),
    denied: answer.denied.map(({ action, reason = null, file = null, layer }) => ({
      action,
      reason,
      file,
      layer,
    })),
    error: answer.error ?? null,
    outside: false,
  };
}

// `policies`: policies.mjs createPolicies()'s (access()); none (some tests): every action, as
// run-policy.mjs asks nothing without them. `usersOf(repo)`: the repository's `users` as last
// read, or null when not known (ALLOWED_USERS alone then). `infoOf(repo)`: what GitHub said of
// the repository when it was last listed (repos.mjs infoOf(): its name, visibility and default
// branch), or null: the filters over many repositories (which(), dashboard()) give it to
// access() rather than the name, which would read each from GitHub (#783).
export function createPermissions({ policies = null, usersOf = () => null, infoOf = () => null }) {
  // Outside the repository's `users`, as last read: nothing there.
  const outside = (login, repo) => {
    const users = usersOf(repo);
    return !!users && !users.includes(login.toLowerCase());
  };

  // access()'s answer for `login` on `repo` (null: server-wide), or null for none at all.
  // `listed`: access() is given the repository as last listed (infoOf()) when it was, its name
  // otherwise. Only for the filters: a single decision reads it (kept ACCESS_MS), fresher than
  // a listing (LIST_MS).
  async function answerOf(login, repo, listed = false) {
    if (typeof login !== "string" || !login) return null;
    if (repo != null && outside(login, repo)) return null;
    if (!policies) return { actions: ["*"], denied: [], files: {}, error: null };
    // A repo renamed since its listing isn't listed under the name asked: read by it. One still
    // listed under an old name keeps what access() kept under it (a push's forget() goes by the
    // current one) until the next listing, as what the dashboard shows of it.
    const asked = (listed && repo != null && infoOf(repo)) || repo;
    // access() says its own failures; one it didn't foresee gives nothing too.
    return policies.access(login, asked).catch(() => null);
  }

  // Whether `login` may do `action` on `repo`, or server-wide when `repo` is null.
  async function can(login, repo, action, listed = false) {
    return allows(await answerOf(login, repo, listed), action, repo != null);
  }

  // can()'s answer, telling a refusal from a decision that failed: { ok, error }, `error` why
  // nothing could be decided (a policy error, a policy service away), for a caller that keeps a
  // refusal (auto-pickup.mjs) and must not keep a failure, or says which it was (refusal()).
  // `action` null: visible()'s question, some action on `repo`.
  async function decide(login, repo, action) {
    if (typeof login !== "string" || !login) return { ok: false, error: null };
    if (repo != null && outside(login, repo)) return { ok: false, error: null };
    if (!policies) return { ok: true, error: null };
    const answer = await policies.access(login, repo).catch((e) => ({ error: e?.message ?? e }));
    if (!answer || answer.error) return { ok: false, error: String(answer?.error ?? "no answer") };
    const ok = action == null ? anyAction(answer) : allows(answer, action, repo != null);
    return { ok, error: null };
  }

  // Whether `login` sees `repo` at all: some action there.
  async function visible(login, repo, listed = false) {
    if (repo == null) return false;
    return anyAction(await answerOf(login, repo, listed));
  }

  // The repositories among `repos` (names) where `login` may do `action` (null: visible()), by
  // their names in lower case: one decision each, asked together, for a filter that can't wait
  // (http-state.mjs state()). `listed`: each repository as last listed (answerOf()'s), for a filter
  // over what the dashboard shows; never for a check that guards something on its own (a log
  // stream), which reads it as a single decision does.
  async function which(login, repos, action = null, { listed = false } = {}) {
    const names = new Map();
    for (const repo of repos) if (repo) names.set(repo.toLowerCase(), repo);
    const said = await Promise.all(
      [...names].map(async ([key, repo]) => {
        const ok = action
          ? await can(login, repo, action, listed)
          : await visible(login, repo, listed);
        return ok && key;
      }),
    );
    return new Set(said.filter(Boolean));
  }

  // Those of `logins` who may do `action` on `repo`, by their logins in lower case: one decision
  // each, asked together. A decision that fails throws, for a caller that keeps what it decides
  // (auto-pickup.mjs, reviewers.mjs) and must not keep a refusal it wasn't given.
  async function whoMay(logins, repo, action) {
    const names = [...new Set(logins.filter(Boolean).map((l) => l.toLowerCase()))];
    const said = await Promise.all(names.map((login) => decide(login, repo, action)));
    const failed = said.find((d) => d.error);
    if (failed) throw new Error(`who has ${action} on ${repo} can't be decided (${failed.error})`);
    return new Set(names.filter((_, i) => said[i].ok));
  }

  // What the dashboard shows `login` (api/state's `access`, #732): their server-wide actions,
  // and on each of `repos` (names) they see, the repo's actions and starts (repoActions()), by
  // the repo's name in lower case, each as last listed (answerOf()'s `listed`, always: it only
  // decides which controls are shown, never an action, which its route decides on its own). The
  // repos they don't see aren't named.
  async function dashboard(login, repos) {
    const names = new Map();
    for (const repo of repos) if (repo) names.set(repo.toLowerCase(), repo);
    const [server, ...said] = await Promise.all([
      answerOf(login, null),
      ...[...names.values()].map((repo) => answerOf(login, repo, true)),
    ]);
    const shown = {};
    [...names.keys()].forEach((key, i) => {
      if (anyAction(said[i])) shown[key] = repoActions(said[i]);
    });
    return { server: serverActions(server), repos: shown };
  }

  // Who has what (Settings › Access, #732): for each of `logins`, their server-wide actions and
  // those on each of `repos`, with the files that decided them (reported()).
  async function report(logins, repos) {
    const one = async (login, repo) => {
      if (repo != null && outside(login, repo)) return reported(null, true);
      return reported(await answerOf(login, repo));
    };
    return Promise.all(
      logins.map(async (login) => ({
        login,
        server: await one(login, null),
        repos: await Promise.all(
          repos.map(async (repo) => ({ repo, ...(await one(login, repo)) })),
        ),
      })),
    );
  }

  return { answerOf, can, decide, visible, which, whoMay, dashboard, report };
}
