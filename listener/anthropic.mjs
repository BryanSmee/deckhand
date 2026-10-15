// Anthropic endpoint: the operator's Claude credential never enters a sandbox, where Claude's
// tools, the repo's setup and a fork's code could read it (and post it on a public issue).
// A sandbox gets ANTHROPIC_BASE_URL=<broker>/anthropic and the run's secret in the variable
// the credential would be in (sandboxEnv()), so Claude Code keeps its mode: an OAuth token
// goes as `Authorization: Bearer`, with its beta, a gateway's token (ANTHROPIC_AUTH_TOKEN,
// for OpenRouter say) as `Authorization: Bearer` too, an API key as `x-api-key`. Here the secret
// is checked against the broker and swapped for the credential, in the same header, and the
// request goes on to Anthropic; the answer streams back as it comes. The secret dies with the
// run. Served on the broker's port, which only the runs' networks reach.
import { baseOf, forward, forwarded } from "./upstream.mjs";
import { sendJson } from "./web.mjs";

// Claude Code's own order: a bearer token (a gateway's), then an API key, then an OAuth token.
export const CREDENTIALS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

// The variable that holds the operator's credential, or null.
export function credentialName(env) {
  return CREDENTIALS.find((name) => env[name]) ?? null;
}

// The run's secret, from whichever header Claude Code sent it in.
function secretOf(req) {
  const [scheme, value] = (req.headers.authorization ?? "").split(" ");
  return scheme === "Bearer" ? value : req.headers["x-api-key"];
}

// Anthropic's API under /v1, nothing else: no "//host", "https://host", "\\host" or ".." that
// would send the credential to another host, or out of a gateway's base path.
const API_PATH = /^\/anthropic\/(v1(?:\/[A-Za-z0-9_-]+)+)$/;

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
  const base = baseOf(upstream);

  async function handle(req, res) {
    const path = API_PATH.exec(req.url.split("?")[0])?.[1];
    if (!broker.runOf(secretOf(req))) {
      return fail(res, 401, "authentication_error", "unknown or finished run");
    }
    if (!name || !credential) {
      return fail(res, 503, "api_error", "the operator set no Claude credential");
    }
    if (!path) return fail(res, 404, "not_found_error", "not an Anthropic API path");
    // /anthropic/v1/messages?beta=true → <upstream>/v1/messages?beta=true
    const target = new URL(base.href + path + new URL(req.url, "http://broker").search);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
      return fail(res, 404, "not_found_error", "not an Anthropic API path");
    }
    const headers = forwarded(req.headers, ["authorization", "x-api-key"]);
    if (name === "ANTHROPIC_API_KEY") headers["x-api-key"] = credential;
    else headers.authorization = `Bearer ${credential}`;

    await forward(req, res, {
      target,
      headers,
      unreachable: () => fail(res, 502, "api_error", "Anthropic can't be reached"),
      log,
      what: "Anthropic",
    });
  }

  return { handle };
}
