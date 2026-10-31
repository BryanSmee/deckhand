// The runner service (#503): the only one holding the Docker socket or the Kubernetes API. It
// starts, follows, talks to and removes sandboxes (../listener/runner/: the backends), builds
// repo images and installs agents (../listener/images.mjs), runs preview hooks
// (../listener/previews.mjs) and the plan logins' refresh, and keeps the runs' logs and events in
// its store. Its callers say what they want; what decides a sandbox's spec (branches, mode,
// caches, tokens' claims) stays with the orchestrator (../listener/preparation.mjs).
//
// Each endpoint names the callers it takes (ROUTES, lib/service-token.mjs serviceGuard()): the
// orchestrator drives runs, and asks for its egress policy where an address is (what binds a
// run's tokens to its sandbox) and for the inbox of a run from before tokens; edge reads a run's
// log for the dashboard's live view; models has the Antigravity login refreshed. Every
// orchestrator call but those lookups (UNFENCED) carries its fencing epoch
// (lib/service-client.mjs EPOCH_HEADER): one older than the newest seen is refused (409), so a
// copy of it that lost its lease can't start or stop a run.
//
// Two copies, active/passive (lib/active.mjs): the one holding the lease answers, the other says
// 503, which callers try again (lib/service-client.mjs). On SIGTERM the active one ends the output
// streams it serves (their callers follow again from where they were), lets the other calls in
// flight finish, then releases the lease, and the waiting copy takes it at once. Sandboxes run
// detached: neither copy's going stops one, and the next finds them by their labels. A start
// asked again (after a handover, a lost answer) is keyed by its run: it finds the sandbox and
// starts nothing.
import { createServer } from "node:http";
import { DRAIN_MS, drain, drainable } from "../lib/drain.mjs";
import { readBody, readJsonBody, Refused, send, sendJson } from "../lib/http.mjs";
import { EPOCH_HEADER } from "../lib/service-client.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { antigravity } from "../listener/agents/antigravity.mjs";
import { agentFor } from "../listener/agents/index.mjs";
import { SANDBOX_USER } from "../listener/sandbox-spec.mjs";
import { createEvents } from "./events.mjs";
import { ownImage, plainPath, runOf, specProblems } from "./spec-check.mjs";
import {
  buildPlan,
  buildProblem,
  grantOrRefuse,
  previewEventProblem,
  previewJob,
  validRepo,
} from "./hooks.mjs";
import { notGranted } from "../listener/grants.mjs";
import { cacheProblem } from "../listener/repo-config.mjs";
import { LogConflict, validLogId } from "./logs.mjs";

// Who may call what. A route that isn't here is refused to everyone.
export const ROUTES = {
  "GET /info": ["orchestrator"],
  "GET /sandboxes": ["orchestrator"],
  "POST /sandboxes": ["orchestrator"],
  "GET /sandboxes/:name": ["orchestrator"],
  "GET /sandboxes/:name/output": ["orchestrator"],
  "POST /sandboxes/:name/kill": ["orchestrator"],
  "DELETE /sandboxes/:name": ["orchestrator"],
  "GET /sandboxes/:name/network": ["orchestrator"],
  "GET /sandboxes/:name/installing": ["orchestrator"],
  "GET /sessions/:name": ["orchestrator"],
  "POST /runs/:run/messages": ["orchestrator"],
  "POST /runs/:run/close": ["orchestrator"],
  "GET /runs/:run/closed": ["orchestrator"],
  "GET /runs/:run/inbox": ["orchestrator"],
  "GET /runs/:run/files/:name": ["orchestrator"],
  "GET /addresses/:ip": ["orchestrator"],
  "GET /proxy-addresses": ["orchestrator"],
  "GET /egress": ["orchestrator"],
  "POST /relink": ["orchestrator"],
  "POST /images": ["orchestrator"],
  "POST /agents/:agent/install": ["orchestrator"],
  "POST /caches": ["orchestrator"],
  "POST /previews": ["orchestrator"],
  "GET /previews": ["orchestrator"],
  "GET /logs/:id": ["orchestrator", "edge"],
  "POST /logs/:id": ["orchestrator"],
  "DELETE /logs/:id": ["orchestrator"],
  "GET /events": ["orchestrator"],
  "POST /events/ack": ["orchestrator"],
  "POST /logins/antigravity/refresh": ["models"],
};

