// What the listener's API endpoints share (anthropic.mjs, openai.mjs): a sandbox's call goes
// on to the provider with the operator's credential in place of the run's secret, and the
// answer streams back as it comes.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { redact } from "./redact.mjs";
import { sendJson } from "./web.mjs";

// Plans' credentials (`claude setup-token`, `codex login`, `agy`'s sign-in): logged at start,
// as the operator is responsible for how they are used, and a plan's terms may not cover a
// team's bot.
const PLANS = {
  CLAUDE_CODE_OAUTH_TOKEN: "a Claude plan's credential",
  CODEX_AUTH_FILE: "a ChatGPT plan's login",
  AGY_AUTH_FILE: "a Google AI plan's login",
};

export function planWarning(name) {
  if (!Object.hasOwn(PLANS, name ?? "")) return null;
  return `Warning: ${name} is ${PLANS[name]}. A subscription (Claude Pro/Max, a ChatGPT plan, Google AI Pro/Ultra) is usually licensed to one person. Serving a team, or repositories other people write to, may break your provider's terms: check them before you do. You are responsible for how your Deckhand uses your credential. For teams, use an API key.`;
}

// A call that gets no byte from the provider (or the agent) for this long is cut off.
export const IDLE_MS = 10 * 60_000;
// Calls one run may have in flight at once, through all of the listener's API endpoints.
export const MAX_IN_FLIGHT = 16;
// run (broker.mjs) → its calls in flight, shared by every endpoint.
const inFlight = new WeakMap();

// Per connection, or the listener's own business: never forwarded either way.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export function forwarded(headers, drop = []) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP.has(name) && !drop.includes(name)),
  );
}

// "https://api.openai.com/v1/" → its URL with a trailing slash, for paths relative to it.
export function baseOf(upstream) {
  return new URL(upstream.replace(/\/?$/, "/"));
}

// `req` to `target` with `headers`, its answer back to `res`. `unreachable()` answers when the
// provider can't be reached before anything was sent back. `answered(status)`: the provider's
// status, 502 when it can't be reached (what a fallback reads, agents/ providerError()).
// `idleMs`: how long the call may go without a byte either way before it is cut off, on
// `clock`'s timers: a stalled provider doesn't hold a listener every run shares.
export function forward(
  req,
  res,
  {
    target,
    headers,
    unreachable,
    log,
    what,
    answered = () => {},
    idleMs = IDLE_MS,
    clock = globalThis,
  },
) {
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done) => {
    let timer = null;
    const resolve = () => (clock.clearTimeout(timer), done());
    const out = send(target, { method: req.method, headers }, (answer) => {
      answered(answer.statusCode);
      res.writeHead(answer.statusCode, forwarded(answer.headers));
      // Server-sent events: each chunk goes on as it arrives.
      answer.on("data", idle);
      answer.pipe(res);
      answer.on("end", resolve);
      answer.on("error", () => (res.destroy(), resolve()));
    });
    const idle = () => {
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        out.destroy(new Error(`no bytes for ${Math.round(idleMs / 1000)} s`));
        // Already answering: the agent sees its stream end early, and may retry.
        if (res.headersSent) (res.destroy(), resolve());
      }, idleMs);
    };
    idle();
    req.on("data", idle);
    out.on("error", (error) => {
      log(`${what}: ${req.method} ${target.pathname}: ${error.message}`);
      if (!res.headersSent) {
        answered(502);
        unreachable();
      } else res.destroy();
      resolve();
    });
    // The agent gave up (an interrupt, the run's end): so does the request upstream.
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
      resolve();
    });
    req.pipe(out);
  });
}

// What a sandbox and a run's reply learn of a credential the listener couldn't use: a fixed
// text per kind, never the error's message, which may quote a credential file (#242). 401: a
// login unusable until the operator acts (agents/ providerError()), `refused` when signing in
// again is what fixes it (chatgpt.mjs, antigravity-login.mjs).
export function credentialFailure(what, error) {
  const why = error.refused
    ? "was refused, and must be signed in again"
    : error.status === 401
      ? "can't be used"
      : "can't be refreshed right now";
  return `the operator's login for ${what} ${why}: see the listener's log`;
}

