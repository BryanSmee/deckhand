// The listener's public HTTP server: GitHub's webhooks, /setup, sign-in, the dashboard and its
// API, /status and the runs' screenshots. The broker's, on the runs' networks only, is
// broker-http.mjs.
import { closeSync, constants, createReadStream, fstatSync, openSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { authPage } from "./auth.mjs";
import { board, isLive, STATES } from "./board.mjs";
import { createSlots, readDelivery, sourceOf } from "./deliveries.mjs";
import {
  closedItem,
  parseKey,
  previewEvent,
  prId,
  pullRequest,
  replayedPull,
  taskKey,
  touchedItems,
  verified,
  workItem,
} from "./events.mjs";
import { fetchPull } from "./github.mjs";
import { kindOf } from "./modes.mjs";
import { onboardingTargets } from "./onboarding.mjs";
import { previewHook } from "./previews.mjs";
import { applyInput, inputEvent } from "./questions.mjs";
import { refreshFor } from "./repos.mjs";
import { staleFor } from "./work.mjs";
import { publicRun, stream } from "./runlog.mjs";
import { serveAsset } from "./static.mjs";
import { closedAs } from "./titles.mjs";
import { apiRoute, send, sendJson } from "./web.mjs";

// On every answer: the dashboard's own scripts, styles and images only (its build has no
// inline script), never in a frame (a page on a sibling domain, which SameSite=Lax lets
// through, could get a signed-in user to click Start or Cancel), and never sniffed as another
// type. The listener's own pages narrow the policy further (html.mjs page()).
export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

const imageTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// GitHub's own cap is 25 MB, far above the events Deckhand takes: comments, pull requests,
// workflow runs. Only a push with many commits could be larger, and a push refused only delays
// a config's refresh (repos.mjs reads it again within 30 minutes).
const MAX_DELIVERY = 5 * 1024 * 1024;
// Deliveries read at once before their signature is checked: GitHub sends a few at a time, from
// many addresses. One address gets a share of the places (deliveries.mjs).
const MAX_UNVERIFIED = 16;
const PER_SOURCE = 4;
// A reader this old may lose its place to a new delivery: GitHub's bodies take milliseconds.
const GRACE_MS = 1000;
const IDLE_MS = 2000;
const BODY_MS = 10000;

// Health checks and scripts call from inside the container (docker compose exec). A reverse
// proxy on the host's network calls from loopback too, for anyone: a request it forwarded
// (it says so in a header) isn't local.
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];
export function local(req) {
  if (FORWARDED.some((h) => req.headers[h] !== undefined)) return false;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

// GitHub's delivery ids remembered, newest last: a redelivery of one of them (by hand, or after
// a timeout on GitHub's side) would queue its comment twice.
const RECENT_DELIVERIES = 500;

// The dashboard's Sync asks GitHub at most this often: each one lists the App's deliveries.
const SYNC_MS = 30_000;

// The graph's arrows, blocker → waiting task, for the waits of the tasks `shown`, and the keys
// of the blockers that aren't shown. A wait names numbers: a pull request on the board is
// "#pr-n", anything else "#n" (pull requests are issues to GitHub's API).
export function waitEdges(shown, waits) {
  const keys = new Set(shown.map((t) => t.key));
  const edges = [];
  const blockers = new Set();
  for (const w of waits) {
    if (!keys.has(w.key)) continue;
    for (const n of w.blockers) {
      const pr = taskKey(w.repo, prId(n));
      const from = keys.has(pr) ? pr : taskKey(w.repo, n);
      edges.push({ from, to: w.key, kind: "after" });
      if (!keys.has(from)) blockers.add(from);
    }
  }
  return { edges, blockers: [...blockers] };
}

// `ctx` (server.mjs): the listener's state and services, read at call time. `dashboardDir`:
// the dashboard's build (../dashboard/, `npm run build`), copied there by the image.
export function createHttp(ctx, { dashboardDir }) {
  const { config, log, skip, tasks } = ctx;

  // Comments on their way to the queue: a listener that stops saves them too.
  const admitting = new Set();
  const deliveries = new Set();

  // True the first time a delivery id is seen; deliveries without one are taken.
  function firstTime(id) {
    if (!id) return true;
    if (deliveries.has(id)) return false;
    deliveries.add(id);
    // A Set iterates in insertion order: the oldest goes.
    if (deliveries.size > RECENT_DELIVERIES) deliveries.delete(deliveries.values().next().value);
    return true;
  }

  function trusted(req) {
    return local(req) || ctx.auth.user(req) !== null;
  }

  // Whether `user` may see a repo's tasks and logs: the repo's own `users`, where the listener
  // knows them (ctx.usersOf()), narrow ALLOWED_USERS. Tool output in the logs may hold the
  // repo's secrets.
  function sees(user, repo) {
    if (!repo) return false;
    const users = ctx.usersOf(repo);
    return !users || users.includes(user);
  }

  const repoOf = (key) => parseKey(key)?.repo ?? null;

  // The dashboard's tasks: each issue and pull request with its state (board.mjs). `user`:
  // only the repos they may see; all of them without one.
  function shownTasks(user = null) {
    const mine = (list) => (user ? list.filter((x) => sees(user, repoOf(x.key))) : list);
    // A running task's comments are queued only when they wait for a follow-up run: the others
    // are on their way to the live session.
    const queued = [...tasks.values()]
      .filter((t) => t.pending.length > (t.running ? ctx.deliverable(t) : 0))
      .filter((t) => !user || sees(user, t.repo))
      .map((t) => ({
        key: taskKey(t.repo, t.id),
        kind: kindOf(t.pending.at(-1).mode, t.kind),
        mode: t.pending.at(-1).mode,
        repo: t.repo,
        replyTo: t.pending.at(-1).replyTo,
      }));
    const shown = board({
      runs: mine(ctx.runs),
      queued,
      brainstorms: mine(ctx.brainstorms.list()),
      waits: mine(ctx.waits.list()),
      // Stored before the label was turned off: not listed.
      inputs: config.needsInputLabel ? mine(ctx.inputs.list()) : [],
    }).slice(0, 200);
    return { shown, queued };
  }

  // What the dashboard shows `user`.
  function state(user) {
    const { shown, queued } = shownTasks(user);
    const { edges, blockers } = waitEdges(shown, ctx.waits.list());
    const keys = [...shown.map((t) => t.key), ...blockers];
    // Titles and parents the listener doesn't have yet show on a later poll; a lane's parent's
    // title names it.
    if (ctx.app) {
      ctx.lanes?.fill(keys);
      ctx.titles.fill([...keys, ...(ctx.lanes?.parentKeys(keys) ?? [])]);
      ctx.pulls.fill(shown.map((t) => t.key));
    }
    // `now`: the dashboard compares run start times with the server clock, not its own.
    return {
      user,
      tasks: shown.map((t) => ({
        ...t,
        title: ctx.titles.get(t.key),
        closed: ctx.titles.closed(t.key),
        pr: ctx.pulls.get(t.key),
        // Its pull request's last policy decisions (decisions.mjs), newest first.
        ...(ctx.decisions?.get(t.key).length && { decisions: ctx.decisions.get(t.key) }),
        // Its last `/mode policy` dry run.
        ...(ctx.decisions?.dryRun(t.key) && { dryRun: ctx.decisions.dryRun(t.key) }),
        // Closed: the listener would refuse it.
        rerunnable: t.rerunnable && !ctx.titles.closed(t.key),
        // Off: Start and Queue don't open its open questions first (work.mjs act()).
        ...(t.questions && { waitForAnswers: ctx.waitsForAnswers?.(t.repo) ?? true }),
        runs: t.runs.map(publicRun),
      })),
      // The graph's arrows, and the issues they come from that aren't on the board.
      edges,
      blockers: blockers.map((key) => ({
        key,
        repo: parseKey(key)?.repo ?? null,
        number: parseKey(key)?.number ?? null,
        title: ctx.titles.get(key),
        closed: ctx.titles.closed(key),
      })),
      // The names the lanes of these issues can have (lanes.mjs), by key.
      lanes:
        ctx.lanes?.labels(keys, { title: ctx.titles.get, inboxes: ctx.inboxes?.() ?? [] }) ?? {},
      states: STATES,
      running: ctx.running,
      queued: queued.length,
      maxParallel: config.maxParallel,
      previews: ctx.previews.status().filter((h) => sees(user, h.repo)),
      // Each repo read so far: its inbox issues and discussions category (the Feedback form).
      inboxes: Object.fromEntries((ctx.inboxes?.() ?? []).filter(([repo]) => sees(user, repo))),
      // GitHub Enterprise: the dashboard's links go where the listener's do.
      githubUrl: config.githubUrl,
      // Which Deckhand runs and since when (status.mjs serverInfo()): the Repositories page.
      server: ctx.server,
      // The last catch-up with GitHub, at start or from a Sync (sync.mjs); null before one.
      lastSync: ctx.lastSync?.() ?? null,
      now: Date.now(),
    };
  }

  function serveDashboard(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (!ctx.app) {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end(
        "Deckhand listener: up, no GitHub App yet. Open the /setup link from the listener's logs.\n",
      );
    }
    const user = ctx.auth.user(req);
    if (!user) {
      if (url.pathname !== "/") return res.writeHead(401).end();
      return authPage(
        res,
        200,
        "Deckhand",
        `<p>Runs, brainstorms and their live logs, for this Deckhand's allowed users.</p>
<p><a class="button" href="/auth/login">Sign in with GitHub</a></p>`,
      );
    }
    if (serveAsset(res, dashboardDir, url.pathname)) return;
    res.setHeader("cache-control", "no-store");
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res
        .writeHead(503)
        .end(
          `Deckhand listener: the dashboard isn't built (${dashboardDir}): run npm run build in dashboard/.\n`,
        );
    }
    if (url.pathname === "/api/state") return sendJson(res, state(user));
    // Read when Settings › Server opens, not at each poll: it scans the grants folder.
    if (url.pathname === "/api/server") return sendJson(res, ctx.serverSetup());
    const match = /^\/api\/runs\/([\w.-]+)\/stream$/.exec(url.pathname);
    const run = match && ctx.runsById.get(match[1]);
    const visible = () => ctx.auth.user(req) === user && sees(user, run.repo ?? repoOf(run.key));
    if (run && visible())
      return stream(req, res, run, visible, 1000, (error) =>
        log(`${match[1]}: its log stream failed: ${error.stack ?? error}`),
      );
    res.statusCode = 404;
    res.end();
  }

  // Public, like any image in a GitHub comment; the folder token is the only protection.
  function serveShot(req, res) {
    const match = /^\/shots\/([0-9a-f]{24})\/([\w.-]+\.(png|jpe?g|webp))$/.exec(req.url);
    const fd = match && openShot(match[1], match[2]);
    if (fd === null) {
      res.statusCode = 404;
      return res.end();
    }
    res.writeHead(200, {
      "content-type": imageTypes[match[3]],
      "cache-control": "public, max-age=31536000, immutable",
    });
    // pipeline(), not pipe(): a client that goes away closes the file too.
    pipeline(createReadStream(null, { fd }), res, () => {});
  }

  // The sandbox writes its folder and the listener runs as root: a link there would serve
  // any file of the listener's (app.json, its private key). Only a regular file, opened
  // without following a link (O_NOFOLLOW, so swapping one in after the check doesn't help),
  // whose real path is in the run's own folder. O_NONBLOCK: a FIFO would otherwise block the
  // open, and the whole listener with it, until something writes it; the type check refuses it.
  function openShot(folder, name) {
    let fd = null;
    try {
      const path = join(ctx.shotsDir, folder, name);
      if (realpathSync(path) !== join(realpathSync(ctx.shotsDir), folder, name)) return null;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (stat.isFile() && stat.nlink === 1) return fd;
    } catch {
      // Missing, a link, or unreadable: all a 404.
    }
    if (fd !== null) closeSync(fd);
    return null;
  }

  // Bodies being read before their signature can be checked: a public port, so capped.
  const unverified = createSlots({
    total: MAX_UNVERIFIED,
    share: PER_SOURCE,
    graceMs: GRACE_MS,
  });

  function webhook(req, res) {
    if (refusedEarly(req, res)) return;
    const source = sourceOf(req.socket.remoteAddress);
    const release = unverified.take(source, () =>
      req.destroy(new Error("its place taken by a newer delivery")),
    );
    if (!release) {
      return refuse(res, 503, `no place to read a delivery from ${source}`, "busy");
    }
    readDelivery(req, { limit: MAX_DELIVERY, idleMs: IDLE_MS, totalMs: BODY_MS })
      .finally(release)
      .then(
        (body) => {
          if (refused(req, res, body)) return;
          // Answer at once: GitHub gives up after 10 seconds, runs take minutes.
          res.statusCode = 202;
          res.end();
          const id = req.headers["x-github-delivery"];
          if (!firstTime(id)) return log(`Delivery ${id} again: already handled`);
          let payload;
          try {
            payload = JSON.parse(body.toString("utf8"));
          } catch {
            return;
          }
          guarded(req.headers["x-github-event"], payload, id);
        },
        (error) => log(`Rejected a delivery: ${error.message}`),
      );
  }

  const refuse = (res, status, why, text) => {
    log(`Rejected a delivery: ${why}`);
    // The body isn't read: the connection isn't reused for another request.
    res.writeHead(status, { connection: "close" });
    res.end(text);
    return true;
  };

  // What can be refused from the headers alone, before reading the body: answered and true.
  function refusedEarly(req, res) {
    // Failed on GitHub's side, where it can be redelivered, rather than lost.
    if (ctx.stopping) return refuse(res, 503, "stopping", "restarting");
    if (!ctx.app) return refuse(res, 503, "no GitHub App yet (open /setup)", "not set up");
    if (!req.headers["x-hub-signature-256"]) {
      return refuse(res, 401, "no signature (not from this listener's App)", "bad signature");
    }
    if (Number(req.headers["content-length"]) > MAX_DELIVERY) {
      return refuse(res, 413, `over ${MAX_DELIVERY} bytes`, "too large");
    }
    return false;
  }

  // A delivery the listener can't take now, or that isn't from its App: answered and true.
  function refused(req, res, body) {
    if (ctx.stopping) return refuse(res, 503, "stopping", "restarting");
    if (!verified(ctx.app.credentials.webhook_secret, req.headers["x-hub-signature-256"], body)) {
      return refuse(res, 401, "bad signature (not from this listener's App)", "bad signature");
    }
    return false;
  }

  // A delivery's unexpected throw is logged: it never takes the listener down, nor the
  // deliveries that come after it (already answered 202, it isn't redelivered).
  function guarded(event, payload, id) {
    try {
      if (event === "pull_request" && ctx.redelivered?.(id)) return replay(event, payload);
      dispatch(event, payload);
    } catch (error) {
      log(`Delivery ${event} ${payload?.action ?? ""} failed: ${error.stack ?? error}`);
    }
  }

  // A redelivered pull request delivery, handled as its pull request is now (events.mjs
  // replayedPull()): its own snapshot may be older than what the listener handled since.
  function replay(event, payload) {
    const repo = payload?.repository?.full_name;
    const number = payload?.pull_request?.number;
    if (!repo || !number) return dispatch(event, payload);
    admitted(
      fetchPull(ctx.github, repo, number).then((current) => {
        if (!current) return log(`Delivery ${event} ${payload.action}: ${repo}#${number} is gone`);
        log(`Delivery ${event} ${payload.action}: redelivered, as ${repo}#${number} is now`);
        dispatch(event, replayedPull(payload, current));
      }),
    );
  }

  // A verified delivery: onboarding, a pull request's state, a preview hook or a comment.
  function dispatch(event, payload) {
    const { app } = ctx;
    log(`Delivery: ${event} ${payload.action ?? ""} from ${payload.sender?.login ?? "?"}`);
    app.remember(payload.repository?.full_name, payload.installation?.id);
    // A default branch that moved: the repository list and the policies read it again.
    if (refreshFor(event, payload, ctx.repoList.refresh) && payload.repository?.full_name) {
      ctx.policies?.forget(payload.repository.full_name);
    }
    // Only the repository list's: nothing runs on a push.
    if (event === "push") return;
    if (event === "installation" || event === "installation_repositories") {
      const added = [...(payload.repositories ?? []), ...(payload.repositories_added ?? [])];
      for (const r of added) app.remember(r.full_name, payload.installation?.id);
      const repos = onboardingTargets(config, event, payload, skip);
      if (repos.length) admitted(ctx.onboarding.onboard(repos, payload.sender?.login));
      return;
    }
    const pr = pullRequest(config, event, payload, Date.now(), skip);
    if (pr && ctx.pulls.record(pr.key, pr.pr))
      log(`${pr.key}: pull request #${pr.pr.number} ${pr.pr.state}`);
    // What comments wait for ("/after #12"): closed issues, merged pull requests.
    const closed = closedItem(config, event, payload, skip);
    if (closed) {
      ctx.titles.setClosed(closed.key, closedAs(closed.state));
      admitted(ctx.waits.closed(closed.repo, closed.number, closed.state));
    }
    // Anything else about what comments wait for, or about the issue a pull request closes,
    // asks GitHub about it again: a merge closes that issue without an `issues` delivery to an
    // App that has no such subscription.
    const touched = touchedItems(config, event, payload);
    for (const n of touched?.numbers ?? []) {
      if (n === closed?.number) continue;
      const { repo } = touched;
      admitted(n === touched.merged ? ctx.waits.merged(repo, n) : ctx.waits.recheck(repo, n));
    }
    // Open questions and answers to them: the needs-input label (questions.mjs).
    const input = inputEvent(config, event, payload, app.identity().name);
    if (input) admitted(applyInput(ctx, input));
    // Nothing runs for an issue being opened, edited, labelled or closed: the graph's backlog
    // is read again now, for its next poll.
    if (event === "issues") {
      staleFor(event, payload, (repo) => ctx.workApi?.stale(repo));
      return;
    }
    // A pull request that turned ready, in a repo whose `review.on` asks for a review.
    if (event === "pull_request") admitted(ctx.reviews.consider(event, payload, skip));
    const preview = previewEvent(config, event, payload, skip);
    if (preview) {
      previewHook(ctx, preview, payload).catch((error) => log(error.stack ?? error));
      return;
    }
    // The operator's checks first, so only comments that may run cost a config read.
    const item = workItem(config, event, payload, skip);
    if (item) {
      item.base = payload.repository?.default_branch;
      admitted(ctx.admit(item, event, payload));
    }
  }

  // The dashboard's Sync: what GitHub couldn't deliver, asked for again, and the open pull
  // requests' states (server.mjs sync()).
  let synced = null;
  const syncApi = apiRoute({
    name: "Sync",
    route: (pathname) => (pathname === "/api/sync" ? { what: "sync" } : null),
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

  function admitted(promise) {
    const done = promise.catch((error) => log(error.stack ?? error));
    admitting.add(done);
    done.finally(() => admitting.delete(done));
  }

  // One request's unexpected throw answers 500 and is logged: it never takes the listener down.
  function handle(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      route(req, res);
    } catch (error) {
      log(`${req.method} ${req.url}: ${error.stack ?? error}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  function route(req, res) {
    if (req.method === "GET" && req.url === "/health") return res.end("ok");
    if (req.method === "GET" && req.url.startsWith("/shots/")) return serveShot(req, res);
    if (ctx.setup.handle(req, res)) return;
    if (ctx.auth.handle(req, res)) return;
    if (req.url === "/status") {
      if (!trusted(req)) return res.writeHead(401).end();
      // A signed-in user's: only the repos they may see, as in api/state.
      const user = local(req) ? null : ctx.auth.user(req);
      return sendJson(res, ctx.status(user ? (repo) => sees(user, repo) : undefined));
    }
    if (req.method === "POST" && req.url === "/webhook") return webhook(req, res);
    if (req.url.startsWith("/api/sync")) {
      if (!ctx.app) return res.writeHead(503).end();
      if (syncApi(req, res, ctx.auth.user(req))) return;
    }
    if (req.url.startsWith("/api/repos")) {
      if (!ctx.app) return res.writeHead(503).end();
      const user = ctx.auth.user(req);
      if (ctx.workApi.handle(req, res, user)) return;
      if (ctx.discussionApi?.handle(req, res, user)) return;
      if (ctx.repoApi.handle(req, res, user)) return;
    }
    // GitHub only ever POSTs to /webhook; everything a browser asks for is the dashboard.
    if (req.method === "GET") return serveDashboard(req, res);
    res.statusCode = 404;
    res.end();
  }

  function listen() {
    const web = createServer(handle).listen(config.port, () => {
      // PORT=0 (the tests): the OS picks a free port, logged for whoever started the listener.
      config.port = web.address().port;
      log(`Listening on :${config.port}`);
    });
    return web;
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

  // Whether the delivery with this GUID was handled (redeliveries.mjs).
  const handled = (id) => deliveries.has(id);

  return { listen, admitting, boardKeys, liveKeys, taskOf, handled };
}
