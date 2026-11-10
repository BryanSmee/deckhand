// The orchestrator's HTTP (#506): what edge passes on to it (edge/forward.mjs), on its services
// port under /edge/: the dashboard's API and /status, each with the user edge signed in, /mcp
// with the MCP client's login and scopes (mcp.mjs); and the verified deliveries edge puts on its
// stream (deliver()). The public server (webhooks, /setup, sign-in, the dashboard's files) is
// edge's (../edge/http.mjs); the egress policy, which the egress proxy asks, is egress-http.mjs.
// The parts: api/state (http-state.mjs), the reads beside it (http-reads.mjs), the deliveries
// (http-deliveries.mjs).
import { runData, DIMENSIONS } from "./run-data.mjs";
import { isLive } from "./board.mjs";
import { taskKey } from "./events.mjs";
import { publicRun, stream } from "./runlog.mjs";
import { Refused, send, sendJson } from "../lib/http.mjs";
import { repoAllowed } from "./config.mjs";
import { createMcp } from "./mcp.mjs";
import { apiRoute, needs, undecided } from "./web.mjs";
import { refusal } from "./permissions.mjs";
import { createState, TASKS } from "./http-state.mjs";
import { createReads } from "./http-reads.mjs";
import { createDeliveries } from "./http-deliveries.mjs";

// The dashboard's Sync asks GitHub at most this often: each one lists the App's deliveries.
const SYNC_MS = 30_000;

