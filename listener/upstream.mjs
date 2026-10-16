// What the listener's API endpoints share (anthropic.mjs, openai.mjs): a sandbox's call goes
// on to the provider with the operator's credential in place of the run's secret, and the
// answer streams back as it comes.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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
