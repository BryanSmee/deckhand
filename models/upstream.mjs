// What the models service's API endpoints share (anthropic.mjs, openai.mjs, google.mjs): a
// sandbox's call goes on to the provider with the operator's credential in place of the run's
// agent token, and the answer streams back as it comes (../lib/upstream.mjs forward()).
import { redact } from "../lib/redact.mjs";
import { AGENT_AUDIENCE } from "../lib/tokens.mjs";
import { sendJson } from "../lib/http.mjs";
import { forward, forwarded, IDLE_MS, MAX_IN_FLIGHT } from "../lib/upstream.mjs";
import { statusOf, usageTap } from "./metrics.mjs";

export { baseOf, IDLE_MS, MAX_IN_FLIGHT } from "../lib/upstream.mjs";

// A run's id → its calls in flight through this copy, shared by every endpoint: two copies
// take up to twice as many.
const inFlight = new Map();
// The refused calls a run's log and the service's log note, each once and only so many: a
// sandbox looping on one mustn't grow its log past RUN_LOG_MAX_MB (writeEvent() isn't capped).
export const MAX_NOTED = 20;
// A run's id → the refused calls noted for it, for the last MAX_RUNS_NOTED runs.
const noted = new Map();
const MAX_RUNS_NOTED = 1000;

// Notes `call` once per run, and up to MAX_NOTED of them; then a line saying the rest aren't.
function noteRefused(run, call, notApi, log, what) {
  const seen = noted.get(run.id) ?? new Set();
  if (!noted.has(run.id) && noted.size >= MAX_RUNS_NOTED) noted.delete(noted.keys().next().value);
  noted.set(run.id, seen);
  if (seen.has(call) || seen.size > MAX_NOTED) return;
  seen.add(call);
  if (seen.size > MAX_NOTED) {
    run.note?.(`Deckhand refused more of the agent's calls: only the first ${MAX_NOTED} are noted`);
    return;
  }
  run.note?.(`Deckhand refused the agent's call ${call}: ${notApi}`);
  log(`${what}: refused ${call}`);
}

// What a sandbox and a run's reply learn of a credential the models service couldn't use: a fixed
// text per kind, never the error's message, which may quote a credential file (#242). 401: a
// login unusable until the operator acts (agents/ providerError()), `refused` when signing in
// again is what fixes it (chatgpt.mjs, antigravity-login.mjs).
export function credentialFailure(what, error) {
  const why = error.refused
    ? "was refused, and must be signed in again"
    : error.status === 401
      ? "can't be used"
      : "can't be refreshed right now";
  return `the operator's login for ${what} ${why}: see the models service's log`;
}

