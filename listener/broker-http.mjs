// The broker's HTTP server, on the runs' networks only (compose.yaml doesn't publish its
// port): the egress proxy's questions (may this sandbox reach this host?, on a port of their
// own too, listenPolicy()), the GitHub gateway
// (github-gateway.mjs), which the proxy sends the sandboxes' GitHub calls to, the git gateway
// (git-gateway.mjs) and the agents' API endpoints
// (anthropic.mjs, openai.mjs, and google.mjs, which the proxy sends the Antigravity CLI's calls
// to), and the runs' files: inbox, CA, digest and screenshots (run-files.mjs). The runs'
// secrets are the broker's (broker.mjs).
import { createServer } from "node:http";
import { agentFor } from "./agents/index.mjs";
import { addressOf } from "./broker.mjs";
import { brokerHost, egressPolicy, githubContent, githubHosts, matchHost } from "./egress.mjs";
import { restricted } from "./github-forks.mjs";
import { NO_TOKEN } from "./github-app.mjs";
import { taskKey } from "./events.mjs";
import { drainable } from "./drain.mjs";
import { createRunFiles } from "./run-files.mjs";
import { sendJson } from "./web.mjs";

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

// How often a run's addresses are looked up again for a secret sent from an address that isn't
// among them (runAt()).
const ADDRESS_RETRY_MS = 5_000;

// Whether the running task's sandbox (or its engine) has address `ip`. Addresses are kept once
// they hold the sandbox's own, and forgotten once it exits (runs.mjs finish()): Docker may give
// the address to another sandbox. Until then they are looked up at each question: a run with an
// engine starts it before its sandbox, and the broker asks about every task whenever any
// sandbox connects (taskAt(), runFrom()), so a list kept then would hold the engine's alone and
// refuse the sandbox for good (#517). `again`: an address not among those kept looks them up
// again, at most every ADDRESS_RETRY_MS, before the answer is no.
async function hasAddress(ctx, task, ip, { again = false } = {}) {
  const live = task.live;
  if (!live?.hosts) return false;
  if (live.ip?.includes(ip)) return true;
  const now = (ctx.now ?? Date.now)();
  if (live.ip && !(again && now - (live.ipAt ?? 0) >= ADDRESS_RETRY_MS)) return false;
  const found = (await ctx.runner.address(task.name)) ?? [];
  const engine = await ctx.runner.engineAddress(task.name);
  if (task.live !== live || !live.hosts) return false;
  // The engine's address is its own whenever it is known: its connections are told apart by it.
  live.engineIp = engine;
  if (found.some((address) => !engine?.includes(address))) {
    live.ip = found;
    live.ipAt = now;
  }
  return found.includes(ip);
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

// The broker's record of the running task whose sandbox has address `ip`, or null: what a call
// without a secret is bound to (github-gateway.mjs). Never its engine's: the builds and
// containers there don't get the run's secret, and mustn't get its GitHub token without it.
export async function runFrom(ctx, ip) {
  for (const task of ctx.tasks.values()) {
    if (task.live?.secret && (await hasAddress(ctx, task, ip))) {
      if (task.live.engineIp?.includes(ip)) return null;
      return ctx.broker.runOf(task.live.secret) ?? null;
    }
  }
  return null;
}

// Whether `ip` is the sandbox's (or engine's) of the running task the broker's `run` is: what
// binds a run's secret to its sandbox (broker.mjs sentBy()). The run is found by its record,
// so no secret is compared here.
export async function runAt(ctx, run, ip) {
  const task = taskOf(ctx, run);
  return task ? hasAddress(ctx, task, ip, { again: true }) : false;
}

// The running task whose run the broker's record `run` is, or null.
export function taskOf(ctx, run) {
  for (const task of ctx.tasks.values()) {
    if (task.live?.secret && ctx.broker.runOf(task.live.secret) === run) return task;
  }
  return null;
}

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createBrokerHttp(ctx) {
  const { config, log, tasks } = ctx;
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

  // The running task whose sandbox has this address on its network.
  async function taskAt(ip) {
    for (const task of tasks.values()) {
      if (await hasAddress(ctx, task, ip)) return task;
    }
    return null;
  }

  async function egressAnswer(req, res) {
    const url = new URL(req.url, "http://broker");
    const ip = url.searchParams.get("ip") ?? "";
    const host = url.searchParams.get("host") ?? "";
    // Only the proxy may ask: it is the one that knows the connection's source address.
    if (!(await fromProxy(ctx, req))) {
      return sendJson(res, { allowed: false }, 403);
    }
    const task = await taskAt(ip);
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
      return sendJson(res, { allowed, private: false, cache: false, decrypt: false, relay: false });
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
    const engine = !!live?.engineIp?.includes(ip);
    // GitHub's hosts go to the GitHub gateway, but for a research run (NO_TOKEN): it has no
    // token there, nor the CA, and reads public GitHub anonymously through a tunnel instead,
    // as an engine does.
    const run = live ? ctx.broker.runOf(live.secret) : null;
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
      return runFiles.handle(req, res).catch(failed(res, "Run files", true));
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

  // The egress policy alone, on its own port: the broker's drains on SIGTERM (drain.mjs) while
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
