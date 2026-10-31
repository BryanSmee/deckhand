// The listener's port for sandboxes, on the runs' networks only (compose.yaml doesn't publish
// it): the egress proxy's questions (may this sandbox reach this host?, on a port of their own
// too, listenPolicy()), the GitHub gateway (github-gateway.mjs), which the proxy sends the
// sandboxes' GitHub calls to, the git gateway (git-gateway.mjs) and the agents' API endpoints
// (anthropic.mjs, openai.mjs, and google.mjs, which the proxy sends the Antigravity CLI's calls
// to). The runs' tokens are the broker service's (../broker/, #505): their renewal and the
// runs' files (inbox, CA, digest, screenshots) go there through the proxy; those that still
// come here (a proxy from before the broker service, a sandbox from before #511) are relayed to
// it (broker-service.mjs relay()), but a run's from before tokens, answered here from the
// runner's files (run-files.mjs).
import { createServer } from "node:http";
import { agentFor } from "./agents/index.mjs";
import { addressOf } from "./broker.mjs";
import { brokerHost, egressPolicy, githubContent, githubHosts, matchHost } from "./egress.mjs";
import { restricted } from "./github-forks.mjs";
import { NO_TOKEN } from "./github-app.mjs";
import { taskKey } from "./events.mjs";
import { engineName } from "./runner/engine.mjs";
import { drainable } from "../lib/drain.mjs";
import { createRunFiles } from "./run-files.mjs";
import { sendJson } from "../lib/http.mjs";
import { isToken } from "../lib/tokens.mjs";

// Path prefix → the ctx service that handles it, and how its failures are logged. A failure
// once the answer started cuts the connection when `destroy`: a half-sent stream (a push, an
// API answer) must not look complete.
const ROUTES = [
  { prefix: "/git/", service: "gitGateway", name: "Git gateway", destroy: true },
  { prefix: "/anthropic/", service: "anthropic", name: "Anthropic", destroy: true },
  { prefix: "/openai/", service: "openai", name: "OpenAI", destroy: true },
  { prefix: "/google/", service: "google", name: "Google", destroy: true },
  { prefix: "/relay/", service: "google", name: "Google", destroy: true },
];

// Temporary: remove once no sandbox from before #407 can still be running. Those sandboxes'
// gh sent `gh pr create|edit|ready` here (/pr/<owner>/<repo>/create, /pr/<owner>/<repo>/<n>/
// ready|draft|edit); a sandbox outlives a listener update, so its old gh gets the command that
// works now, which it prints, rather than a bare "not found". Nothing is read or checked: the
// answer only explains.
const OLD_PR = /^\/pr\/[^/?]+\/[^/?]+\/(?:create|([0-9]+)\/(ready|draft|edit))(?:\?|$)/;

function oldPrAnswer(match) {
  const [, number, action = "create"] = match;
  const command = action === "draft" ? `ready ${number} --undo` : `${action} ${number ?? ""}`;
  return {
    message:
      "this sandbox's gh predates its listener: run GH_TOKEN=$(deckhand-token) /usr/bin/gh pr " +
      `${command.trim()} with the same flags instead, which goes through the GitHub gateway`,
  };
}

// What a sandbox may call the broker service about its own run (`/run/…`, ../broker/http.mjs),
// relayed by the listener: the path and query as sent, when it is one of those and nothing the
// URL parser would change (no dot segment, encoded or not, no `//`); else null.
const RUN_PATHS = /^\/run\/(?:token|inbox|ca|digest|shots\/[^/]+)$/;
export function runPath(url) {
  const raw = String(url ?? "");
  const [pathname] = raw.split("?");
  let parsed;
  try {
    parsed = new URL(raw, "http://listener");
  } catch {
    return null;
  }
  if (parsed.pathname !== pathname || !RUN_PATHS.test(pathname)) return null;
  return parsed.pathname + parsed.search;
}