// What the listener's egress policy asks, and the files of runs from before tokens it serves
// (../listener/broker-http.mjs, run-files.mjs): reads that must answer while a listener drains
// after the next one started, so not fenced. They start, stop and change nothing.
const UNFENCED = new Set([
  "GET /sandboxes/:name/network",
  "GET /sandboxes/:name/installing",
  "GET /runs/:run/inbox",
  "GET /runs/:run/files/:name",
  "GET /addresses/:ip",
  "GET /proxy-addresses",
  "GET /egress",
]);

// The most a call's JSON may be: a sandbox spec holds its prompt, the proxy's CA and a run
// analysis's digest (analysis.mjs, 400 KB at most).
const MAX_JSON = 8 * 1024 * 1024;
// A log append: what the orchestrator gathered since its last one.
const MAX_APPEND = 16 * 1024 * 1024;
// How long a start is remembered by its run: what makes asking again start nothing.
const START_TTL_MS = 7 * 24 * 60 * 60_000;
// A message's key, against sending it twice.
const SENT_TTL_MS = 7 * 24 * 60 * 60_000;
// The longest a broker's inbox poll and a log read may wait.
const MAX_WAIT_MS = 30_000;

// Fences: the newest orchestrator epoch seen, in the store, so both copies refuse the same.
const EPOCH_KEY = "epoch/orchestrator";
// How far ahead of this copy's clock an epoch may be: they are the orchestrator's clock until
// #506 (lib/store.mjs nextEpoch()), so one further ahead is no clock's, and kept, it would refuse
// every listener after it until its key were removed from the store by hand.
const EPOCH_AHEAD_MS = 24 * 3600_000;

// A sandbox's, a run's or a message's name, as Docker and the runs folder take them: never `.`
// or `..` (a run's inbox folder is named after it), nor an option (`-…`).
const NAME = /^\w[\w.-]{0,249}$/;

function named(value, what) {
  if (typeof value !== "string" || !NAME.test(value)) throw new Refused(400, `${what}?`);
  return value;
}

// The Antigravity login's refresh (../listener/antigravity-login.mjs, the models service's, #504):
// `agy models` in a short container of its own on the login's volume, the token file in on
// stdin (its expiry in the past, so that `agy` refreshes it) and the one `agy` left out. Outside
// the runs' networks (INSTALL_NETWORK, as the installs): no repo or agent input runs here. Only
// that: the caller sends the file, never a container's spec. → { code, out, err }, or null for
// a backend without short containers.
export function loginRefresh({ config, images, jobs }) {
  if (!jobs?.run) return null;
  return async (input) => {
    await images.installAgent(antigravity, () => {});
    const { code, out, err } = await jobs.run({
      image: config.image,
      network: "install",
      user: SANDBOX_USER,
      env: { AGY_VERSION: config.agyVersion },
      volumes: [
        { name: config.agyVolume, path: "/opt/antigravity", readOnly: true },
        { name: config.agyLoginVolume, path: "/home/node/.gemini" },
      ],
      entrypoint: "deckhand-antigravity-refresh",
      input,
    });
    return { code, out: String(out ?? ""), err: String(err ?? "") };
  };
}

// "GET /sandboxes/:name" → (method, path) → params or null.
function route(key) {
  const [method, pattern] = key.split(" ");
  const parts = pattern.split("/");
  return (m, path) => {
    if (m !== method) return null;
    const segments = path.split("/");
    if (segments.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(":")) {
        try {
          params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
        } catch {
          return null;
        }
      } else if (parts[i] !== segments[i]) return null;
    }
    return params;
  };
}

