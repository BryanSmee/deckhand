// The dashboard API's envelope (apiRoute()) and its same-origin check, for the listener's routes
// (http.mjs, repos.mjs, work.mjs, discussions.mjs). The generic helpers are lib/http.mjs's.
import { Refused, send } from "../lib/http.mjs";

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

// A dashboard API's handle(req, res, user): what every route of work.mjs, discussions.mjs
// and repos.mjs checks the same way, in the same order. `route(pathname)`: { what, repo, ... }
// for a path of this API (`repo` null for one that names none), or null. `gets` and `posts`:
// what → handler(req, res, user, repo, route). The handler throws Refused for what the
// dashboard shows as it is; any other error is a 502, the stack in the logs.
// `allowed(repo)`: ALLOWED_REPOS (config.mjs repoAllowed()). `named(repo)`: the name the
// handler gets, GitHub's spelling (repo-check.mjs nameOf()). `name`: the log lines' prefix.
export function apiRoute({
  name,
  route,
  gets = {},
  posts = {},
  allowed = () => true,
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
      if (repo && !allowed(repo)) {
        return send(res, 404, { error: `${repo} is not in ALLOWED_REPOS.` });
      }
      if (req.method === "POST" && !sameOrigin(req, publicUrl())) {
        log(`${name}: refused for ${user}: Origin ${req.headers.origin ?? "missing"}`);
        return send(res, 403, { error: "Not from this dashboard." });
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