// A provider's endpoint: each call's run from its agent token, then where it goes and with which
// credential, then on to the provider. What differs between providers:
//
//   pathRe       the API paths a sandbox may call, the path under the base URL its first group:
//                no "//host", "https://host", "\\host" or ".." that would send the credential to
//                another host, or out of a base URL's path
//   routes       [method, RegExp] pairs: the calls the agent makes, that path matched whole.
//                Anything else (files, batches, stored responses) is refused: the operator's
//                credential opens more than the agent needs
//   errorShape   { body(type, message), auth, forbidden, unavailable, notFound, busy }: errors in the
//                provider's shape and its types for each, so the agent shows them as such
//   notApi       what a refused path says
//   secretOf     req → the run's agent token, from whichever header the agent sent it in
//   routeOf      run → { base, what, missing }: the provider's base URL (baseOf()), its name in
//                messages, and why the operator's credential is missing, if it is
//   drop         request headers the service sets rather than the sandbox
//   authHeaders  async (run) → the credential's headers; an error with a `status` (what a
//                fallback reads) refuses the call. Its message only goes to the service's log
//                (a token file's content, say): the sandbox and the run's reply get a fixed one
//   secrets      () → the credential's values, redacted from that log line
//   answered     (run, status, headers, answer): the provider's status, once it answers, with
//                the request's headers and the answer's
//   agent        whose calls they are (metrics.mjs AGENTS), and `metrics` what counts them
//                (metrics.mjs modelMetrics()'s): each call, its length, its tokens
export function createApiProxy({
  runs, // runs.mjs: the run an agent token belongs to
  pathRe,
  routes,
  errorShape,
  notApi,
  secretOf,
  routeOf,
  drop,
  authHeaders,
  answered = () => {},
  agent,
  metrics = null,
  secrets = () => [],
  log = () => {},
  maxInFlight = MAX_IN_FLIGHT,
  idleMs = IDLE_MS,
  clock = globalThis,
}) {
  const fail = (res, status, type, message) =>
    sendJson(res, errorShape.body(type, `Deckhand: ${message}`), status);
  // An agent may hide what its call got (the Antigravity CLI's "model … is not recognized"
  // when its model list failed, #224): the run's reply says it instead (runs.mjs).
  const failRun = (run, res, status, type, message) => {
    run.apiError = message;
    return fail(res, status, type, message);
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://models");
    // Before anything that writes to the run (its apiError, its notes): a leaked token
    // mustn't spend its budget, nor change what its reply says.
    const checked = await runs.check(secretOf(req), req, AGENT_AUDIENCE);
    const { run } = checked;
    if (!run) {
      const type = checked.status === 403 ? errorShape.forbidden : errorShape.auth;
      return fail(res, checked.status, type, checked.message);
    }
    const { base, what, missing } = routeOf(run);
    if (missing) return failRun(run, res, 503, errorShape.unavailable, missing);
    const path = pathRe.exec(req.url.split("?")[0])?.[1];
    if (!path || !routes.some(([method, re]) => method === req.method && re.test(path))) {
      // A newer agent that needs another path shows up in the run's log, not only as a 404.
      // The path is the sandbox's to choose: without the run's token or GitHub tokens, as its output.
      const call = redact(`${req.method} ${req.url.split("?")[0]}`, [
        secretOf(req),
        ...run.tokens,
        ...secrets(),
      ]).slice(0, 200);
      noteRefused(run, call, notApi, log, what);
      // A provider's failure before it stays what the reply quotes: the note has this one.
      if (run.failedIfUnset) run.failedIfUnset(notApi);
      else run.apiError ??= notApi;
      return fail(res, 404, errorShape.notFound, notApi);
    }
    // /openai/responses?x=1 → <base>/responses?x=1
    const target = new URL(base.href + path + url.search);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
      return fail(res, 404, errorShape.notFound, notApi);
    }
    const calls = inFlight.get(run.id) ?? 0;
    if (calls >= maxInFlight) {
      return fail(res, 429, errorShape.busy, `more than ${maxInFlight} calls at once`);
    }
    inFlight.set(run.id, calls + 1);
    try {
      await proxied(req, res, run, target, what);
    } finally {
      const left = inFlight.get(run.id) - 1;
      if (left) inFlight.set(run.id, left);
      else inFlight.delete(run.id);
    }
  }

  async function proxied(req, res, run, target, what) {
    const headers = forwarded(req.headers, drop);
    const provider = run.provider;
    try {
      Object.assign(headers, await authHeaders(run));
    } catch (error) {
      log(redact(`${what}: ${error.message}`, secrets()));
      run.apiStatus = error.status ?? 502;
      metrics?.called({ provider, agent, status: "credential" });
      return failRun(run, res, 503, errorShape.unavailable, credentialFailure(what, error));
    }
    // On `clock` when it has one (the tests'), its timers' seam.
    const elapsed = () => (clock.performance ?? performance).now();
    const started = elapsed();
    let status = null;
    let reader = null; // what a successful answer says it used, read as it goes on
    const how = await forward(req, res, {
      target,
      headers,
      unreachable: () => failRun(run, res, 502, errorShape.unavailable, `${what} can't be reached`),
      log,
      what,
      idleMs,
      clock,
      tap: (chunk) => reader?.write(chunk),
      answered: (code, answer, lost) => {
        status = statusOf(code, { lost });
        if (metrics && code < 300) reader = usageTap(answer);
        run.apiStatus = code;
        if (code >= 400) run.apiError = `${what} answered ${code}`;
        answered(run, code, headers, answer);
      },
    });
    // The agent gave up before an answer: no call of the provider's to count.
    if (status === null) return;
    metrics?.called({
      provider,
      agent,
      status,
      seconds: (elapsed() - started) / 1000,
      cut: how === "cut",
      used: await reader?.end(),
    });
  }

  return { handle };
}
