// The dashboard's API and /status, passed on to the orchestrator (#506) on its
// services port, under /edge/, with edge's service token and who asks: the signed-in user
// (USER_HEADER), or a local caller of /status (LOCAL_HEADER). The orchestrator takes those
// headers from edge alone (its token, on their network). Its answer comes back as it streams
// (a run's live log). The orchestrator handing over to its other copy is waited for, a little:
// the dashboard polls again anyway.
import { Readable } from "node:stream";
import { serviceClient } from "../lib/service-client.mjs";

export const USER_HEADER = "x-deckhand-user";
export const LOCAL_HEADER = "x-deckhand-local";
// What sameOrigin() reads of the browser's request (../listener/web.mjs): fetch() sets its own
// Host, so the browser's goes in a header of its own.
export const HOST_HEADER = "x-deckhand-host";
export const ORIGIN_HEADER = "x-deckhand-origin";

// What the browser sent that the orchestrator's routes read.
const PASSED = ["content-type", "accept", "last-event-id"];
// What the orchestrator answered that the browser reads.
const BACK = ["content-type", "cache-control", "x-accel-buffering", "location", "retry-after"];

// A handover takes about a second; an orchestrator away longer answers 503 here.
const WAIT_MS = 15_000;
// How often a streaming answer's user is asked about again.
const STILL_MS = 1000;

// `urls`: ORCHESTRATOR_URL; `token()`: edge's Authorization header for the orchestrator.
// `stream()`: called as a live log starts streaming, → what its end calls (metrics.mjs's).
export function createForwarder({
  urls,
  token,
  fetch = globalThis.fetch,
  waitMs = WAIT_MS,
  stream = () => () => {},
  log,
}) {
  const client = serviceClient({ service: "orchestrator", urls, token, fetch, waitMs, log });

  // `body`: the request's, read already (a Buffer), or none. `still()`: whether its user is
  // still signed in, asked every second while an answer streams (a run's live log): signed out,
  // the stream ends.
  async function forward(req, res, { user = null, local = false, body, still = null } = {}) {
    const headers = {};
    for (const name of PASSED) if (req.headers[name]) headers[name] = req.headers[name];
    if (req.headers.host) headers[HOST_HEADER] = req.headers.host;
    if (req.headers.origin) headers[ORIGIN_HEADER] = req.headers.origin;
    if (user) headers[USER_HEADER] = user;
    if (local) headers[LOCAL_HEADER] = "1";
    // A browser gone: the orchestrator's answer (a live log) stops too.
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    let answer;
    try {
      answer = await client.request(req.method, `/edge${req.url}`, {
        body: body?.length ? body : undefined,
        headers,
        signal: gone.signal,
        // Tried again only when it never reached the orchestrator: a post isn't made twice.
        once: req.method !== "GET",
      });
    } catch (error) {
      if (gone.signal.aborted) return;
      log(`The orchestrator: ${req.method} ${req.url.split("?")[0]}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
        res.end(JSON.stringify({ error: "Deckhand's orchestrator didn't answer: try again." }));
      }
      return;
    }
    const back = {};
    for (const name of BACK) {
      const value = answer.headers.get(name);
      if (value !== null) back[name] = value;
    }
    res.writeHead(answer.status, back);
    if (!answer.body) return res.end();
    // Not when the browser left already: its close came, and won't again.
    if (back["content-type"]?.startsWith("text/event-stream") && !res.destroyed) {
      res.once("close", stream());
    }
    if (still && back["content-type"]?.startsWith("text/event-stream")) {
      const checking = setInterval(async () => {
        if (await Promise.resolve(still()).catch(() => false)) return;
        clearInterval(checking);
        gone.abort();
        res.end();
      }, STILL_MS);
      res.on("close", () => clearInterval(checking));
    }
    Readable.fromWeb(answer.body)
      .on("error", () => res.destroy())
      .pipe(res);
  }

  return { forward };
}