// `ctx` (../orchestrator/server.mjs): the orchestrator's state and services, read at call time.
export function createHttp(ctx) {
  const { config, log } = ctx;
  const { seeing, repoOf, namedRepos, shownTasks, state, accessReport } = createState(ctx);
  const { readsLog, reviewOf } = createReads(ctx, { seeing, repoOf });
  const { deliver, admitting } = createDeliveries(ctx);

  // What the MCP tools read (mcp.mjs), each for `user` as the dashboard shows it to them.
  const mcp = createMcp({
    version: ctx.server?.version,
    source: {
      state,
      repos: async (user) =>
        ctx.repoApi?.listed ? ctx.repoApi.listed(user, true) : { repos: [], listedAt: null },
      // All of them, not the board's newest per task (board.mjs RUNS_PER_TASK), with api/state's
      // checks: `tasks:read` on the repo, never a chat's.
      runs: async (user) => {
        const runs = ctx.runs.filter((r) => !r.owner);
        const repoOfRun = (r) => r.repo ?? repoOf(r.key);
        const shows = await seeing(user, [...new Set(runs.map(repoOfRun))], TASKS, true);
        return runs.filter((r) => shows(repoOfRun(r))).map(publicRun);
      },
      run: async (user, id) => {
        const run = ctx.runsById?.get(id);
        return run && (await readsLog(user, run)) ? run : null;
      },
      readLog: (id, options) => ctx.runLogs.read(id, options),
      // The work area's checks (its apiRoute()): ALLOWED_REPOS, then `tasks:read`, the repo's
      // `users` narrowing it.
      backlog: async (user, repo) => {
        if (!ctx.workApi?.backlog || !repoAllowed(config, repo)) return null;
        if (!(await seeing(user, [repo], TASKS))(repo)) return null;
        return ctx.workApi.backlog(repo, user).catch((error) => {
          if (error instanceof Refused && error.status === 404) return null;
          throw error;
        });
      },
      // The work area's own checks (work.mjs `mcp`): those of its routes, but the Origin.
      rerun: (user, runId) => ctx.workApi.mcp.rerun(user, runId),
      schedule: (user, repo, body) => ctx.workApi.mcp.schedule(user, repo, body),
      // The user's own machines (machines.mjs): what they register, they alone reach.
      machines: {
        register: (user, input) => ctx.machines.register(user, input),
        // Its claims' leases renewed with it (claims.mjs): `runs`, those its driver still has.
        heartbeat: (user, id, version, runs = null) => ({
          ...ctx.machines.heartbeat(user, id, version),
          claims: ctx.claims?.renew(user, id, runs) ?? [],
        }),
        remove: (user, id) => ctx.machines.remove(user, id),
        offers: (user, id) => ctx.machines.offers(user, id),
        // The next task routed to it, and a claim given back (claims.mjs).
        claim: (user, id, reported) => ctx.claims.claim(user, id, { reported }),
        release: (user, id, run) => ctx.claims.release(user, id, run),
        // A claim's run (#597): its output, its messages and its end, its machine's alone.
        post: (user, id, run, lines, from) => ctx.claims.post(user, id, run, lines, from),
        nextMessage: (user, id, run, from) => ctx.claims.nextMessage(user, id, run, from),
        ask: (user, id, run, question, pushed) => ctx.claims.ask(user, id, run, question, pushed),
        finish: (user, id, run, end) => ctx.claims.finish(user, id, run, end),
        // Its agent's tool calls, asked of its owner (#600, requests.mjs).
        approve: (user, id, run, ask) => ctx.claims.approve(user, id, run, ask),
      },
    },
    log,
  });

  // The dashboard's API that edge passes on (GET), for its signed-in `user`.
  async function serveDashboard(req, res, user) {
    const url = new URL(req.url, "http://localhost");
    if (!ctx.app) return res.writeHead(503).end();
    if (!user) return res.writeHead(401).end();
    res.setHeader("cache-control", "no-store");
    if (url.pathname === "/api/state") return sendJson(res, await state(user));
    // RunData (dashboard/src/types/server.ts): all retained shared runs, before board truncation.
    if (url.pathname === "/api/run-data") {
      const filters = Object.fromEntries(
        [...DIMENSIONS, "task"].map((k) => [k, url.searchParams.get(k)]),
      );
      for (const k of ["from", "to"]) {
        const raw = url.searchParams.get(k);
        if (raw !== null) {
          const n = Number(raw);
          if (!raw || !Number.isSafeInteger(n) || n < 0)
            return sendJson(res, { error: "Invalid period" }, 400);
          filters[k] = n;
        }
      }
      if (filters.from != null && filters.to != null && filters.from >= filters.to)
        return sendJson(res, { error: "Invalid period" }, 400);
      const shared = ctx.runs.filter((r) => !r.owner);
      const shows = await seeing(user, [...new Set(shared.map((r) => r.repo))], TASKS, true);
      return sendJson(
        res,
        runData({
          runs: shared.filter((r) => shows(r.repo)),
          filters,
          pull: (key) => ctx.pulls.get(key),
          reviewed: (repo, number) => ctx.reviews?.entry(repo, number),
        }),
      );
    }
    // Settings › Server and the services' health: server-wide. A decision that failed says so
    // (a 503), as apiRoute() does; the plans in api/state are just left out then.
    if (
      url.pathname === "/api/server" ||
      url.pathname === "/api/github-status" ||
      url.pathname === "/api/access" ||
      (url.pathname === "/api/health" && ctx.health)
    ) {
      const said = ctx.permissions
        ? await ctx.permissions.decide(user, null, "server:read")
        : { ok: true, error: null };
      if (!said.ok) {
        log(`${url.pathname}: refused: ${refusal(said, user, "server:read")}`);
        if (said.error) return sendJson(res, undecided("server:read"), 503);
        return sendJson(res, needs("server:read", null), 403);
      }
    }
    // Read when Settings › Server opens, not at each poll: it scans the grants folder.
    if (url.pathname === "/api/server") return sendJson(res, ctx.serverSetup());
    // GitHub's own status (#681), githubstatus.com's as the github service last read it.
    if (url.pathname === "/api/github-status" && ctx.githubStatus) {
      return ctx.githubStatus().then(
        (status) => sendJson(res, status),
        (error) => {
          log(`api/github-status: ${error.message ?? error}`);
          sendJson(res, { error: "The github service couldn't be asked: try again." }, 502);
        },
      );
    }
    // Settings › Access (#732): who has what, each of ALLOWED_USERS on each listed repo.
    if (url.pathname === "/api/access") return sendJson(res, await accessReport());
    // The services' health (health.mjs), probed at most every 10 s whoever asks: no URL in it.
    if (url.pathname === "/api/health" && ctx.health) {
      return ctx.health.check().then(
        (health) => sendJson(res, health),
        (error) => {
          (log.error ?? log)(`api/health: ${error.stack ?? error}`);
          sendJson(res, { message: "couldn't check the services" }, 500);
        },
      );
    }
    if (url.pathname === "/api/review") return reviewOf(res, user, url.searchParams);
    const match = /^\/api\/runs\/([\w.-]+)\/stream$/.exec(url.pathname);
    const run = match && ctx.runsById.get(match[1]);
    // Asked again each second while it streams: an access taken away ends it.
    const visible = () => readsLog(user, run);
    // The log is the runner's: read from it as edge (../runner/client.mjs readLog()).
    if (run && (await visible()))
      return stream(req, res, run, {
        read: (offset) => ctx.runLogs.read(run.id, { offset }),
        allowed: visible,
        onError: (error) => log(`${match[1]}: its log stream failed: ${error.stack ?? error}`),
      });
    res.statusCode = 404;
    res.end();
  }

  // The dashboard's Sync: what GitHub couldn't deliver, asked for again, and the open pull
  // requests' states, then their conflicts in the repos that opted in (sync.mjs).
  let synced = null;
  const syncApi = apiRoute({
    name: "Sync",
    route: (pathname) => (pathname === "/api/sync" ? { what: "sync" } : null),
    // Read at each request: the permissions are set up after this.
    permissions: {
      decide: async (user, repo, action) =>
        ctx.permissions ? ctx.permissions.decide(user, null, action) : { ok: true, error: null },
    },
    action: () => "server:sync",
    posts: {
      sync: async (req, res, user) => {
        if (synced !== null && Date.now() - synced < SYNC_MS) {
          return send(res, 429, { error: "Synced a moment ago." });
        }
        synced = Date.now();
        log(`Sync: asked by ${user}`);
        const done = await ctx.sync(user);
        send(res, done.error ? 502 : 200, done);
      },
    },
    publicUrl: ctx.publicUrl,
    log,
  });

  // Settings › MCP clients' machines (machines.mjs): the user's own, and their Remove. Nobody
  // sees another's.
  const machinesApi = apiRoute({
    name: "Machines",
    route: (pathname) => {
      if (pathname === "/api/machines") return { what: "list" };
      const remove = /^\/api\/machines\/([^/]+)\/remove$/.exec(pathname);
      return remove ? { what: "remove", id: remove[1] } : null;
    },
    gets: {
      list: (req, res, user) => {
        res.setHeader("cache-control", "no-store");
        sendJson(res, { machines: ctx.machines.list(user) });
      },
    },
    posts: {
      remove: (req, res, user, repo, { id }) =>
        sendJson(res, { removed: ctx.machines.remove(user, id).id }),
    },
    publicUrl: ctx.publicUrl,
    log,
  });

  // A machine task's held comments (claims.mjs), delivered or dropped by its owner alone: the
  // repo's own checks first (hidden, as the task, from who doesn't see it).
  const heldApi = apiRoute({
    name: "Held comments",
    route: (pathname) => {
      const m = /^\/api\/held\/([^/]+)\/([^/]+)\/(\d+)\/(deliver|drop)$/.exec(pathname);
      return m ? { what: m[4], repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
    },
    posts: {
      deliver: (req, res, user, repo, { number }) =>
        sendJson(res, { delivered: ctx.claims.deliverHeld(user, taskKey(repo, String(number))) }),
      drop: (req, res, user, repo, { number }) =>
        sendJson(res, { dropped: ctx.claims.dropHeld(user, taskKey(repo, String(number))) }),
    },
    allowed: (repo) => repoAllowed(config, repo),
    permissions: ctx.permissions,
    action: () => TASKS,
    publicUrl: ctx.publicUrl,
    log,
  });

  // A machine run's tool call (requests.mjs, #600), allowed or denied on the task's page by the
  // run's owner alone: the repo's own checks first, as for the held comments.
  const permissionsApi = apiRoute({
    name: "Tool requests",
    route: (pathname) => {
      const m = /^\/api\/permissions\/([^/]+)\/([^/]+)\/(\d+)\/([0-9a-f]{16})\/([a-z]+)$/.exec(
        pathname,
      );
      return m
        ? { what: "answer", repo: `${m[1]}/${m[2]}`, number: Number(m[3]), id: m[4], choice: m[5] }
        : null;
    },
    posts: {
      answer: async (req, res, user, repo, { number, id, choice }) => {
        const said = await ctx.requests.answerTool(user, taskKey(repo, String(number)), id, choice);
        if (said.error) throw new Refused(said.error, said.message);
        sendJson(res, said);
      },
    },
    allowed: (repo) => repoAllowed(config, repo),
    permissions: ctx.permissions,
    action: () => TASKS,
    publicUrl: ctx.publicUrl,
    log,
  });

  // What edge passes on (../edge/forward.mjs), `req.url` without its /edge prefix: `user`, the
  // login edge signed in (null: none); `local`, a caller of /status from inside edge's
  // container. One request's unexpected throw answers 500 and is logged: it never takes the
  // orchestrator down.
  // `scopes`: an MCP client's token's, for /mcp alone (../edge/oauth.mjs).
  function handle(req, res, { user = null, local = false, scopes = null } = {}) {
    // Async: a throw in it is a rejection too.
    route(req, res, user, local, scopes).catch((error) => {
      (log.error ?? log)(`${req.method} ${req.url}: ${error.stack ?? error}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  }

  async function route(req, res, user, local, scopes) {
    const path = req.url.split("?")[0];
    // MCP clients' (mcp.mjs): only with the scopes edge passes on from their token.
    if (path === "/mcp" || path === "/mcp/") {
      if (!ctx.app) return res.writeHead(503).end();
      return mcp.handle(req, res, { user, scopes });
    }
    if (req.url === "/status") {
      if (!local && !user) return res.writeHead(401).end();
      // A signed-in user's: only the repos they may see, as in api/state.
      const shows = user ? await seeing(user, namedRepos(), TASKS, true) : undefined;
      return sendJson(res, ctx.status(shows));
    }
    if (req.url.startsWith("/api/sync")) {
      if (!ctx.app) return res.writeHead(503).end();
      if (syncApi(req, res, user)) return;
    }
    if (req.url.startsWith("/api/chats")) {
      if (!ctx.app) return res.writeHead(503).end();
      if (ctx.chats?.handle(req, res, user)) return;
    }
    if (req.url.startsWith("/api/machines") && ctx.machines) {
      if (machinesApi(req, res, user)) return;
    }
    if (req.url.startsWith("/api/held/") && ctx.claims) {
      if (heldApi(req, res, user)) return;
    }
    if (req.url.startsWith("/api/permissions/") && ctx.requests) {
      if (permissionsApi(req, res, user)) return;
    }
    if (req.url.startsWith("/api/repos")) {
      if (!ctx.app) return res.writeHead(503).end();
      if (ctx.workApi.handle(req, res, user)) return;
      if (ctx.discussionApi?.handle(req, res, user)) return;
      if (ctx.repoApi.handle(req, res, user)) return;
    }
    if (req.method === "GET") return serveDashboard(req, res, user);
    res.statusCode = 404;
    res.end();
  }

  // The keys of the tasks on the dashboard, and of those with something live: the work area's
  // backlog leaves these out.
  const boardKeys = () => new Set(shownTasks().shown.map((t) => t.key));
  const liveKeys = () =>
    new Set(
      shownTasks()
        .shown.filter(isLive)
        .map((t) => t.key),
    );
  // A task as the dashboard has it (questions and all), or null.
  const taskOf = (key) => shownTasks().shown.find((t) => t.key === key) ?? null;

  return { handle, deliver, admitting, boardKeys, liveKeys, taskOf };
}
