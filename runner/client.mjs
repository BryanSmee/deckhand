// The runner service as its callers see it (#503): the same interfaces the listener had from the
// backends in process (../listener/runner/docker.mjs's runner, ../listener/images.mjs's images),
// over its API (service.mjs), plus the runs' logs and events
// it keeps. Each part calls as the service it is for, with that service's token: the
// orchestrator drives runs (with its fencing epoch), reads their logs (the dashboard's live view,
// which edge passes on, #506) and asks where addresses are, for its egress policy (without its
// epoch); models has the Antigravity login refreshed.
//
// The runner away (updating, handing over to its other copy) is waited for, not taken for a
// failure: lib/service-client.mjs tries again. The egress policy's questions wait less, and fall
// back on the runner's last answer: a sandbox's calls go on while the runner updates.
import { randomBytes } from "node:crypto";
import { serviceClient } from "../lib/service-client.mjs";
import { LOGIN_REFRESH_MARGIN_MS, MIN_REFRESH_MS } from "../lib/services.mjs";

// What the orchestrator waits for the runner, for the calls a run's life needs: an update of
// the runner, a slow pull of its image. A run doesn't fail for it.
const RUN_WAIT_MS = 30 * 60_000;
// The egress policy's lookups, which a sandbox's connection waits on.
const POLICY_WAIT_MS = 10_000;
// A log append's most.
const APPEND_MAX = 4 * 1024 * 1024;
// After a failed append, the next try.
const APPEND_RETRY_MS = 5000;
// The longest pause between two tries of a call (../lib/service-client.mjs maxRetryMs's
// default): what the login's refresh keeps of its lease for the last one.
const REFRESH_RETRY_MAX_MS = 5000;

const path = (...parts) => parts.map((p) => encodeURIComponent(p)).join("/");

async function failure(res, what) {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    message = JSON.parse(text).message ?? text;
  } catch {
    // As it came.
  }
  const error = new Error(`${what}: ${res.status} ${String(message).slice(0, 500)}`);
  error.status = res.status;
  return error;
}

// Lines of NDJSON as they come, each parsed, to `each`. Resolves once the body ends: whether
// it ended as it should is the caller's to tell (its last line).
async function ndjson(res, each) {
  let rest = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body ?? []) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop();
    for (const line of lines) if (line) each(JSON.parse(line));
  }
  if (rest) each(JSON.parse(rest));
}

