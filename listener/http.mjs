// The listener's two HTTP servers. The public one: GitHub's webhooks, /setup, sign-in, the
// dashboard and its API, /status and the runs' screenshots. The broker's, on the sandboxes'
// network only: installation tokens (broker.mjs) and the egress proxy's questions.
import { closeSync, constants, createReadStream, fstatSync, openSync, realpathSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { page } from "./auth.mjs";
import { board, STATES } from "./board.mjs";
import { matchHost } from "./egress.mjs";
import { previewEvent, pullRequest, verified, workItem } from "./events.mjs";
import { kindOf } from "./modes.mjs";
import { onboardingTargets } from "./onboarding.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { refreshFor } from "./repos.mjs";
import { publicRun, stream } from "./runlog.mjs";
import { serveAsset } from "./static.mjs";
import { readBody, sendJson } from "./web.mjs";

const imageTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// GitHub caps its deliveries at 25 MB.
const MAX_DELIVERY = 25 * 1024 * 1024;
// Deliveries read at once before their signature is checked: GitHub sends a few at a time.
const MAX_UNVERIFIED = 16;
const BODY_MS = 10000;

// Health checks and scripts call from inside the container (docker compose exec).
function local(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

// `ctx` (server.mjs): the listener's state and services, read at call time. `dashboardDir`:
// the dashboard's build (../dashboard/, `npm run build`), copied there by the image.
export function createHttp(ctx, { dashboardDir }) {
  const { config, log, skip, tasks } = ctx;

  // Comments on their way to the queue: a listener that stops saves them too.
  const admitting = new Set();

  function trusted(req) {
    return local(req) || ctx.auth.user(req) !== null;
  }

  // What the dashboard shows `user`: each issue and pull request with its state (board.mjs).
  function state(user) {
    // A running task's comments are queued only when they wait for a follow-up run: the others
    // are on their way to the live session.
    const queued = [...tasks.values()]
      .filter((t) => t.pending.length > (t.running ? ctx.deliverable(t) : 0))
      .map((t) => ({
        key: `${t.repo}#${t.id}`,
        kind: kindOf(t.pending.at(-1).mode, t.kind),
        mode: t.pending.at(-1).mode,
        repo: t.repo,
        replyTo: t.pending.at(-1).replyTo,
      }));
    const shown = board({ runs: ctx.runs, queued, brainstorms: ctx.brainstorms.list() }).slice(
      0,
      200,
    );
    // Titles the listener doesn't have yet show on a later poll.
    if (ctx.app) {
      ctx.titles.fill(shown.map((t) => t.key));
      ctx.pulls.fill(shown.map((t) => t.key));
    }
    // `now`: the dashboard compares run start times with the server clock, not its own.
    return {
      user,
      tasks: shown.map((t) => ({
        ...t,
        title: ctx.titles.get(t.key),
        pr: ctx.pulls.get(t.key),
        runs: t.runs.map(publicRun),
      })),
      states: STATES,
      running: ctx.running,
      queued: queued.length,
      maxParallel: config.maxParallel,
      previews: ctx.previews.status(),
      // GitHub Enterprise: the dashboard's links go where the listener's do.
      githubUrl: config.githubUrl,
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
      return page(
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
    const match = /^\/api\/runs\/([\w.-]+)\/stream$/.exec(url.pathname);
    const run = match && ctx.runs.find((r) => r.id === match[1]);
    if (run) return stream(req, res, run);
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
    createReadStream(null, { fd }).pipe(res);
  }

  // The sandbox writes its folder and the listener runs as root: a link there would serve
  // any file of the listener's (app.json, its private key). Only a regular file, opened
  // without following a link (O_NOFOLLOW, so swapping one in after the check doesn't help),
  // whose real path is in the run's own folder.
  function openShot(folder, name) {
    let fd = null;
    try {
      const path = join(ctx.shotsDir, folder, name);
      if (realpathSync(path) !== join(realpathSync(ctx.shotsDir), folder, name)) return null;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (stat.isFile() && stat.nlink === 1) return fd;
    } catch {
      // Missing, a link, or unreadable: all a 404.
    }
    if (fd !== null) closeSync(fd);
    return null;
  }

  // Bodies being read before their signature can be checked: a public port, so capped.
  let unverified = 0;

  function webhook(req, res) {
    if (refusedEarly(req, res)) return;
    unverified++;
    // GitHub sends its body at once: a slow one would hold a place.
    const timer = setTimeout(() => req.destroy(new Error("body not received in time")), BODY_MS);
    readBody(req, MAX_DELIVERY)
      .finally(() => {
        unverified--;
        clearTimeout(timer);
      })
      .then(
        (body) => {
          if (refused(req, res, body)) return;
          // Answer at once: GitHub gives up after 10 seconds, runs take minutes.
          res.statusCode = 202;
          res.end();
          let payload;
          try {
            payload = JSON.parse(body.toString("utf8"));
          } catch {
            return;
          }
          dispatch(req.headers["x-github-event"], payload);
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
    if (unverified >= MAX_UNVERIFIED) {
      return refuse(res, 503, `${MAX_UNVERIFIED} deliveries being read already`, "busy");
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

  // A verified delivery: onboarding, a pull request's state, a preview hook or a comment.
  function dispatch(event, payload) {
    const { app } = ctx;
    log(`Delivery: ${event} ${payload.action ?? ""} from ${payload.sender?.login ?? "?"}`);
    app.remember(payload.repository?.full_name, payload.installation?.id);
    refreshFor(event, payload, ctx.repoList.refresh);
    // Only the repository list's: nothing runs on a push.
    if (event === "push") return;
    if (event === "installation" || event === "installation_repositories") {
      const added = [...(payload.repositories ?? []), ...(payload.repositories_added ?? [])];
      for (const r of added) app.remember(r.full_name, payload.installation?.id);
      const repos = onboardingTargets(config, event, payload, skip);
      if (repos.length) admitted(ctx.onboard(repos, payload.sender.login));
      return;
    }
    const pr = pullRequest(config, event, payload, Date.now(), skip);
    if (pr && ctx.pulls.record(pr.key, pr.pr))
      log(`${pr.key}: pull request #${pr.pr.number} ${pr.pr.state}`);
    const preview = previewEvent(config, event, payload, skip);
    if (preview) {
      previewHook(preview, payload).catch((error) => log(error.stack ?? error));
      return;
    }
    // The operator's checks first, so only comments that may run cost a config read.
    const item = workItem(config, event, payload, skip);
    if (item) {
      item.base = payload.repository?.default_branch;
      admitted(ctx.admit(item, event, payload));
    }
  }

  function admitted(promise) {
    const done = promise.catch((error) => log(error.stack ?? error));
    admitting.add(done);
    done.finally(() => admitting.delete(done));
  }

  async function previewHook({ repo, base, event }, payload) {
    const { settings, errors } = await ctx.repoSettings(repo, base);
    if (errors.length) return skip(`${event}: ${CONFIG_FILE} of ${repo} has errors`);
    if (!settings.preview) return skip(`${event}: ${repo} has no preview hook`);
    const image =
      settings.preview.image ??
      (await ctx.images.imageFor({ repo, ref: base, dockerfile: settings.dockerfile }));
    await ctx.previews.run({ repo, event, payload, ref: base, hook: settings.preview, image });
  }

  function handle(req, res) {
    if (req.method === "GET" && req.url === "/health") return res.end("ok");
    if (req.method === "GET" && req.url.startsWith("/shots/")) return serveShot(req, res);
    if (ctx.setup.handle(req, res)) return;
    if (ctx.auth.handle(req, res)) return;
    if (req.url === "/status") {
      if (!trusted(req)) return res.writeHead(401).end();
      return sendJson(res, ctx.status());
    }
    if (req.method === "POST" && req.url === "/webhook") return webhook(req, res);
    if (req.url.startsWith("/api/repos")) {
      if (!ctx.app) return res.writeHead(503).end();
      if (ctx.repoApi.handle(req, res, ctx.auth.user(req))) return;
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

  // --- Egress: the proxy asks, for each connection, whether a sandbox may reach a host ----

  // The running task whose sandbox has this address on the sandboxes' network. Addresses are
  // looked up once per run, the first time its sandbox connects.
  async function taskAt(ip) {
    for (const task of tasks.values()) {
      const live = task.live;
      if (!live?.hosts) continue;
      if (!live.ip) live.ip = await ctx.runner.address(task.name);
      if (task.live === live && live.ip?.includes(ip)) return task;
    }
    return null;
  }

  // Only the proxy may ask: it is the one that knows the connection's source address.
  async function fromProxy(req) {
    const caller = req.socket.remoteAddress.replace(/^::ffff:/, "");
    const host = new URL(config.egressProxy).hostname;
    try {
      return (await lookup(host, { all: true })).some((a) => a.address === caller);
    } catch {
      return false;
    }
  }

  async function egressAnswer(req, res) {
    const url = new URL(req.url, "http://broker");
    const ip = url.searchParams.get("ip") ?? "";
    const host = url.searchParams.get("host") ?? "";
    if (!(await fromProxy(req))) {
      return sendJson(res, { allowed: false }, 403);
    }
    const task = await taskAt(ip);
    const match = task ? matchHost(host, task.live.hosts) : null;
    if (!match) log(`Egress: refused ${host} for ${task ? `${task.repo}#${task.id}` : ip}`);
    sendJson(res, { allowed: !!match, private: !!match && match !== "any" });
  }

  // Sandboxes and the egress proxy only: compose.yaml doesn't publish this port. Egress
  // answers, the token broker, the git gateway (git-gateway.mjs) and ready for review
  // (pr-ready.mjs).
  function listenBroker() {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url.startsWith("/egress?")) {
        return egressAnswer(req, res).catch((error) => {
          log(`Egress: ${error.stack ?? error}`);
          if (!res.headersSent) res.writeHead(500).end();
        });
      }
      if (req.url.startsWith("/git/")) {
        return ctx.gitGateway.handle(req, res).catch((error) => {
          log(`Git gateway: ${error.stack ?? error}`);
          if (!res.headersSent) res.writeHead(500).end();
          else res.destroy();
        });
      }
      if (req.url.startsWith("/pr/")) {
        return ctx.prReady.handle(req, res).catch((error) => {
          log(`Pull requests: ${error.stack ?? error}`);
          if (!res.headersSent) res.writeHead(500).end();
        });
      }
      ctx.broker.handle(req, res).catch((error) => {
        log(`Broker: ${error.stack ?? error}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    }).listen(config.brokerPort, () => {
      // BROKER_PORT=0 (the tests): the OS picks a free port, and sandboxes are sent to that one.
      if (!config.brokerPort) {
        const url = new URL(config.brokerUrl);
        url.port = server.address().port;
        config.brokerUrl = url.href.replace(/\/$/, "");
      }
      config.brokerPort = server.address().port;
      log(`Token broker on :${config.brokerPort}`);
    });
    return server;
  }

  return { listen, listenBroker, admitting };
}
