// The broker's HTTP server, on the runs' networks only (compose.yaml doesn't publish its
// port): the egress proxy's questions (may this sandbox reach this host?), the GitHub gateway
// (github-gateway.mjs), which the proxy sends the sandboxes' GitHub calls to, the git gateway
// (git-gateway.mjs) and the agents' API endpoints
// (anthropic.mjs, openai.mjs, and google.mjs, which the proxy sends the Antigravity CLI's calls
// to). The runs' secrets are the broker's (broker.mjs).
import { createServer } from "node:http";
import { agentFor } from "./agents/index.mjs";
import { addressOf } from "./broker.mjs";
import { egressPolicy, githubHosts } from "./egress.mjs";
import { NO_TOKEN } from "./github-app.mjs";
import { taskKey } from "./events.mjs";
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

// Whether the running task's sandbox (or its engine) has address `ip`. Addresses are looked up
// once per run, the first time its sandbox connects, and forgotten once it exits (runs.mjs
// finish()): Docker may give the address to another sandbox.
async function hasAddress(ctx, task, ip) {
  const live = task.live;
  if (!live?.hosts) return false;
  if (!live.ip) {
    live.ip = await ctx.runner.address(task.name);
    live.engineIp = await ctx.runner.engineAddress(task.name);
  }
  return task.live === live && !!live.hosts && !!live.ip?.includes(ip);
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
  for (const task of ctx.tasks.values()) {
    if (!task.live?.secret || ctx.broker.runOf(task.live.secret) !== run) continue;
    return hasAddress(ctx, task, ip);
  }
  return false;
}

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createBrokerHttp(ctx) {
  const { config, log, tasks } = ctx;
  // GitHub's hosts first: the other relayed ones are Google's.
  const routes = [
    ...githubHosts(config).map((host) => ({
      prefix: `/relay/${host}/`,
      service: "githubGateway",
      name: "GitHub gateway",
      destroy: true,
    })),
    ...ROUTES,
  ];

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
    const live = task?.live;
    // Its container engine's plain HTTP is cached too, but its HTTPS never decrypted: its
    // builds and containers don't trust Deckhand's CA. So GitHub's hosts aren't relayed for it
    // but tunnelled, anonymously (the gateway gives its address no token): an exception #411
    // accepted, rather than break builds that fetch from GitHub.
    const engine = !!live?.engineIp?.includes(ip);
    // GitHub's hosts go to the GitHub gateway, but for a research run (NO_TOKEN): it has no
    // token there, nor the CA, and reads public GitHub anonymously through a tunnel instead,
    // as an engine does.
    const github = !!live && ctx.broker.runOf(live.secret)?.extra !== NO_TOKEN;
    // What its agent's calls need: hosts handed to the listener, hosts refused.
    const agent = agentFor(live?.record?.agent);
    const answer = task
      ? egressPolicy(host, live.hosts, live.trusted, live.cached, live.uncached ?? [], {
          decrypt: !engine,
          relayed: [...(github ? githubHosts(config) : []), ...(agent.relayed ?? [])],
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
    const route = routes.find((r) => req.url.startsWith(r.prefix));
    if (route) {
      return ctx[route.service].handle(req, res).catch(failed(res, route.name, route.destroy));
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
    const server = createServer(handle).listen(config.brokerPort, () => {
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

  return { listen };
}