// The ID of the network (or pod) of the task's sandbox, or null: what its tokens are bound to
// (broker.mjs), which tokenEnv() kept on its live state when it signed them. A run from before
// tokens, picked up from a listener that didn't keep it, has it looked up once by its
// network's name (or its pod's): an ID is never reused, so keeping it is no list of addresses
// to go stale. One lookup at a time, and one that found nothing (its network gone) not again
// for SANDBOX_RETRY_MS: every connection of every sandbox asks about every task. A run with
// tokens has none until they are signed (it is starting): nothing to look up. None once it
// has ended (finish() clears its hosts).
const SANDBOX_RETRY_MS = 5_000;
async function sandboxOfTask(ctx, task) {
  const live = task.live;
  if (!live?.hosts) return null;
  if (!live.sandbox && live.secret) {
    const now = (ctx.now ?? Date.now)();
    if (!live.sandboxLooking && !(now - (live.sandboxMissedAt ?? -Infinity) < SANDBOX_RETRY_MS)) {
      live.sandboxLooking = Promise.resolve(ctx.runner.sandboxIdOf?.(task.name, live.id))
        .catch(() => null)
        .then((id) => {
          if (id) live.sandbox ??= id;
          else live.sandboxMissedAt = (ctx.now ?? Date.now)();
        })
        .finally(() => (live.sandboxLooking = null));
    }
    await live.sandboxLooking;
  }
  return task.live === live && live.hosts ? (live.sandbox ?? null) : null;
}

// The running task a connection from `ip` belongs to, by the ID of the network (or pod) the
// address is on, as the runner tells now (runner.locate()), with whether it is the task's
// sandbox or its container engine; null for any other container there (the listener's, the
// proxy's) or none. Nothing per run is kept: a run whose engine starts before its sandbox, or
// another run's starting meanwhile, changes nothing for the others (#517).
export async function taskWhere(ctx, ip) {
  const at = ip ? await ctx.runner.locate?.(ip) : null;
  if (!at?.sandbox) return null;
  for (const task of ctx.tasks.values()) {
    if ((await sandboxOfTask(ctx, task)) !== at.sandbox) continue;
    if (at.name === engineName(task.name)) return { task, engine: true };
    // Kubernetes names no container: the pod at that address is the sandbox.
    if (at.name == null || at.name === task.name) return { task, engine: false };
    return null;
  }
  return null;
}

// The header in which the egress proxy names the sandbox a call it relays came from
// (../proxy/proxy.mjs): believed from the proxy alone.
export const CLIENT_HEADER = "x-deckhand-client";

// Whether `req` comes from the egress proxy. It is on every run's network, so its name may
// resolve to its address on any of them: the caller is compared with all of them (`docker
// inspect`).
export async function fromProxy(ctx, req) {
  const caller = addressOf(req);
  if ((await ctx.runner.proxyAddresses()).includes(caller)) return true;
  return (await ctx.runner.proxyAddresses({ fresh: true })).includes(caller);
}

// The address of the sandbox that sent `req`: the one the egress proxy names when it relayed
// it, else its source address. A sandbox that sets the header itself gets its own address.
export async function clientAddress(ctx, req) {
  const named = req.headers[CLIENT_HEADER];
  if (typeof named === "string" && named && (await fromProxy(ctx, req))) {
    return named.replace(/^::ffff:/, "");
  }
  return addressOf(req);
}

// The ID of the network (or pod) a call from `ip` binds it to (broker.mjs `sandboxOf`), or
// null: only from a running task's sandbox or its engine, never from another container on that
// network, the listener's or the egress proxy's (a call the proxy made itself, with no client
// to name, to a host the operator named that leads back here).
export async function sandboxAt(ctx, ip) {
  const where = await taskWhere(ctx, ip);
  return where ? (where.task.live.sandbox ?? null) : null;
}

// The broker's record of the running task whose sandbox `ip` is, or null: what a call without a
// token is bound to (github-gateway.mjs). Never its engine's: the builds and containers there
// don't get the run's token, and mustn't get its GitHub token without it.
export async function runFrom(ctx, ip) {
  const where = await taskWhere(ctx, ip);
  if (!where || where.engine) return null;
  return ctx.broker.runOf(where.task.live.id) ?? null;
}

// Whether `ip` is the sandbox's (or engine's) of the running task the broker's `run` is: what
// binds the secret of a run from before tokens to its sandbox (broker.mjs sentBy()), by its
// network's ID as a token is. The run is found by its record, so no secret is compared here.
export async function runAt(ctx, run, ip) {
  const task = taskOf(ctx, run);
  return !!task && (await taskWhere(ctx, ip))?.task === task;
}