// `backend`: ../listener/runner/index.mjs createBackend()'s { runner, images, jobs } as the
// runner wraps them; `images`: ../listener/images.mjs's, `previews`: ../listener/previews.mjs's,
// `logs`: logs.mjs's; `broker.runTokens(run, sandbox)`: the run's first tokens, as variables, once
// its network or pod exists (the orchestrator has the broker service sign them, #493); `refresh`: the Antigravity login's
// refresh job, or null. `keys()`: the broker's public keys (kid → key); `bound`: the callers'
// networks (lib/service-token.mjs networkCallers()), or null on Kubernetes.
export function createRunnerService({
  config,
  runner,
  images,
  previews,
  logs,
  store,
  broker,
  refresh = null,
  keys,
  bound,
  lease, // lib/active.mjs's: whether this copy acts
  log = () => {},
  now = Date.now,
  watchMs = 5000,
  // What the operator's policies grant a repository (grants.mjs grantsBy(), the policy
  // service's): none, nothing granted.
  granted = null,
  checkSpec = (spec) => specProblems(config, spec, { granted }),
  // The grants folder, read now (the tests' own).
  grants,
  // (repo, ref) → a folder of the repo's files (checkout.mjs, from the github service's
  // tarball; `ref` null: its default branch).
  checkout,
  // (repo, path, ref) → a file's blob id at `ref` (null: its default branch), or null: the
  // github service's.
  blobOf = async () => null,
}) {
  const guard = serviceGuard({
    service: "runner",
    keys: { get: (kid) => keys().get(kid) },
    routes: ROUTES,
    bound,
    now,
  });
  const table = Object.keys(ROUTES).map((key) => ({ key, match: route(key) }));
  const previewsGranted = async (repo) =>
    (await grantOrRefuse(config, repo, grants, granted)).allowPreview;
  const events = createEvents({ store, runner, log });
  // Output streams and log reads in flight: ended first on SIGTERM, their callers come back.
  const streams = new Set();
  const starting = new Map(); // run → its start in flight on this copy

  // A stale epoch refused; a newer one kept, compared-and-set so that two calls racing keep
  // the higher.
  async function fence(req) {
    const epoch = Number(req.headers[EPOCH_HEADER]);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Refused(400, "no fencing epoch");
    if (epoch > now() + EPOCH_AHEAD_MS) {
      throw new Refused(400, `epoch ${epoch}: further ahead of the runner's clock than a day`);
    }
    for (;;) {
      const newest = (await store.get(EPOCH_KEY)) ?? 0;
      if (epoch < newest) {
        throw new Refused(409, `epoch ${epoch} is stale: ${newest} is the orchestrator's now`);
      }
      if (epoch === newest || (await store.compareAndSet(EPOCH_KEY, newest || null, epoch))) {
        return;
      }
    }
  }

  // This deployment's sandbox of that name, as the backend lists them (by its own labels:
  // `deckhand.owner`, `deckhand.run`), or null: what the orchestrator may stop, follow or remove.
  async function ours(name) {
    try {
      return (await runner.list()).find((s) => s.name === name) ?? null;
    } catch (error) {
      throw new Refused(502, error.message);
    }
  }
  async function oursOrRefuse(name) {
    const found = await ours(name);
    if (!found) throw new Refused(404, `${name} isn't a sandbox of this deployment`);
    return found;
  }

  async function start(spec) {
    const run = named(spec?.run, "run");
    named(spec.name, "name");
    if (starting.has(run)) return starting.get(run);
    const doing = startOnce(spec).finally(() => starting.delete(run));
    starting.set(run, doing);
    return doing;
  }

  async function startOnce(spec) {
    const { run, name } = spec;
    // What holds whatever the orchestrator says (spec-check.mjs), first: a start asked again is
    // checked as the first was, and names only its own sandbox and run.
    const problems = await checkSpec(spec);
    if (problems.length) {
      log(`${name}: not started: ${problems.join("; ")}`);
      throw new Refused(403, `the runner refuses its spec: ${problems.join("; ")}`);
    }
    const key = `starts/${run}`;
    const known = await store.get(key);
    if (known?.state === "started") return { ...known.result, existing: true };
    if (known?.state === "starting") {
      // A copy stopped in the middle of it (a crash): its sandbox, if it got as far as running
      // it (this deployment's, that run's), stands; what it left before that (a network, an
      // engine, a container created and never started) goes, and the start is done again.
      const found = await ours(name);
      const state = found?.run === run ? await runner.state(name) : null;
      if (["running", "exited"].includes(state)) {
        await store.set(
          key,
          { state: "started", result: { engine: null } },
          { ttlMs: START_TTL_MS },
        );
        await events.started(run, name);
        return { engine: null, existing: true };
      }
      log(`${name}: a start cut short by another copy, started again`);
      await runner.remove(name, run).catch((error) => log(`${name}: ${error.message}`));
    }
    await store.set(key, { state: "starting" }, { ttlMs: START_TTL_MS });
    let result;
    try {
      result = await runner.start({
        ...spec,
        tokens: (sandbox) => broker.runTokens(run, sandbox),
        // Its host paths resolved again once the waits are over (the orchestrator answers the
        // tokens, as slowly as it likes): a sandbox may have swapped one for a symlink since.
        recheck: async () => {
          const again = await checkSpec(spec);
          if (again.length) {
            log(`${name}: not started: ${again.join("; ")}`);
            throw new Refused(403, `the runner refuses its spec: ${again.join("; ")}`);
          }
        },
      });
    } catch (error) {
      await store.delete(key);
      throw error;
    }
    await store.set(key, { state: "started", result }, { ttlMs: START_TTL_MS });
    await events.started(run, name);
    return { ...result, existing: false };
  }

  // NDJSON, one object a line, as it comes: a sandbox's output, an image's build.
  function ndjson(res) {
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    return (value) => res.write(`${JSON.stringify(value)}\n`);
  }

  // A build's or an install's output as it comes, then how it ended: { type: "done", … } or
  // { type: "error", message }.
  async function streamed(res, fn) {
    const line = ndjson(res);
    const output = (chunk) => line({ type: "output", data: Buffer.from(chunk).toString("base64") });
    try {
      const value = await fn(output, line);
      line({ type: "done", value: value ?? null });
    } catch (error) {
      line({ type: "error", message: error.message ?? String(error) });
    }
    res.end();
  }

  const handlers = {
    "GET /info": async () => ({
      runner: config.runner,
      keepsCaches: images.keepsCaches,
      noCaches: images.noCaches,
      previews: await previews.runs(),
      refresh: Boolean(refresh),
    }),
    "GET /sandboxes": async () => {
      try {
        return await runner.list();
      } catch (error) {
        // Not knowing isn't "none".
        throw new Refused(502, error.message);
      }
    },
    "POST /sandboxes": async ({ req }) => start(await readJsonBody(req, MAX_JSON)),
    "GET /sandboxes/:name": async ({ params }) => ({
      // Not one of this deployment's: none, whatever else has that name on the host.
      state: (await ours(named(params.name, "name"))) ? await runner.state(params.name) : null,
    }),
    "GET /sandboxes/:name/output": async ({ params, url, req, res }) => {
      const name = named(params.name, "name");
      await oursOrRefuse(name);
      const skip = {
        out: Number(url.searchParams.get("out") ?? 0) || 0,
        err: Number(url.searchParams.get("err") ?? 0) || 0,
      };
      const line = ndjson(res);
      streams.add(res);
      // A caller gone, or this copy stopping: `docker logs` ends, the caller follows again.
      const stop = new AbortController();
      res.on("close", () => (streams.delete(res), stop.abort()));
      return runner
        .follow(name, {
          skip,
          signal: stop.signal,
          onOut: (text, at) => line({ s: "out", line: text, at }),
          onErr: (text, at) => line({ s: "err", line: text, at }),
          // Both streams past what the caller skipped (../listener/runs.mjs follow()).
          onCaughtUp: () => line({ caughtUp: true }),
        })
        .then(() => res.end());
    },
    "POST /sandboxes/:name/kill": async ({ params }) => {
      await runner.kill((await oursOrRefuse(named(params.name, "name"))).name);
      return {};
    },
    "DELETE /sandboxes/:name": async ({ params, url }) => {
      const name = named(params.name, "name");
      const run = url.searchParams.get("run");
      // One of its task's runs (`<name>-<ms>`, runs.mjs), and the sandbox, when there is one,
      // this deployment's and that run's: never another container, nor another network.
      if (run !== null && !runOf(name, run))
        throw new Refused(400, `${run} isn't one of ${name}'s runs`);
      const found = await ours(name);
      if (!found && (await runner.state(name)))
        throw new Refused(404, `${name} isn't a sandbox of this deployment`);
      if (found && run !== null && found.run !== run)
        throw new Refused(409, `${name} is ${found.run}'s`);
      // Its end said only for a sandbox of ours: never one the runner didn't start.
      if (run && found) await events.ending(run, name);
      await runner.remove(name, run ?? undefined);
      return {};
    },
    "GET /sandboxes/:name/network": async ({ params, url }) => ({
      id:
        (await runner.sandboxIdOf?.(named(params.name, "name"), url.searchParams.get("run"))) ??
        null,
    }),
    "GET /sandboxes/:name/installing": async ({ params }) => ({
      installing: runner.installing ? await runner.installing(named(params.name, "name")) : false,
    }),
    "GET /sessions/:name": async ({ params, url }) => ({
      exists: await runner.hasSession(
        named(params.name, "name"),
        agentFor(url.searchParams.get("agent") ?? undefined),
      ),
    }),
    "POST /runs/:run/messages": async ({ params, req }) => {
      const run = named(params.run, "run");
      const { text, agent, id } = await readJsonBody(req, MAX_JSON);
      if (typeof text !== "string") throw new Refused(400, "text?");
      // Sent again (a lost answer, a handover): delivered once. Noted first, and forgotten if
      // it couldn't be written, so that the next try writes it.
      const key = id && `sent/${run}/${named(id, "id")}`;
      if (key && !(await store.setIfAbsent(key, true, { ttlMs: SENT_TTL_MS }))) {
        return { sent: false };
      }
      try {
        runner.send(run, text, agentFor(agent ?? undefined));
      } catch (error) {
        if (key) await store.delete(key);
        throw error;
      }
      return { sent: true };
    },
    "POST /runs/:run/close": async ({ params }) => {
      runner.close(named(params.run, "run"));
      return {};
    },
    "GET /runs/:run/closed": async ({ params }) => ({
      closed: runner.closed(named(params.run, "run")),
    }),
    "GET /runs/:run/inbox": async ({ params, url, res }) => {
      const from = Number(url.searchParams.get("from") ?? 0);
      if (!Number.isSafeInteger(from) || from < 0) throw new Refused(400, "from: a byte offset");
      const timeout = Math.min(Number(url.searchParams.get("timeout")) || 0, MAX_WAIT_MS);
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      const lines = await runner.poll(named(params.run, "run"), from, {
        timeout,
        signal: gone.signal,
      });
      if (lines === null) throw new Refused(404, "no inbox");
      res.writeHead(200, { "content-type": "application/x-ndjson" }).end(lines);
    },
    "GET /runs/:run/files/:name": async ({ params, res }) => {
      const data = runner.file(named(params.run, "run"), params.name);
      if (data === null) throw new Refused(404, `no ${params.name}`);
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
    },
    "GET /addresses/:ip": async ({ params }) => ({
      at: (await runner.locate?.(params.ip)) ?? null,
    }),
    "GET /proxy-addresses": async ({ url }) => ({
      addresses: await runner.proxyAddresses({ fresh: url.searchParams.get("fresh") === "1" }),
    }),
    "GET /egress": async ({ url }) => ({
      answer: await images.egressFor(url.searchParams.get("ip"), url.searchParams.get("host")),
    }),
    "POST /relink": async () => {
      await runner.relink();
      return {};
    },
    "POST /images": async ({ req, res }) => {
      const asked = await readJsonBody(req, MAX_JSON);
      // What the grants allow, whatever the orchestrator asks; and what it builds from, the
      // runner's to decide: the default branch unless a branch is granted, the Dockerfile's
      // blob as GitHub says it, the hosts the grants give (hooks.mjs).
      const problem = await buildProblem(config, asked, grants, granted);
      if (problem) throw new Refused(403, `no build: ${problem}`);
      const plan = await buildPlan(config, asked, { grants, blobOf });
      return streamed(res, async (output, line) => {
        const build = (planned) =>
          images.imageFor({
            ...planned,
            output,
            onBuild: (tag) => line({ type: "building", tag }),
          });
        try {
          return await build(plan);
        } catch (error) {
          if (error.code !== "DOCKERFILE_MOVED") throw error;
          // Its files hold another Dockerfile than the one its blob was looked up for: a push
          // in between, most often (the default branch moves). Planned again, once.
          log(`${asked.repo}: ${error.message}: looked up again`);
          return build(await buildPlan(config, asked, { grants, blobOf }));
        }
      });
    },
    "POST /agents/:agent/install": ({ params, res }) =>
      streamed(res, async (output) => {
        await images.installAgent(agentFor(params.agent), output);
      }),
    "POST /caches": async ({ req }) => {
      const { repo, paths = [], image } = await readJsonBody(req, MAX_JSON);
      // Prepared as root in `image`: the base image or the repository's own, at the paths its
      // config may name (spec-check.mjs, repo-config.mjs cacheProblem()).
      if (!validRepo(repo)) throw new Refused(400, "repo?");
      if (!ownImage(config, repo, image))
        throw new Refused(403, `the image ${image}: not ${repo}'s`);
      if (!Array.isArray(paths) || paths.some((p) => !plainPath(p) || cacheProblem(p))) {
        throw new Refused(400, "paths?");
      }
      return { caches: await images.caches(repo, paths, image) };
    },
    "POST /previews": async ({ req, res }) => {
      // The repository and the event only: its command and image are read here (hooks.mjs).
      const { id, repo, event, payload } = await readJsonBody(req, MAX_JSON);
      if (!validRepo(repo)) throw new Refused(400, "repo?");
      const problem = previewEventProblem(repo, event, payload);
      if (problem) throw new Refused(400, problem);
      // Refused now when the grants don't allow it; the config is read once queued.
      if (!(await previewsGranted(repo))) {
        throw new Refused(403, `${repo}: ${notGranted("preview")}`);
      }
      // Sent again (its answer lost): queued once.
      if (
        id &&
        !(await store.setIfAbsent(`previews/${named(id, "id")}`, true, { ttlMs: SENT_TTL_MS }))
      ) {
        return send(res, 202, {});
      }
      // Queued: it may build an image and run for minutes; why it didn't, logged here.
      previewJob(
        config,
        { repo, event, payload },
        { checkout, imageFor: images.imageFor, grants, granted },
      )
        .then((job) => previews.run(job))
        .catch((error) => log(`${repo}: preview hook not run: ${error.message}`));
      send(res, 202, {});
    },
    "GET /previews": () => previews.status(),
    "GET /logs/:id": async ({ params, url, res, req }) => {
      const id = params.id;
      if (!validLogId(id)) throw new Refused(400, "id?");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Refused(400, "offset?");
      const asked = url.searchParams.get("length");
      const length = asked === null ? undefined : Number(asked);
      if (length !== undefined && !(Number.isSafeInteger(length) && length > 0)) {
        throw new Refused(400, "length?");
      }
      const wait = Math.min(Number(url.searchParams.get("wait")) || 0, MAX_WAIT_MS);
      const gone = new AbortController();
      streams.add(res);
      res.on("close", () => (streams.delete(res), gone.abort()));
      req.on("close", () => gone.abort());
      const { size, data } = await logs.read(id, { offset, length, wait, signal: gone.signal });
      res
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "x-log-size": String(size),
        })
        .end(data);
    },
    "POST /logs/:id": async ({ params, url, req }) => {
      if (!validLogId(params.id)) throw new Refused(400, "id?");
      const at = Number(url.searchParams.get("at"));
      if (!Number.isSafeInteger(at) || at < 0) throw new Refused(400, "at: a byte offset");
      let data;
      try {
        data = await readBody(req, MAX_APPEND);
      } catch {
        throw new Refused(413, `an append over ${MAX_APPEND} bytes`);
      }
      try {
        return { size: await logs.append(params.id, at, data) };
      } catch (error) {
        if (error instanceof LogConflict) {
          throw Object.assign(new Refused(409, error.message), { size: error.size });
        }
        throw error;
      }
    },
    "DELETE /logs/:id": async ({ params }) => {
      if (!validLogId(params.id)) throw new Refused(400, "id?");
      return { removed: await logs.remove(params.id) };
    },
    "GET /events": async () => events.read(),
    "POST /events/ack": async ({ req }) => {
      const { ids } = await readJsonBody(req, MAX_JSON);
      return { acked: await events.ack(Array.isArray(ids) ? ids.map(String) : []) };
    },
    "POST /logins/antigravity/refresh": async ({ req }) => {
      if (!refresh) throw new Refused(501, `the ${config.runner} runner runs no login refresh`);
      const { input } = await readJsonBody(req, MAX_JSON);
      if (typeof input !== "string") throw new Refused(400, "input?");
      return refresh(input);
    },
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://runner");
    if (url.pathname === "/health") return sendJson(res, { ok: true, active: lease.active() });
    // The readiness probe's: only the copy that acts takes calls (Kubernetes' Service).
    if (url.pathname === "/ready") {
      return lease.active() && !stopping
        ? sendJson(res, { ready: true })
        : sendJson(res, { ready: false }, 503);
    }
    try {
      const caller = guard(req);
      if (!lease.active()) throw new Refused(503, "not the active runner: its other copy is");
      if (stopping) throw new Refused(503, "stopping: its other copy takes over");
      const found = table.find(({ match }) => match(req.method, url.pathname));
      const params = found?.match(req.method, url.pathname);
      if (caller === "orchestrator" && !UNFENCED.has(found?.key)) await fence(req);
      if (!found) throw new Refused(404, "no such endpoint");
      const value = await handlers[found.key]({ req, res, url, params, caller });
      if (!res.headersSent && value !== undefined) sendJson(res, value);
    } catch (error) {
      if (res.headersSent) {
        log(`${req.method} ${url.pathname}: ${error.stack ?? error}`);
        return res.destroy();
      }
      if (error instanceof Refused) {
        return sendJson(
          res,
          { message: error.message, ...(error.size !== undefined && { size: error.size }) },
          error.status,
        );
      }
      log(`${req.method} ${url.pathname}: ${error.stack ?? error}`);
      sendJson(res, { message: error.message ?? String(error) }, 500);
    }
  }

  const server = drainable(createServer((req, res) => void handle(req, res)));
  let stopping = false;
  let watching = null;

  return {
    server,
    events,
    // Once this copy acts: what sandboxes did meanwhile goes to the events.
    activate() {
      clearInterval(watching);
      watching = setInterval(
        () => events.watch().catch((error) => log(`Run events: ${error.message}`)),
        watchMs,
      );
      watching.unref?.();
      return events.watch().catch((error) => log(`Run events: ${error.message}`));
    },
    deactivate() {
      clearInterval(watching);
      watching = null;
    },
    // SIGTERM: output streams end now (their callers follow again, from the next copy), the
    // other calls finish, then the lease goes to the other copy at once: a preview hook needs
    // none. The hooks running still end here, within what is left of `graceMs`, and are cut
    // (killed, removed) past it; those waiting are dropped, logged (previews.mjs drain()).
    async stop({ graceMs = DRAIN_MS } = {}) {
      stopping = true;
      const deadline = now() + graceMs;
      clearInterval(watching);
      for (const res of streams) res.destroy();
      const hooks = Promise.resolve(previews.drain?.()).then(() => true);
      const calls = await drain(server, { graceMs });
      await lease.stop();
      let timer;
      const ran = await Promise.race([
        hooks,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - now()));
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (!ran) {
        log("Stopping: a preview hook still running at the end of the grace period, cut");
        await previews.cut?.();
      }
      return calls && ran;
    },
  };
}
