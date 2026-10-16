// What the listener's API endpoints share (anthropic.mjs, openai.mjs): a sandbox's call goes
// on to the provider with the operator's credential in place of the run's secret, and the
// answer streams back as it comes.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { sendJson } from "./web.mjs";

// Plans' credentials (`claude setup-token`, `codex login`): logged at start, as the operator
// is responsible for how they are used, and a plan's terms may not cover a team's bot.
const PLANS = {
  CLAUDE_CODE_OAUTH_TOKEN: "a Claude plan's credential",
  CODEX_AUTH_FILE: "a ChatGPT plan's login",
};

export function planWarning(name) {
  if (!Object.hasOwn(PLANS, name ?? "")) return null;
  return `Warning: ${name} is ${PLANS[name]}. A subscription (Claude Pro/Max, a ChatGPT plan) is usually licensed to one person. Serving a team, or repositories other people write to, may break your provider's terms: check them before you do. You are responsible for how your Deckhand uses your credential. For teams, use an API key.`;
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
export function forward(
  req,
  res,
  { target, headers, unreachable, log, what, answered = () => {} },
) {
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const out = send(target, { method: req.method, headers }, (answer) => {
      answered(answer.statusCode);
      res.writeHead(answer.statusCode, forwarded(answer.headers));
      // Server-sent events: each chunk goes on as it arrives.
      answer.pipe(res);
      answer.on("end", resolve);
      answer.on("error", () => (res.destroy(), resolve()));
    });
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

// A provider's endpoint: each call's run from its secret, then where it goes and with which
// credential, then on to the provider. What differs between providers:
//
//   pathRe       the API paths a sandbox may call, the path under the base URL its first group:
//                no "//host", "https://host", "\\host" or ".." that would send the credential to
//                another host, or out of a base URL's path
//   errorShape   { body(type, message), auth, unavailable, notFound }: errors in the
//                provider's shape and its types for each, so the agent shows them as such
//   notApi       what a refused path says
//   secretOf     req → the run's secret, from whichever header the agent sent it in
//   routeOf      run → { base, what, missing }: the provider's base URL (baseOf()), its name in
//                messages, and why the operator's credential is missing, if it is
//   drop         request headers the listener sets rather than the sandbox
//   authHeaders  async (run) → the credential's headers; an error with a `status` (what a
//                fallback reads) refuses the call
//   answered     (run, status, headers): the provider's status, once it answers
export function createApiProxy({
  broker, // broker.mjs: the run a secret belongs to
  pathRe,
  errorShape,
  notApi,
  secretOf,
  routeOf,
  drop,
  authHeaders,
  answered = () => {},
  log = () => {},
}) {
  const fail = (res, status, type, message) =>
    sendJson(res, errorShape.body(type, `Deckhand: ${message}`), status);

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
    const run = broker.runOf(secretOf(req));
    if (!run) return fail(res, 401, errorShape.auth, "unknown or finished run");
    const { base, what, missing } = routeOf(run);
    if (missing) return fail(res, 503, errorShape.unavailable, missing);
    const path = pathRe.exec(req.url.split("?")[0])?.[1];
    if (!path) return fail(res, 404, errorShape.notFound, notApi);
    // /openai/responses?x=1 → <base>/responses?x=1
    const target = new URL(base.href + path + url.search);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
      return fail(res, 404, errorShape.notFound, notApi);
    }
    const headers = forwarded(req.headers, drop);
    try {
      Object.assign(headers, await authHeaders(run));
    } catch (error) {
      log(`${what}: ${error.message}`);
      run.apiStatus = error.status ?? 502;
      return fail(res, 503, errorShape.unavailable, error.message);
    }
    await forward(req, res, {
      target,
      headers,
      unreachable: () => fail(res, 502, errorShape.unavailable, `${what} can't be reached`),
      log,
      what,
      answered: (status) => {
        run.apiStatus = status;
        answered(run, status, headers);
      },
    });
  }

  return { handle };
}
