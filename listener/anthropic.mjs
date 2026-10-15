// Anthropic endpoint: the operator's Claude credential never enters a sandbox, where Claude's
// tools, the repo's setup and a fork's code could read it (and post it on a public issue).
// A sandbox gets ANTHROPIC_BASE_URL=<broker>/anthropic and the run's secret in the variable
// the credential would be in (sandboxEnv()), so Claude Code keeps its mode: an OAuth token
// goes as `Authorization: Bearer`, with its beta, a gateway's token (ANTHROPIC_AUTH_TOKEN,
// for OpenRouter say) as `Authorization: Bearer` too, an API key as `x-api-key`. Here the secret
// is checked against the broker and swapped for the credential, in the same header, and the
// request goes on to Anthropic; the answer streams back as it comes. The secret dies with the
// run. Served on the broker's port, which only the runs' networks reach.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { sendJson } from "./web.mjs";

// Claude Code's own order: a bearer token (a gateway's), then an API key, then an OAuth token.
export const CREDENTIALS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

// The variable that holds the operator's credential, or null.
export function credentialName(env) {
  return CREDENTIALS.find((name) => env[name]) ?? null;
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

function forwarded(headers, drop = []) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP.has(name) && !drop.includes(name)),
  );
}

// The run's secret, from whichever header Claude Code sent it in.
function secretOf(req) {
  const [scheme, value] = (req.headers.authorization ?? "").split(" ");
  return scheme === "Bearer" ? value : req.headers["x-api-key"];
}

// Errors in Anthropic's shape, so Claude Code shows them as such.
function fail(res, status, type, message) {
  sendJson(res, { type: "error", error: { type, message: `Deckhand: ${message}` } }, status);
}

export function createAnthropicProxy({
  broker, // broker.mjs: the run a secret belongs to
  name, // credentialName(): which header the credential goes in
  credential, // its value
  upstream = "https://api.anthropic.com", // the listener's ANTHROPIC_BASE_URL, if any
  log = () => {},
}) {
  const base = new URL(upstream.replace(/\/?$/, "/"));
  const send = base.protocol === "https:" ? httpsRequest : httpRequest;

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
    if (!broker.runOf(secretOf(req))) {
      return fail(res, 401, "authentication_error", "unknown or finished run");
    }
    if (!name || !credential) {
      return fail(res, 503, "api_error", "the operator set no Claude credential");
    }
    // /anthropic/v1/messages?beta=true → <upstream>/v1/messages?beta=true
    const target = new URL(url.pathname.replace(/^\/anthropic\/?/, "") + url.search, base);
    const headers = forwarded(req.headers, ["authorization", "x-api-key"]);
    if (name === "ANTHROPIC_API_KEY") headers["x-api-key"] = credential;
    else headers.authorization = `Bearer ${credential}`;

    await new Promise((resolve) => {
      const out = send(target, { method: req.method, headers }, (answer) => {
        res.writeHead(answer.statusCode, forwarded(answer.headers));
        // Server-sent events: each chunk goes on as it arrives.
        answer.pipe(res);
        answer.on("end", resolve);
        answer.on("error", () => (res.destroy(), resolve()));
      });
      out.on("error", (error) => {
        log(`Anthropic: ${req.method} ${target.pathname}: ${error.message}`);
        if (!res.headersSent) fail(res, 502, "api_error", "Anthropic can't be reached");
        else res.destroy();
        resolve();
      });
      // Claude Code gave up (an interrupt, the run's end): so does the request upstream.
      res.on("close", () => {
        if (!res.writableFinished) out.destroy();
        resolve();
      });
      req.pipe(out);
    });
  }

  return { handle };
}
