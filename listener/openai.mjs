// OpenAI endpoint, Codex's like anthropic.mjs is Claude Code's: the operator's OPENAI_API_KEY
// never enters a sandbox. A sandbox's Codex gets <broker>/openai as its provider's base URL
// and the run's secret as its key (agents/codex.mjs); here the secret is checked against the
// broker, swapped for the key, and the call goes on to OpenAI (or the listener's own
// OPENAI_BASE_URL), streaming back. With a ChatGPT plan's login instead (CODEX_AUTH_FILE,
// chatgpt.mjs), the call goes to ChatGPT's Codex backend with the plan's tokens, which the
// listener alone holds and refreshes. Served on the broker's port, which only the runs'
// networks reach.
import { CHATGPT_URL } from "./chatgpt.mjs";
import { baseOf, forward, forwarded } from "./upstream.mjs";
import { sendJson } from "./web.mjs";

// An API key first, as Claude Code's order puts one before a plan's token.
export const OPENAI_CREDENTIALS = ["OPENAI_API_KEY", "CODEX_AUTH_FILE"];

// Paths under the provider's base URL, nothing else: no "//host", "https://host", "\\host" or
// ".." that would send the key to another host, or out of OPENAI_BASE_URL's path.
const API_PATH = /^\/openai\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/;

// Errors in OpenAI's shape, so Codex shows them as such.
function fail(res, status, type, message) {
  sendJson(res, { error: { type, message: `Deckhand: ${message}` } }, status);
}

export function createOpenAiProxy({
  broker, // broker.mjs: the run a secret belongs to
  credential, // the operator's OPENAI_API_KEY
  upstream = "https://api.openai.com/v1", // the listener's OPENAI_BASE_URL, if any
  login = null, // without a key: chatgpt.mjs's login, and where its calls go
  chatgptUrl = CHATGPT_URL,
  log = () => {},
}) {
  const plan = !credential && login;
  const base = baseOf(plan ? chatgptUrl : upstream);

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
    const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
    const run = scheme === "Bearer" ? broker.runOf(secret) : undefined;
    if (!run) {
      return fail(res, 401, "invalid_request_error", "unknown or finished run");
    }
    if (!credential && !login) {
      return fail(
        res,
        503,
        "server_error",
        "the operator set no OPENAI_API_KEY or CODEX_AUTH_FILE",
      );
    }
    const path = API_PATH.exec(req.url.split("?")[0])?.[1];
    if (!path) return fail(res, 404, "not_found", "not an OpenAI API path");
    // /openai/responses → <upstream>/responses
    const target = new URL(base.href + path + url.search);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
      return fail(res, 404, "not_found", "not an OpenAI API path");
    }
    // The plan's headers are the listener's to set, not the sandbox's.
    const headers = forwarded(req.headers, [
      "authorization",
      "chatgpt-account-id",
      "x-openai-fedramp",
    ]);
    if (plan) {
      try {
        Object.assign(headers, await login.headers());
      } catch (error) {
        log(`Codex: ${error.message}`);
        // What a fallback reads (agents/ providerError()): a spent login is a bad credential.
        run.apiStatus = error.status ?? 502;
        return fail(res, 503, "server_error", error.message);
      }
    } else headers.authorization = `Bearer ${credential}`;
    await forward(req, res, {
      target,
      headers,
      unreachable: () => fail(res, 502, "server_error", "OpenAI can't be reached"),
      log,
      what: "OpenAI",
      answered: (status) => {
        run.apiStatus = status;
        // Expired early or revoked: the next call refreshes it first.
        if (plan && status === 401) login.refused(headers.authorization);
      },
    });
  }

  // The plan's tokens, which runs' output must not publish either (runs.mjs).
  return { handle, secrets: () => login?.secrets() ?? [] };
}
