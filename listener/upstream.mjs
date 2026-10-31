// What the listener's API endpoints share (anthropic.mjs, openai.mjs): a sandbox's call goes
// on to the provider with the operator's credential in place of the run's agent token, and the
// answer streams back as it comes.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { redact } from "../lib/redact.mjs";
import { AGENT_AUDIENCE } from "../lib/tokens.mjs";
import { sendJson } from "../lib/http.mjs";

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
// The refused calls a run's log and the listener's log note, each once and only so many: a
// sandbox looping on one mustn't grow its log past RUN_LOG_MAX_MB (writeEvent() isn't capped).
export const MAX_NOTED = 20;
// run → the refused calls noted for it.
const noted = new WeakMap();

// Notes `call` once per run, and up to MAX_NOTED of them; then a line saying the rest aren't.
function noteRefused(run, call, notApi, log, what) {
  const seen = noted.get(run) ?? new Set();
  noted.set(run, seen);
  if (seen.has(call) || seen.size > MAX_NOTED) return;
  seen.add(call);
  if (seen.size > MAX_NOTED) {
    run.note?.(`Deckhand refused more of the agent's calls: only the first ${MAX_NOTED} are noted`);
    return;
  }
  run.note?.(`Deckhand refused the agent's call ${call}: ${notApi}`);
  log(`${what}: refused ${call}`);
}

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
  // The sandbox's address, which the egress proxy adds to the calls it relays (proxy.mjs).
  "x-deckhand-client",
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
// provider can't be reached before anything was sent back. `answered(status, headers, lost)`:
// the provider's status and headers, 502 (no headers, `lost` true) when it can't be reached or
// its answer never came, though the request may have gone out (what a fallback reads, agents/
// providerError()).
// `idleMs`: how long the call may go without a byte either way before it is cut off, on
// `clock`'s timers: a stalled provider doesn't hold a listener every run shares. `body`: what
// is sent in place of the request's own, already read (github-gateway.mjs's redacted writes).
// `tap(chunk)`: each chunk of the answer too, as it goes on (github-gateway.mjs's writes).
// `follow(status, headers)`: { target, headers } to fetch instead with a GET, its answer sent
// back in place of this one (github-gateway.mjs's Actions logs, a redirect to a storage host
// the sandbox can't reach), or null; asked of the first answer only.
// `transform(status, headers, body)`: the answer read whole, up to `maxTransform` bytes, and
// sent back as it returns it (null: as it was); past that size, it goes on as it comes, as is
// (github-gateway.mjs's GraphQL reads without a permission, whose error it explains).
// `settle()`: awaited once the answer came whole, before its end is sent: what the call changed
// is kept (the github service's store) before the client can send its next call, to the other
// copy maybe. Its length isn't sent ahead, so that the client sees the end only then.
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
    body,
    tap,
    follow,
    transform,
    maxTransform = 1024 * 1024,
    settle,
  },
) {
  const sender = (url) => (url.protocol === "https:" ? httpsRequest : httpRequest);
  return new Promise((done) => {
    let timer = null;
    let ended = false;
    const resolve = () => {
      ended = true;
      clock.clearTimeout(timer);
      req.off("data", idle);
      done();
    };
    const onAnswer = (answer, first) => {
      const next = first ? follow?.(answer.statusCode, answer.headers) : null;
      if (next) {
        answer.resume();
        out = sender(next.target)(next.target, { method: "GET", headers: next.headers }, (again) =>
          onAnswer(again, false),
        );
        out.on("error", failed);
        out.end();
        return;
      }
      if (transform) return transformed(answer);
      answered(answer.statusCode, answer.headers);
      const headers = forwarded(answer.headers, settle ? ["content-length"] : []);
      res.writeHead(answer.statusCode, headers);
      // Server-sent events: each chunk goes on as it arrives.
      answer.on("data", idle);
      if (tap) answer.on("data", tap);
      answer.pipe(res, { end: !settle });
      answer.on("end", settle ? () => settled().then(() => (res.end(), resolve())) : resolve);
      answer.on("error", () => (res.destroy(), resolve()));
    };
    // settle()'s failure is the caller's to log: the answer ends all the same.
    const settled = () => Promise.resolve(settle?.()).catch(() => {});
    // The answer held until it ends, then transform()'s; past maxTransform, what was held and
    // the rest go on as they come.
    const transformed = (answer) => {
      const chunks = [];
      let size = 0;
      let passing = false;
      answer.on("data", idle);
      if (tap) answer.on("data", tap);
      answer.on("data", (chunk) => {
        if (passing) return void res.write(chunk);
        chunks.push(chunk);
        size += chunk.length;
        if (size <= maxTransform) return;
        passing = true;
        answered(answer.statusCode, answer.headers);
        res.writeHead(
          answer.statusCode,
          forwarded(answer.headers, settle ? ["content-length"] : []),
        );
        for (const held of chunks) res.write(held);
      });
      answer.on("end", () => {
        if (passing) return settled().then(() => (res.end(), resolve()));
        const held = Buffer.concat(chunks);
        let body = held;
        try {
          body = transform(answer.statusCode, answer.headers, held) ?? held;
        } catch (error) {
          log(`${what}: ${req.method} ${target.pathname}: ${error.message}`);
        }
        answered(answer.statusCode, answer.headers);
        res.writeHead(answer.statusCode, {
          ...forwarded(answer.headers),
          "content-length": String(body.length),
        });
        settled().then(() => (res.end(body), resolve()));
      });
      answer.on("error", () => (res.destroy(), resolve()));
    };
    let out = sender(target)(target, { method: req.method, headers }, (answer) =>
      onAnswer(answer, true),
    );
    function idle() {
      if (ended) return;
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        out.destroy(new Error(`no bytes for ${Math.round(idleMs / 1000)} s`));
        // Already answering: the agent sees its stream end early, and may retry.
        if (res.headersSent) (res.destroy(), resolve());
      }, idleMs);
    }
    idle();
    req.on("data", idle);
    function failed(error) {
      log(`${what}: ${req.method} ${target.pathname}: ${error.message}`);
      if (!res.headersSent) {
        answered(502, {}, true);
        unreachable();
      } else res.destroy();
      resolve();
    }
    out.on("error", failed);
    // The agent gave up (an interrupt, the run's end): so does the request upstream.
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
      resolve();
    });
    if (body === undefined) req.pipe(out);
    else out.end(body);
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
//   secretOf     req → the run's agent token (or its secret, from before tokens), from
//                whichever header the agent sent it in
//   routeOf      run → { base, what, missing }: the provider's base URL (baseOf()), its name in
//                messages, and why the operator's credential is missing, if it is
//   drop         request headers the listener sets rather than the sandbox
//   authHeaders  async (run) → the credential's headers; an error with a `status` (what a
//                fallback reads) refuses the call. Its message only goes to the listener's log
//                (a token file's content, say): the sandbox and the run's reply get a fixed one
//   secrets      () → the credential's values, redacted from that log line
//   answered     (run, status, headers, answer): the provider's status, once it answers, with
//                the request's headers and the answer's
export function createApiProxy({
  broker, // broker.mjs: the run a token belongs to
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
    // Before anything that writes to the run (its apiError, its notes): a leaked token
    // mustn't spend its budget, nor change what its reply says.
    const checked = await broker.check(secretOf(req), req, AGENT_AUDIENCE);
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
      run.apiError ??= notApi;
      return fail(res, 404, errorShape.notFound, notApi);
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
      answered: (status, answer) => {
        run.apiStatus = status;
        if (status >= 400) run.apiError = `${what} answered ${status}`;
        answered(run, status, headers, answer);
      },
    });
  }

  return { handle };
}