// The running task whose run the broker's record `run` is, or null.
export function taskOf(ctx, run) {
  for (const task of ctx.tasks.values()) {
    if (run && task.live && ctx.broker.runOf(task.live.id) === run) return task;
  }
  return null;
}

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createBrokerHttp(ctx) {
  const { config, log } = ctx;
  // GitHub's hosts first: the other relayed ones are Google's.
  const gateway = { service: "githubGateway", name: "GitHub gateway", destroy: true };
  const routes = [
    ...githubHosts(config).map((host) => ({ prefix: `/relay/${host}/`, ...gateway })),
    // GitHub's content hosts, any of them (egress.mjs githubContent()).
    { match: (url) => githubContent(/^\/relay\/([^/]+)\//.exec(url)?.[1] ?? ""), ...gateway },
    ...ROUTES,
  ];
  // Built here: only sandboxes call it.
  const runFiles = createRunFiles(ctx, { taskOf });

  // The proxy's BROKER_URL naming another broker than the listener's, said once: every run's
  // agent calls, pushes and files are refused meanwhile.
  let warnedBroker = false;

  async function egressAnswer(req, res) {
    const url = new URL(req.url, "http://broker");
    const ip = url.searchParams.get("ip") ?? "";
    const host = url.searchParams.get("host") ?? "";
    // Only the proxy may ask: it is the one that knows the connection's source address.
    if (!(await fromProxy(ctx, req))) {
      return sendJson(res, { allowed: false }, 403);
    }
    const where = await taskWhere(ctx, ip);
    const task = where?.task ?? null;
    // The broker itself (#511): the proxy forwards its plain HTTP (`broker=1`) for the runs'
    // sandboxes and engines (and a pod's agent install, which has no secret), never a build's.
    if (matchHost(host, [brokerHost(config)]) === "exact") {
      const forwarded = url.searchParams.get("broker") === "1";
      if (!forwarded && !warnedBroker) {
        warnedBroker = true;
        log(
          `Egress: the egress proxy asked about the broker's host (${host}) as any other: its BROKER_URL ` +
            `must be the listener's, ${config.brokerUrl}, or the runs' agent calls, pushes and files are refused (docs/setup.md)`,
        );
      }
      const allowed = forwarded && !!task;
      if (!allowed) log(`Egress: refused the broker for ${ip}`);
      // The network (or pod) the call came from, which the proxy vouches for to the broker
      // service: what the run's token is bound to.
      const sandbox = allowed ? (task.live.sandbox ?? null) : null;
      return sendJson(res, {
        allowed,
        private: false,
        cache: false,
        decrypt: false,
        relay: false,
        ...(sandbox && { sandbox }),
      });
    }
    // Not a sandbox: the runner's builder or an agent's install pod, or nothing.
    const other = task ? null : await ctx.images.egressFor?.(ip, host);
    if (other) {
      if (!other.allowed) log(`Egress: refused ${host} for ${ip} (a build or an install)`);
      return sendJson(res, other);
    }
    const live = task?.live;
    // Its pod still installs its agent (an init container, runner/kubernetes.mjs): the
    // install's hosts only, tunnelled, until the sandbox itself starts. Once it has, the run
    // never asks again: no API call per connection. The API failing to tell (null): only what
    // either may reach, the install's hosts that are the run's too, tunnelled, for this
    // connection alone: never the run's own hosts for an installer.
    const installs = task && !live.pastInstall ? await ctx.runner.installing?.(task.name) : false;
    if (installs === false && live) live.pastInstall = true;
    if (installs || installs === null) {
      const hosts = agentFor(live.record?.agent).install(config).hosts ?? [];
      const answer = egressPolicy(host, hosts, [], [], [], { decrypt: false });
      if (installs === null && matchHost(host, live.hosts) === null) answer.allowed = false;
      if (!answer.allowed)
        log(`Egress: refused ${host} for ${taskKey(task.repo, task.id)}'s agent install`);
      return sendJson(res, answer);
    }
    // Its container engine's plain HTTP is cached too, but its HTTPS never decrypted: its
    // builds and containers don't trust Deckhand's CA. So GitHub's hosts aren't relayed for it
    // but tunnelled, anonymously (the gateway gives its address no token): an exception #411
    // accepted, rather than break builds that fetch from GitHub.
    const engine = !!where?.engine;
    // GitHub's hosts go to the GitHub gateway, but for a research run (NO_TOKEN): it has no
    // token there, nor the CA, and reads public GitHub anonymously through a tunnel instead,
    // as an engine does.
    const run = live ? ctx.broker.runOf(live.id) : null;
    const github = !!live && run?.extra !== NO_TOKEN;
    // GitHub's content hosts only for a run the gateway checks (github-forks.mjs restricted()),
    // every one of them (egress.mjs githubContent()): the others reach them as plain hosts.
    const files = github && restricted(run) && githubContent(host) ? [host] : [];
    // What its agent's calls need: hosts handed to the listener, hosts refused.
    const agent = agentFor(live?.record?.agent);
    const answer = task
      ? egressPolicy(host, live.hosts, live.trusted, live.cached, live.uncached ?? [], {
          decrypt: !engine,
          relayed: [...(github ? githubHosts(config) : []), ...files, ...(agent.relayed ?? [])],
          blocked: agent.blocked,
        })
      : { allowed: false, private: false, cache: false, decrypt: false, relay: false };
    if (!answer.allowed)
      log(`Egress: refused ${host} for ${task ? taskKey(task.repo, task.id) : ip}`);
    sendJson(res, answer);
  }

  // A sandbox's call about its own run that came here (`/run/…`): on to the broker service
  // with its run token, and the network (or pod) it came from as the listener finds it, as the
  // egress proxy vouches for it there. A run from before tokens, whose secret the broker service
  // doesn't know, gets its files from here (run-files.mjs), and no renewal.
  async function runCall(req, res) {
    const [scheme, credential] = (req.headers.authorization ?? "").split(" ");
    const token = scheme === "Bearer" ? (credential ?? "") : "";
    if (isToken(token) && ctx.brokerService) {
      // The sandbox's own endpoints only, on a plain path: the relay carries the listener's
      // service token, which "/run/../runs" would take to the orchestrator's.
      const path = runPath(req.url);
      if (!path) return sendJson(res, { message: "not found" }, 404);
      const sandbox = await sandboxAt(ctx, await clientAddress(ctx, req));
      return ctx.brokerService.relay(req, res, { sandbox, token, path });
    }
    if (req.url === "/run/token") {
      return sendJson(res, { message: "only a run token is renewed" }, 401);
    }
    return runFiles.handle(req, res);
  }

  // A handler's failure: logged, a 500 when nothing was answered yet.
  const failed = (res, name, destroy) => (error) => {
    log(`${name}: ${error.stack ?? error}`);
    if (!res.headersSent) res.writeHead(500).end();
    else if (destroy) res.destroy();
  };

  function handle(req, res) {
    if (req.method === "GET" && req.url.startsWith("/egress?")) {
      return egressAnswer(req, res).catch(failed(res, "Egress", false));
    }
    const route = routes.find((r) => (r.match ? r.match(req.url) : req.url.startsWith(r.prefix)));
    if (route) {
      return ctx[route.service].handle(req, res).catch(failed(res, route.name, route.destroy));
    }
    if (req.url.startsWith("/run/")) {
      return runCall(req, res).catch(failed(res, "Run files", true));
    }
    const old = OLD_PR.exec(req.url);
    if (old) {
      log(`Broker: ${req.url.split("?")[0]} from a sandbox older than the listener`);
      return sendJson(res, oldPrAnswer(old), 410);
    }
    // No /token any more: sandboxes hold no GitHub token (github-gateway.mjs).
    sendJson(res, { error: "not found" }, 404);
  }

  function listen() {
    const server = drainable(createServer(handle)).listen(config.brokerPort, () => {
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

  // The egress policy alone, on its own port: the broker's drains on SIGTERM (lib/drain.mjs) while
  // the calls in flight finish, but every sandbox connection, to any host, waits on this
  // answer, so it stays open until the listener exits. The broker's port answers /egress too,
  // for a proxy whose POLICY_URL still names it.
  function listenPolicy() {
    const answer = (req, res) => {
      if (req.method === "GET" && req.url.startsWith("/egress?")) {
        return egressAnswer(req, res).catch(failed(res, "Egress", false));
      }
      sendJson(res, { error: "not found" }, 404);
    };
    const server = drainable(createServer(answer)).listen(config.policyPort, () => {
      config.policyPort = server.address().port;
      log(`Egress policy on :${config.policyPort}`);
    });
    return server;
  }

  return { listen, listenPolicy };
}
