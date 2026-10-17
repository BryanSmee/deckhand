// The broker's HTTP server, on the runs' networks only (compose.yaml doesn't publish its
// port): the egress proxy's questions (may this sandbox reach this host?), the token broker
// (broker.mjs), the git gateway (git-gateway.mjs), ready for review (pr-ready.mjs) and the
// agents' API endpoints (anthropic.mjs, openai.mjs, and google.mjs, which the proxy sends the
// Antigravity CLI's calls to).
import { createServer } from "node:http";
import { agentFor } from "./agents/index.mjs";
import { egressPolicy } from "./egress.mjs";
import { taskKey } from "./events.mjs";
import { sendJson } from "./web.mjs";

// Path prefix → the ctx service that handles it, and how its failures are logged. A failure
// once the answer started cuts the connection when `destroy`: a half-sent stream (a push, an
// API answer) must not look complete.
const ROUTES = [
  { prefix: "/git/", service: "gitGateway", name: "Git gateway", destroy: true },
  { prefix: "/anthropic/", service: "anthropic", name: "Anthropic", destroy: true },
  { prefix: "/openai/", service: "openai", name: "OpenAI", destroy: true },
  { prefix: "/relay/", service: "google", name: "Google", destroy: true },
  { prefix: "/pr/", service: "prReady", name: "Pull requests", destroy: false },
];

// `ctx` (server.mjs): the listener's state and services, read at call time.
export function createBrokerHttp(ctx) {
  const { config, log, tasks } = ctx;

  // The running task whose sandbox has this address on its network. Addresses are
  // looked up once per run, the first time its sandbox connects, and forgotten once it exits
  // (runs.mjs finish()): Docker may give the address to another sandbox.
  async function taskAt(ip) {
    for (const task of tasks.values()) {
      const live = task.live;
      if (!live?.hosts) continue;
      if (!live.ip) {
        live.ip = await ctx.runner.address(task.name);
        live.engineIp = await ctx.runner.engineAddress(task.name);
      }
      if (task.live === live && live.hosts && live.ip?.includes(ip)) return task;
    }
    return null;
  }

  // Only the proxy may ask: it is the one that knows the connection's source address. It is on
  // every run's network, so its name may resolve to its address on any of them: the caller is
  // compared with all of them (`docker inspect`).
  async function fromProxy(req) {
    const caller = req.socket.remoteAddress.replace(/^::ffff:/, "");
    if ((await ctx.runner.proxyAddresses()).includes(caller)) return true;
    return (await ctx.runner.proxyAddresses({ fresh: true })).includes(caller);
  }

  async function egressAnswer(req, res) {
    const url = new URL(req.url, "http://broker");
    const ip = url.searchParams.get("ip") ?? "";
    const host = url.searchParams.get("host") ?? "";
    if (!(await fromProxy(req))) {
      return sendJson(res, { allowed: false }, 403);
    }
    const task = await taskAt(ip);
    const live = task?.live;
    // Its container engine's plain HTTP is cached too, but its HTTPS never decrypted: its
    // builds and containers don't trust Deckhand's CA.
    const engine = !!live?.engineIp?.includes(ip);
    // What its agent's calls need: hosts handed to the listener, hosts refused.
    const agent = agentFor(live?.record?.agent);
    const answer = task
      ? egressPolicy(host, live.hosts, live.trusted, live.cached, live.uncached ?? [], {
          decrypt: !engine,
          relayed: agent.relayed,
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
    const route = ROUTES.find((r) => req.url.startsWith(r.prefix));
    if (route) {
      return ctx[route.service].handle(req, res).catch(failed(res, route.name, route.destroy));
    }
    ctx.broker.handle(req, res).catch(failed(res, "Broker", false));
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
