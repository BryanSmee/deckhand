// The orchestrator's egress policy, on a port of its own that only the egress proxy calls
// (compose.yaml doesn't publish it): may this sandbox reach this host? The proxy asks it about
// every connection of every sandbox, and about the services' names sandboxes call
// (lib/services.mjs SANDBOX_URLS), whose plain HTTP it forwards to the broker, the github and the
// models service for a run's sandbox or engine alone, with the network (or pod) said here.
import { createServer } from "node:http";
import { agentFor } from "./agents/index.mjs";
import { addressOf } from "./broker.mjs";
import { egressPolicy, githubContent, githubHosts, matchHost } from "./egress.mjs";
import { restricted } from "./github-forks.mjs";
import { tunnelsGitHub } from "./github-app.mjs";
import { taskKey } from "./events.mjs";
import { engineName } from "./runner/engine.mjs";
import { drainable } from "../lib/drain.mjs";
import { sendJson } from "../lib/http.mjs";
import { SANDBOX_URLS } from "../lib/services.mjs";
import { withRequest } from "../lib/log.mjs";

// The hosts of the services' names, as sandboxes call them.
const SERVICE_HOSTS = Object.values(SANDBOX_URLS).map((url) => new URL(url).hostname);

// The ID of the network (or pod) of the task's sandbox, or null: what its tokens are bound to
// (broker.mjs), which tokenEnv() kept on its live state when it signed them. None until they are
// signed (it is starting), and none once it has ended (finish() clears its hosts).
function sandboxOfTask(task) {
  const live = task.live;
  return live?.hosts ? (live.sandbox ?? null) : null;
}

// The running task a connection from `ip` belongs to, by the ID of the network (or pod) the
// address is on, as the runner tells now (runner.locate()), with whether it is the task's
// sandbox or its container engine; null for any other container there (the proxy's) or
// none. Nothing per run is kept: a run whose engine starts before its sandbox, or
// another run's starting meanwhile, changes nothing for the others (#517).
export async function taskWhere(ctx, ip) {
  const at = ip ? await ctx.runner.locate?.(ip) : null;
  if (!at?.sandbox) return null;
  for (const task of ctx.tasks.values()) {
    if (sandboxOfTask(task) !== at.sandbox) continue;
    if (at.name === engineName(task.name)) return { task, engine: true };
    // Kubernetes names no container: the pod at that address is the sandbox.
    if (at.name == null || at.name === task.name) return { task, engine: false };
    return null;
  }
  return null;
}

// Whether `req` comes from the egress proxy. It is on every run's network, so its name may
// resolve to its address on any of them: the caller is compared with all of them (`docker
// inspect`).
export async function fromProxy(ctx, req) {
  const caller = addressOf(req);
  if ((await ctx.runner.proxyAddresses()).includes(caller)) return true;
  return (await ctx.runner.proxyAddresses({ fresh: true })).includes(caller);
}

// `ctx` (server.mjs): the orchestrator's state and services, read at call time.
export function createEgressHttp(ctx) {
  const { config, log } = ctx;

  async function egressAnswer(req, res) {
    const url = new URL(req.url, "http://egress");
    const ip = url.searchParams.get("ip") ?? "";
    const host = url.searchParams.get("host") ?? "";
    // Only the proxy may ask: it is the one that knows the connection's source address.
    if (!(await fromProxy(ctx, req))) {
      return sendJson(res, { allowed: false }, 403);
    }
    const where = await taskWhere(ctx, ip);
    const task = where?.task ?? null;
    // A service's name (#511): the proxy forwards its plain HTTP (`forward=1`) for the runs'
    // sandboxes and engines (and a pod's agent install), never a build's, and never tunnels it.
    if (matchHost(host, SERVICE_HOSTS) === "exact") {
      const allowed = url.searchParams.get("forward") === "1" && !!task;
      if (!allowed) log(`Egress: refused ${host} for ${ip}`);
      // The network (or pod) the call came from, which the proxy vouches for to the service:
      // what the run's tokens are bound to.
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
    // GitHub's hosts go to the GitHub gateway, but for a run whose capabilities give no `pull`
    // (a research run): it has no token there, nor the CA, and reads public GitHub anonymously
    // through a tunnel instead, as an engine does (github-app.mjs tunnelsGitHub()).
    const run = live ? ctx.broker.runOf(live.id) : null;
    const github = !!live && !tunnelsGitHub(run);
    // GitHub's content hosts only for a run the gateway checks (github-forks.mjs restricted()),
    // every one of them (egress.mjs githubContent()): the others reach them as plain hosts.
    const files = github && restricted(run) && githubContent(host) ? [host] : [];
    // What its agent's calls need: hosts handed to the models service, hosts refused.
    const agent = agentFor(live?.record?.agent);
    const answer = task
      ? egressPolicy(host, live.hosts, live.trusted, live.cached, live.uncached ?? [], {
          decrypt: !engine,
          relayed: [...(github ? githubHosts(config) : []), ...files, ...(agent.relayed ?? [])],
          blocked: agent.blocked,
        })
      : { allowed: false, private: false, cache: false, decrypt: false, relay: false };
    // An agent's relayed host (the Antigravity CLI's, with a plan's login): its calls go to the
    // models service (#504), which the proxy vouches the sandbox's network (or pod) to.
    if (answer.relay && matchHost(host, agent.relayed ?? []) === "exact" && live.sandbox) {
      Object.assign(answer, { models: true, sandbox: live.sandbox });
    }
    if (!answer.allowed)
      log(`Egress: refused ${host} for ${task ? taskKey(task.repo, task.id) : ip}`);
    // GitHub's hosts go to the github service (#502), which the proxy vouches the call's network
    // (or pod) to: the sandbox's, never its engine's, whose calls bind to no run there.
    const toGithub = answer.relay && matchHost(host, [...githubHosts(config), ...files]) !== null;
    if (toGithub) {
      answer.service = "github";
      if (!engine && live.sandbox) answer.sandbox = live.sandbox;
    }
    sendJson(res, answer);
  }

  // A handler's failure: logged, a 500 when nothing was answered yet.
  const failed = (res) => (error) => {
    (log.error ?? log)(`Egress: ${error.stack ?? error}`);
    if (!res.headersSent) res.writeHead(500).end();
  };

  // Every sandbox connection, to any host, waits on this answer, so it stays open until the
  // orchestrator exits. `bind(server, port, done)`: how it listens (the orchestrator's waits for
  // a port the copy before it still holds).
  function listen(bind = (server, port, done) => server.listen(port, done)) {
    const answer = (req, res) => {
      if (req.method === "GET" && req.url.startsWith("/egress?")) {
        return egressAnswer(req, res).catch(failed(res));
      }
      sendJson(res, { error: "not found" }, 404);
    };
    const server = drainable(createServer(withRequest(answer)));
    bind(server, config.policyPort, () => {
      config.policyPort = server.address().port;
      log(`Egress policy on :${config.policyPort}`);
    });
    return server;
  }

  return { listen };
}