// `token(service)`: the Authorization header the caller has for the runner as that service;
// `epoch()`: the orchestrator's fencing epoch; `pendingTokens`: run → tokens(sandbox), the first tokens
// of the runs being started, which the orchestrator gives the runner when it asks (its broker
// service signs them, ../listener/services-http.mjs).
export function createRunnerClient({
  urls,
  token,
  epoch,
  pendingTokens = new Map(),
  fetch = globalThis.fetch,
  log = () => {},
  now = Date.now,
  sleep,
  runWaitMs = RUN_WAIT_MS,
  policyWaitMs = POLICY_WAIT_MS,
}) {
  const as = (service, extra = {}) =>
    serviceClient({
      service: "runner",
      urls,
      token: () => token(service),
      fetch,
      log,
      now,
      ...(sleep && { sleep }),
      ...extra,
    });
  const orchestrator = as("orchestrator", { epoch, waitMs: runWaitMs });
  // The egress policy's lookups (runner/service.mjs UNFENCED): as the orchestrator, without its
  // epoch, so an orchestrator stopping still has them answered.
  const policy = as("orchestrator", { waitMs: policyWaitMs });
  const models = as("models");

  // --- Sandboxes ----------------------------------------------------------------------------

  async function start(spec) {
    const { tokens, ...sent } = spec;
    if (tokens) pendingTokens.set(spec.run, tokens);
    try {
      const { existing, ...started } = await orchestrator.json("POST", "/sandboxes", {
        body: sent,
      });
      if (existing) log(`${spec.name}: started already, by the runner's other copy`);
      return started;
    } catch (error) {
      // Why the sandbox didn't start (Docker's, its network's, its spec's): what the run's
      // reply says.
      if ([403, 500].includes(error.status) && error.reason) throw new Error(error.reason);
      throw error;
    } finally {
      if (pendingTokens.get(spec.run) === tokens) pendingTokens.delete(spec.run);
    }
  }

  const list = () => orchestrator.json("GET", "/sandboxes");
  const state = async (name) => (await orchestrator.json("GET", `/sandboxes/${path(name)}`)).state;

  // Its output, line by line, until it exits or the stream ends (the runner updating): the
  // caller follows again with what it read as `skip` (../listener/runs.mjs follow()), as when
  // `docker logs` ends. Never throws: a runner away is said, and comes back.
  async function follow(name, { skip = { out: 0, err: 0 }, onOut, onErr, onCaughtUp = () => {} }) {
    try {
      const res = await orchestrator.request(
        "GET",
        `/sandboxes/${path(name)}/output?out=${skip.out}&err=${skip.err}`,
      );
      if (!res.ok) throw await failure(res, "its output");
      await ndjson(res, ({ s, line, at, caughtUp }) => {
        try {
          if (caughtUp) onCaughtUp();
          else (s === "err" ? onErr : onOut)(line, at ?? null);
        } catch (error) {
          log(`The output of ${name}: ${error.stack ?? error}`);
        }
      });
    } catch (error) {
      log(`The output of ${name}: ${error.message ?? error}`);
    }
  }

  // Messages and the close of a run's inbox, in the order they are asked, each until the
  // runner takes it. A message keyed, so that one sent again is delivered once.
  const chains = new Map(); // run → its last call
  function inOrder(run, call) {
    const done = (chains.get(run) ?? Promise.resolve()).then(call).catch((error) => {
      log(`The inbox of ${run}: ${error.message ?? error}`);
    });
    chains.set(run, done);
    done.then(() => chains.get(run) === done && chains.delete(run));
    return done;
  }

  function send(run, text, agent) {
    const id = randomBytes(12).toString("hex");
    return inOrder(run, () =>
      orchestrator.json("POST", `/runs/${path(run)}/messages`, {
        body: { text, agent: agent?.name, id },
      }),
    );
  }

  const close = (run) => inOrder(run, () => orchestrator.json("POST", `/runs/${path(run)}/close`));
  const closed = async (run) => {
    await chains.get(run);
    return (await orchestrator.json("GET", `/runs/${path(run)}/closed`)).closed;
  };

  // Until it exits: asked every second rather than one call held open (a drain would wait on
  // it).
  async function wait(name) {
    while ((await state(name)) === "running") await (sleep ?? delay)(1000);
  }

  const kill = (name) => orchestrator.json("POST", `/sandboxes/${path(name)}/kill`);
  const remove = async (name, run) => {
    await orchestrator.json(
      "DELETE",
      `/sandboxes/${path(name)}${run ? `?run=${encodeURIComponent(run)}` : ""}`,
    );
    // Its network is gone: an address the broker kept for it may be another run's now.
    known.clear();
  };
  const hasSession = async (name, agent) =>
    (
      await orchestrator.json(
        "GET",
        `/sessions/${path(name)}${agent ? `?agent=${encodeURIComponent(agent.name)}` : ""}`,
      )
    ).exists;
  // A chat's volumes (`task`: its key), once its sandbox is gone: its reset, its deletion.
  const removeSessions = async (name, task) =>
    (await orchestrator.json("DELETE", `/sessions/${path(name)}?task=${encodeURIComponent(task)}`))
      .removed;
  const relink = () => orchestrator.json("POST", "/relink");

  // --- The broker's questions ----------------------------------------------------------------

  // The last answers, for while the runner doesn't answer: a sandbox's address names the same
  // network until its run is removed (remove() forgets them), the proxy's addresses change only
  // when it is recreated.
  const known = new Map(); // ip → { sandbox, name }
  let proxy = [];

  async function locate(ip) {
    try {
      const { at } = await policy.json("GET", `/addresses/${path(ip)}`);
      if (at) known.set(ip, at);
      else known.delete(ip);
      return at;
    } catch (error) {
      if (!known.has(ip)) log(`Where ${ip} is: ${error.message}`);
      return known.get(ip) ?? null;
    }
  }

  // Asked on each of the broker's calls: kept a second, as the runner keeps them longer.
  let proxyAt = -Infinity;
  async function proxyAddresses({ fresh = false } = {}) {
    if (!fresh && now() - proxyAt < 1000) return proxy;
    try {
      ({ addresses: proxy } = await policy.json(
        "GET",
        `/proxy-addresses${fresh ? "?fresh=1" : ""}`,
      ));
      proxyAt = now();
    } catch (error) {
      log(`The egress proxy's addresses: ${error.message}`);
    }
    return proxy;
  }

  // null: the runner couldn't tell (the egress policy then allows what both may reach).
  const installing = async (name) => {
    try {
      return (await policy.json("GET", `/sandboxes/${path(name)}/installing`)).installing;
    } catch {
      return null;
    }
  };

  async function egressFor(ip, host) {
    try {
      const query = `ip=${encodeURIComponent(ip)}&host=${encodeURIComponent(host)}`;
      return (await policy.json("GET", `/egress?${query}`)).answer ?? null;
    } catch (error) {
      log(`Egress for ${ip}: ${error.message}`);
      return null;
    }
  }

  // --- Images, agents, caches ----------------------------------------------------------------

  let about = null; // GET /info, once it answered
  async function info() {
    about ??= await orchestrator.json("GET", "/info");
    return about;
  }

  // A build's or an install's NDJSON: its output to `output`, a tag being built to `onBuild`,
  // then its value, or its error thrown. A stream cut before its end (the runner updating) is
  // asked again: the next copy finds the image built, or builds it.
  async function streamed(what, url, body, { output = () => {}, onBuild = () => {} } = {}) {
    for (let tries = 1; ; tries++) {
      const res = await orchestrator.request("POST", url, { body });
      if (!res.ok) throw await failure(res, what);
      let end = null;
      try {
        await ndjson(res, (line) => {
          if (line.type === "output") output(Buffer.from(line.data, "base64"));
          else if (line.type === "building") onBuild(line.tag);
          else end = line;
        });
      } catch (error) {
        log(`${what}: ${error.message}`);
      }
      if (end?.type === "done") return end.value;
      if (end?.type === "error") throw new Error(end.message);
      if (tries >= 3) throw new Error(`${what}: the runner's answer was cut, ${tries} times`);
      log(`${what}: the runner's answer was cut, asking again`);
    }
  }

  // What it is built from (the Dockerfile's blob, the ref, the hosts) the runner decides, from
  // the grants and the github service (../runner/builds.mjs buildPlan()): this asks.
  const imageFor = ({ repo, ref, branch = false, dockerfile, onBuild, output, access }) =>
    streamed(
      `the image of ${repo}`,
      "/images",
      { repo, ref, branch, dockerfile, access },
      { output, onBuild },
    );

  const installAgent = (agent, output) =>
    streamed(`installing ${agent.displayName}`, `/agents/${path(agent.name)}/install`, undefined, {
      output,
    });

  const caches = async (repo, paths, image) =>
    (await orchestrator.json("POST", "/caches", { body: { repo, paths, image } })).caches;

  // --- Logs ----------------------------------------------------------------------------------

  // { size, data } from `offset`, waiting up to `wait` ms for more.
  async function readLog(id, { offset = 0, length, wait = 0, caller = orchestrator, signal } = {}) {
    const query = `offset=${offset}${length ? `&length=${length}` : ""}${wait ? `&wait=${wait}` : ""}`;
    const res = await caller.request("GET", `/logs/${path(id)}?${query}`, { signal });
    if (!res.ok) throw await failure(res, `the log of ${id}`);
    return {
      size: Number(res.headers.get("x-log-size")),
      data: Buffer.from(await res.arrayBuffer()),
    };
  }

  // A run's whole log, as text (a digest of it, a summary of a run that has none).
  async function logText(id) {
    const parts = [];
    for (let offset = 0; ;) {
      const { size, data } = await readLog(id, { offset, caller: orchestrator });
      parts.push(data);
      offset += data.length;
      if (!data.length || offset >= size) break;
    }
    return Buffer.concat(parts).toString("utf8");
  }

  // `data` at `at`, once: → the log's size after it, or { conflict: size } when the runner's
  // log is another size (an append lost, a log removed meanwhile), which the writer goes on
  // from. Any other refusal (a stale epoch: another listener writes now) is an error. `step`:
  // it starts a step of the run, `close`: the run's end (../runner/logs.mjs, its segments).
  async function append(id, at, data, { step = false, close = false } = {}) {
    const marks = `${step ? "&step=1" : ""}${close ? "&close=1" : ""}`;
    const res = await orchestrator.request("POST", `/logs/${path(id)}?at=${at}${marks}`, {
      body: data,
      headers: { "content-type": "application/octet-stream" },
    });
    if (res.ok) return (await res.json()).size;
    if (res.status === 409) {
      const text = await res.text();
      let size;
      try {
        ({ size } = JSON.parse(text));
      } catch {
        // Said below.
      }
      if (Number.isSafeInteger(size)) return { conflict: size };
      const error = new Error(`the log of ${id}: 409 ${text.slice(0, 300)}`);
      error.status = 409;
      throw error;
    }
    throw await failure(res, `the log of ${id}`);
  }

  // What the orchestrator writes a run's log through (../listener/runlog.mjs openLog()'s
  // shape): write() at once, in order, sent as it can be; `size` what it holds, the writes
  // not sent yet counted. `size: null`: a log written before (a run picked up after a
  // restart), its size asked first (ready). flushed(): once what was written is sent, or its try
  // failed.
  // write(text, { step: true }): a step of the run starts with it (a phase's line), sent at the
  // start of an append of its own, so that the runner's segment closes before it. close(): the
  // run is over, its last segment closed once what was written is sent.
  function openRemote(id, { size = 0 } = {}) {
    let sent = size ?? 0; // what the runner holds
    let queued = [];
    let pending = 0;
    let flushing = null;
    // A chunk whose answer was lost: sent again alone, so that the runner, which may have
    // taken it, recognises it (the same offset, the same length).
    let retrying = null;
    const ready =
      size === null
        ? readLog(id, { offset: 0, length: 1, caller: orchestrator })
            .then((found) => (sent = found.size))
            .catch((error) => log(`The log of ${id}: ${error.message}`))
        : Promise.resolve();

    // The next append: { data, step, close }. A step starts one, a close ends one.
    function next() {
      if (retrying) return retrying;
      const first = queued.shift();
      const chunks = [first.data];
      let bytes = first.data.length;
      let close = first.close;
      while (!close && queued.length && !queued[0].step) {
        if (bytes + queued[0].data.length > APPEND_MAX) break; // one write over the most: alone
        const write = queued.shift();
        bytes += write.data.length;
        chunks.push(write.data);
        close = write.close;
      }
      return { data: Buffer.concat(chunks), step: first.step, close };
    }

    async function flush() {
      await ready;
      while (retrying || queued.length) {
        const chunk = next();
        const { data } = chunk;
        retrying = null;
        try {
          const after = await append(id, sent, data, chunk);
          if (typeof after !== "number") {
            // Taken already (its answer lost), or the runner's log is another size.
            if (after.conflict !== sent + data.length) {
              log(
                `The log of ${id}: ${after.conflict} bytes at the runner, ${sent} here: going on from its end`,
              );
              sent = after.conflict;
              retrying = chunk;
              continue;
            }
          }
          sent = typeof after === "number" ? after : after.conflict;
          pending -= data.length;
        } catch (error) {
          // Kept, and tried again: the run's log loses nothing for a runner away a while.
          retrying = chunk;
          log(`The log of ${id}: ${error.message}, trying again`);
          await (sleep ?? delay)(APPEND_RETRY_MS);
          return false;
        }
      }
      return true;
    }

    function kick() {
      flushing ??= flush().finally(() => {
        flushing = null;
        if (retrying || queued.length) kick();
      });
      return flushing;
    }

    return {
      write(text, { step = false } = {}) {
        const data = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
        queued.push({ data, step, close: false });
        pending += data.length;
        kick();
      },
      close() {
        queued.push({ data: Buffer.alloc(0), step: false, close: true });
        kick();
      },
      get size() {
        return sent + pending;
      },
      ready,
      // Whether all of it is at the runner: none sent but in flight still counts.
      flushed: () => (flushing ?? Promise.resolve(true)).then(() => pending === 0),
    };
  }

  const removeLog = async (id) => (await orchestrator.json("DELETE", `/logs/${path(id)}`)).removed;

  // --- Run events, the Antigravity login -----------------------------------------------------

  const events = {
    read: () => orchestrator.json("GET", "/events"),
    ack: (ids) => orchestrator.json("POST", "/events/ack", { body: { ids } }),
  };

  // `agy models` on the login's volume (../models/antigravity-login.mjs): { code, out, err }.
  // Once: its refresh token is spent by the first. `timeoutMs`: what is left of the models
  // service's lease on the login, which the runner ends its job within. A runner that doesn't
  // answer (a handover's 503s, a refused connection: the call never reached it) is asked again,
  // its next copy first, each try saying what is left of the lease at that moment, and none
  // once too little is for the runner to start the job: the last retry goes out at most
  // REFRESH_RETRY_MAX_MS after the client's wait.
  function refreshLogin(input, { timeoutMs } = {}) {
    const route = "/logins/antigravity/refresh";
    if (timeoutMs === undefined) return models.json("POST", route, { body: { input }, once: true });
    const until = now() + timeoutMs;
    return models.json("POST", route, {
      body: () => ({ input, timeoutMs: until - now() }),
      once: true,
      waitMs: Math.max(
        0,
        timeoutMs - LOGIN_REFRESH_MARGIN_MS - MIN_REFRESH_MS - REFRESH_RETRY_MAX_MS,
      ),
    });
  }

  return {
    runner: {
      start,
      list,
      state,
      follow,
      send,
      close,
      closed,
      wait,
      kill,
      remove,
      hasSession,
      removeSessions,
      relink,
      proxyAddresses,
      locate,
      installing,
    },
    images: {
      imageFor,
      installAgent,
      caches,
      info,
      egressFor,
    },
    logs: { open: openRemote, read: readLog, text: logText, remove: removeLog },
    events,
    refreshLogin,
    info,
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
