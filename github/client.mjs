// The github service (#502) as the listener calls it: its GitHub calls (the App's, which the
// listener's modules take as they took ../listener/github-app.mjs's: request(), asApp(),
// asInstallation()), the runs it tells the service of, its reactions, /setup's conversion and
// the key it held before, the service's events, and the relay of the sandboxes' calls that
// still reach the listener. Every call carries the orchestrator's service token, and its epoch.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { RUN_AUTH_HEADER, SANDBOX_HEADER } from "../lib/broker-client.mjs";
import { serviceClient, WAIT_MS } from "../lib/service-client.mjs";

// The same as service.mjs's: the client is copied into the listener's image without it.
export const GITHUB_STATUS = "x-github-status";
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const EXPECTED_HEADER = "x-deckhand-expected";

const RETRY_MS = 5_000;
const enc = encodeURIComponent;

// Statuses whose answer has no body (a Response refuses one).
const NO_BODY = new Set([101, 204, 205, 304]);

// `urls`: GITHUB_SERVICE_URL; `token()`: the orchestrator's Authorization header for it;
// `epoch()`: the orchestrator's fencing epoch.
export function createGithubClient({
  urls,
  token,
  epoch = () => null,
  fetch = globalThis.fetch,
  waitMs = WAIT_MS,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const client = serviceClient({ service: "github", urls, token, epoch, fetch, waitMs, log });
  const bases = String(urls)
    .split(",")
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter(Boolean);

  // GitHub's answer as fetch() would give it, from the service's: its status in GITHUB_STATUS.
  // Any other answer is the service's own refusal: thrown, with its status.
  async function github(method, path, { body, expected = [], key = null } = {}) {
    const res = await client.request(method, path, {
      body: body ?? undefined,
      // A write cut once sent may have been made: not sent again, but with its key.
      once: method !== "GET" && !key,
      headers: {
        ...(expected.length && { [EXPECTED_HEADER]: expected.join(",") }),
        ...(key && { [IDEMPOTENCY_HEADER]: key }),
      },
    });
    const status = res.headers.get(GITHUB_STATUS);
    if (status === null) {
      const text = await res.text().catch(() => "");
      let message = text.slice(0, 300);
      try {
        message = JSON.parse(text).message ?? message;
      } catch {
        // As it is.
      }
      throw Object.assign(new Error(`the github service: ${res.status} ${message}`), {
        status: res.status,
      });
    }
    const n = Number(status);
    if (NO_BODY.has(n) || method === "HEAD") {
      await res.body?.cancel();
      return new Response(null, { status: n, headers: res.headers });
    }
    return new Response(res.body, { status: n, headers: res.headers });
  }

  // The App as the listener's modules use it: `credentials`, the listener's own part of them
  // (the webhook secret, the OAuth client's, the App's names: never its key).
  function app(credentials) {
    return {
      credentials,
      // Commits come from the App's bot, as GitHub shows them for its own commits.
      identity() {
        const name = `${credentials.slug}[bot]`;
        const email = credentials.bot_id
          ? `${credentials.bot_id}+${name}@users.noreply.github.com`
          : `${name}@users.noreply.github.com`;
        return { name, email };
      },
      // The service finds a repo's installation and its permissions itself.
      remember() {},
      rememberPermissions() {},
      // `expected`: statuses normal for the call, not logged; `key`: the write's idempotency
      // key, when asking it again must not make it twice.
      request(repo, method, path, body, expected = [], { key = null } = {}) {
        const [owner, name] = String(repo).split("/").map(enc);
        if (method === "POST" && path === "/graphql") {
          return github("POST", `/graphql/${owner}/${name}`, { body, key });
        }
        return github(method, `/as/${owner}/${name}${path}`, { body, expected, key });
      },
      asApp: (method, path) => github(method, `/as-app${path}`),
      asInstallation: (id, method, path) => github(method, `/as-installation/${id}${path}`),
    };
  }

  // --- Runs, reactions, the App ------------------------------------------------------------

  const runs = {
    put: (id, fields) => client.json("PUT", `/runs/${enc(id)}`, { body: fields }),
    // → its { created, reruns }, or null when the service has no such run.
    async state(id) {
      try {
        return await client.json("GET", `/runs/${enc(id)}`, { waitMs: 10_000 });
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    end: async (id) => (await client.json("DELETE", `/runs/${enc(id)}`))?.state ?? null,
  };

  // The listener's reaction on `subject` of `repo` (github-writes.mjs reactionSubject()):
  // noted before GitHub is asked (`held`), forgotten once taken off.
  const claim = (repo, subject, content, held = true) =>
    client.json("PUT", "/reactions", { body: { repo, subject, content, held } });

  const setup = {
    info: () => client.json("GET", "/app", { waitMs: 10_000 }),
    // /setup's manifest code → the App's credentials but its key, which the service keeps.
    convert: (code) => client.json("POST", "/app/manifest", { body: { code }, once: true }),
    // A listener's App from before the service: its key goes there.
    handOver: (credentials) => client.json("PUT", "/app", { body: credentials }),
  };

  // --- The service's events ----------------------------------------------------------------

  let stopped = false;
  const timers = new Set();
  const sleep = (ms) =>
    new Promise((resolve) => {
      if (stopped) return resolve();
      const timer = setTimer(() => (timers.delete(timer), resolve()), ms);
      timer.unref?.();
      timers.add(timer);
    });

  // Its events, read and acknowledged one by one: `handlers`: type → (event) → a promise, done
  // once handled. One whose handling fails is read again.
  let consuming = null;
  function consume(handlers) {
    consuming ??= (async () => {
      while (!stopped) {
        try {
          const { events } = await client.json("GET", "/events?wait=20000");
          const done = [];
          for (const { id, event } of events) {
            try {
              await handlers[event?.type]?.(event);
              done.push(id);
            } catch (error) {
              log(`GitHub service: its ${event?.type} event (${error.message}), read again`);
            }
          }
          if (done.length) await client.json("POST", "/events/ack", { body: { ids: done } });
          if (done.length < events.length) await sleep(RETRY_MS);
        } catch (error) {
          if (stopped) break;
          log(`GitHub service: its events (${error.message}), asking again`);
          await sleep(RETRY_MS);
        }
      }
    })();
    return consuming;
  }

  // `fn()` until it resolves, again a little later each time it fails (`what` in the log).
  function persist(what, fn) {
    return fn().catch((error) => {
      if (stopped) return;
      log(`GitHub service: ${what} (${error.message}), trying again`);
      return sleep(RETRY_MS).then(() => !stopped && persist(what, fn));
    });
  }

  // --- Sandboxes that reach the listener rather than the service ----------------------------

  // A sandbox's GitHub or git call (`path`: /relay/<host>/… or /git/…, as checked), on to the
  // service with the network (or pod) `sandbox` the listener found it came from, as the proxy
  // would. Sent once connected: a service restarting is waited for (WAIT_MS), the body read
  // only then.
  async function relay(req, res, { sandbox, path }) {
    const authorization = await token();
    const headers = { ...req.headers };
    for (const name of ["host", "connection", "keep-alive", "proxy-authorization"]) {
      delete headers[name];
    }
    delete headers[SANDBOX_HEADER];
    delete headers[RUN_AUTH_HEADER];
    if (req.headers.authorization) headers[RUN_AUTH_HEADER] = req.headers.authorization;
    Object.assign(headers, { authorization, [SANDBOX_HEADER]: sandbox ?? "" });
    const started = Date.now();
    for (let i = 0; ; i++) {
      const url = new URL(path, `${bases[i % bases.length]}/`);
      const sent = await new Promise((resolve) => {
        const send = url.protocol === "https:" ? httpsRequest : httpRequest;
        const out = send(url, { method: req.method, headers, agent: false }, (answer) => {
          res.writeHead(answer.statusCode, answer.headers);
          answer.pipe(res);
          answer.on("end", () => resolve(true));
          answer.on("error", () => (res.destroy(), resolve(true)));
        });
        let connected = false;
        out.on("socket", (socket) =>
          socket.once("connect", () => {
            connected = true;
            req.pipe(out);
          }),
        );
        out.on("error", (error) => {
          if (!connected) return resolve(error);
          if (!res.headersSent) res.writeHead(502).end();
          else res.destroy();
          resolve(true);
        });
        res.on("close", () => !res.writableFinished && out.destroy());
      });
      if (sent === true) return;
      if (res.destroyed || Date.now() - started >= waitMs) {
        log(`GitHub service: a sandbox's call not relayed (${sent.code ?? sent.message})`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        return res.end("Deckhand: the github service can't be reached\n");
      }
      await sleep(Math.min(500 * 2 ** i, RETRY_MS));
    }
  }

  return {
    app,
    runs,
    claim,
    setup,
    consume,
    persist,
    relay,
    stop() {
      stopped = true;
      for (const timer of timers) clearTimer(timer);
      timers.clear();
    },
  };
}