// A provider's endpoint: each call's run from its secret, then where it goes and with which
// credential, then on to the provider. What differs between providers:
//
//   pathRe       the API paths a sandbox may call, the path under the base URL its first group:
//                no "//host", "https://host", "\\host" or ".." that would send the credential to
//                another host, or out of a base URL's path
//   routes       [method, RegExp] pairs: the calls the agent makes, that path matched whole.
//                Anything else (files, batches, stored responses) is refused: the operator's
//                credential opens more than the agent needs
//   errorShape   { body(type, message), auth, unavailable, notFound, busy }: errors in the
//                provider's shape and its types for each, so the agent shows them as such
//   notApi       what a refused path says
//   secretOf     req → the run's secret, from whichever header the agent sent it in
//   routeOf      run → { base, what, missing }: the provider's base URL (baseOf()), its name in
//                messages, and why the operator's credential is missing, if it is
//   drop         request headers the listener sets rather than the sandbox
//   authHeaders  async (run) → the credential's headers; an error with a `status` (what a
//                fallback reads) refuses the call. Its message only goes to the listener's log
//                (a token file's content, say): the sandbox and the run's reply get a fixed one
//   secrets      () → the credential's values, redacted from that log line
//   answered     (run, status, headers): the provider's status, once it answers
export function createApiProxy({
  broker, // broker.mjs: the run a secret belongs to
  pathRe,
  routes,
  errorShape,
  notApi,
  secretOf,
  routeOf,
  drop,
  authHeaders,
  answered = () => {},
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
    const url = new URL(req.url, "http://broker");
    const run = broker.runOf(secretOf(req));
    if (!run) return fail(res, 401, errorShape.auth, "unknown or finished run");
    const { base, what, missing } = routeOf(run);
    if (missing) return failRun(run, res, 503, errorShape.unavailable, missing);
    const path = pathRe.exec(req.url.split("?")[0])?.[1];
    if (!path || !routes.some(([method, re]) => method === req.method && re.test(path))) {
      // A newer agent that needs another path shows up in the run's log, not only as a 404.
      const call = `${req.method} ${req.url.split("?")[0]}`.slice(0, 200);
      run.note?.(`Deckhand refused the agent's call ${call}: ${notApi}`);
      log(`${what}: refused ${call}`);
      return failRun(run, res, 404, errorShape.notFound, notApi);
    }
    // /openai/responses?x=1 → <base>/responses?x=1
    const target = new URL(base.href + path + url.search);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
      return fail(res, 404, errorShape.notFound, notApi);
    }
    const calls = inFlight.get(run) ?? 0;
    if (calls >= maxInFlight) {
      return fail(res, 429, errorShape.busy, `more than ${maxInFlight} calls at once`);
    }
    inFlight.set(run, calls + 1);
    try {
      await proxied(req, res, run, target, what);
    } finally {
      inFlight.set(run, inFlight.get(run) - 1);
    }
  }

  async function proxied(req, res, run, target, what) {
    const headers = forwarded(req.headers, drop);
    try {
      Object.assign(headers, await authHeaders(run));
    } catch (error) {
      log(redact(`${what}: ${error.message}`, secrets()));
      run.apiStatus = error.status ?? 502;
      return failRun(run, res, 503, errorShape.unavailable, credentialFailure(what, error));
    }
    await forward(req, res, {
      target,
      headers,
      unreachable: () => failRun(run, res, 502, errorShape.unavailable, `${what} can't be reached`),
      log,
      what,
      idleMs,
      clock,
      answered: (status) => {
        run.apiStatus = status;
        if (status >= 400) run.apiError = `${what} answered ${status}`;
        answered(run, status, headers);
      },
    });
  }

  return { handle };
}
