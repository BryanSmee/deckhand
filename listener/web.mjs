// The dashboard API's envelope (apiRoute()) and its same-origin check, for the listener's routes
// (http.mjs, repos.mjs, work.mjs, discussions.mjs). The generic helpers are lib/http.mjs's.
import { Refused, refuse, send } from "../lib/http.mjs";
import { refusal } from "./permissions.mjs";

// A POST from the dashboard's own page: the Origin header names this listener (its public
// URL, or the host the browser asked for). The session cookie's SameSite=Lax already keeps
// other sites' POSTs without it; this refuses the rest.
export function sameOrigin(req, publicUrl) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (publicUrl && url.origin === new URL(publicUrl).origin) return true;
  return !!req.headers.host && url.host === req.headers.host;
}

// A repo outside ALLOWED_REPOS, or one the user has no action on: the same answer, so that
// neither tells the other apart.
const hidden = (repo) => ({ error: `${repo} isn't one of this dashboard's repositories.` });

// A route whose action couldn't be decided (a policy error, a policy service away): refused,
// saying so, once the repo is known to be visible (else it is hidden()).
const undecided = (action) => ({
  error: `Whether you may do this (\`${action}\`) can't be decided now; try again later.`,
});

// A route whose action the user lacks.
export const needs = (action, repo) => ({
  error: `You can't do this ${repo ? `on ${repo}` : "here"}: it needs the \`${action}\` action.`,
});

// What a handler checks itself, the action depending on what is asked (a mode): throws Refused,
// a 403 when `user` may not do `action` on `repo`, a 503 when that can't be decided
// (`permissions`: none, nothing is checked).
export async function mustDo(permissions, user, repo, action) {
  if (!permissions) return;
  const said = await permissions.decide(user, repo, action);
  if (said.ok) return;
  if (said.error) refuse(503, undecided(action).error);
  refuse(403, needs(action, repo).error);
}

// A dashboard API's handle(req, res, user): what every route of work.mjs, discussions.mjs
// and repos.mjs checks the same way, in the same order. `route(pathname)`: { what, repo, ... }
// for a path of this API (`repo` null for one that names none), or null. `gets` and `posts`:
// what → handler(req, res, user, repo, route). The handler throws Refused for what the
// dashboard shows as it is; any other error is a 502, the stack in the logs.
// `allowed(repo)`: ALLOWED_REPOS (config.mjs repoAllowed()). `named(repo)`: the name the
// handler gets, GitHub's spelling (repo-check.mjs nameOf()). `name`: the log lines' prefix.
// `permissions` (permissions.mjs), with `action(found)`, the action the route needs (on its repo,
// server-wide for one without; null: none of its own, its handler checking what depends on the
// body): a repo where the user has no action answers as one outside ALLOWED_REPOS, so that it
// is hidden, and so does one where that can't be decided (api/state hides it too), the log
// saying which; one where they lack this route's action, a 403, a 503 when that can't be decided.
export function apiRoute({
  name,
  route,
  gets = {},
  posts = {},
  allowed = () => true,
  permissions = null,
  action = () => null,
  named = async (repo) => repo,
  publicUrl = () => null,
  log = () => {},
}) {
  return function handle(req, res, user) {
    const { pathname } = new URL(req.url, "http://localhost");
    const found = route(pathname);
    if (!found) return false;
    const { what, repo = null } = found;
    const run = async () => {
      const get = Object.hasOwn(gets, what) ? gets[what] : null;
      const post = Object.hasOwn(posts, what) ? posts[what] : null;
      const methods = [post && "POST", get && "GET"].filter(Boolean);
      if (!methods.includes(req.method)) {
        return send(res, 405, { error: `${methods.join(" or ")} only.` });
      }
      if (!user) return send(res, 401, { error: "Sign in first." });
      // The Origin first: another site's POST costs no decision (which may read GitHub), and is
      // answered the same whatever the repo, so that a hidden one isn't told from one outside
      // ALLOWED_REPOS.
      if (req.method === "POST" && !sameOrigin(req, publicUrl())) {
        log(`${name}: refused for ${user}: Origin ${req.headers.origin ?? "missing"}`);
        return send(res, 403, { error: "Not from this dashboard." });
      }
      if (repo && !allowed(repo)) return send(res, 404, hidden(repo));
      if (permissions) {
        if (repo) {
          const sees = await permissions.decide(user, repo, null);
          if (!sees.ok) {
            if (sees.error) log(`${name}: ${repo}: hidden: ${refusal(sees, user, null)}`);
            return send(res, 404, hidden(repo));
          }
        }
        const needed = action(found);
        const said = needed && (await permissions.decide(user, repo, needed));
        if (said && !said.ok) {
          log(`${name}: ${repo ?? pathname}: refused: ${refusal(said, user, needed)}`);
          if (said.error) return send(res, 503, undecided(needed));
          return send(res, 403, needs(needed, repo));
        }
      }
      const spelled = repo && (await named(repo));
      return (req.method === "GET" ? get : post)(req, res, user, spelled, found);
    };
    run().catch((error) => {
      if (error instanceof Refused) {
        log(`${name}: ${repo ?? pathname}: refused for ${user}: ${error.message}`);
        if (!res.headersSent) send(res, error.status, { error: error.message });
        return;
      }
      log(`${name}: ${error.stack ?? error}`);
      if (!res.headersSent) {
        send(res, 502, { error: "GitHub didn't answer: see the orchestrator's logs." });
      }
    });
    return true;
  };
}
