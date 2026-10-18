// OpenAI endpoint, Codex's like anthropic.mjs is Claude Code's: the operator's OPENAI_API_KEY
// never enters a sandbox. A sandbox's Codex gets <broker>/openai as its provider's base URL
// and the run's secret as its key (agents/codex.mjs); here the secret is checked against the
// broker, swapped for the key, and the call goes on to OpenAI (or the listener's own
// OPENAI_BASE_URL), streaming back. With a ChatGPT plan's login instead (CODEX_AUTH_FILE,
// chatgpt.mjs), the call goes to ChatGPT's Codex backend with the plan's tokens, which the
// listener alone holds and refreshes. Served on the broker's port, which only the runs'
// networks reach.
import { CHATGPT_URL } from "./chatgpt.mjs";
import { baseOf, createApiProxy } from "./upstream.mjs";

// An API key first, as Claude Code's order puts one before a plan's token.
export const OPENAI_CREDENTIALS = ["OPENAI_API_KEY", "CODEX_AUTH_FILE"];

// Paths under the provider's base URL, nothing else (createApiProxy()).
const API_PATH = /^\/openai\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/;

// Errors in OpenAI's shape, so Codex shows them as such.
const ERRORS = {
  body: (type, message) => ({ error: { type, message } }),
  auth: "invalid_request_error",
  unavailable: "server_error",
  notFound: "not_found",
};

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

  const { handle } = createApiProxy({
    broker,
    pathRe: API_PATH,
    errorShape: ERRORS,
    notApi: "not an OpenAI API path",
    secretOf: (req) => {
      const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
      return scheme === "Bearer" ? secret : undefined;
    },
    routeOf: () =>
      credential || login
        ? { base, what: "OpenAI" }
        : { missing: "the operator set no OPENAI_API_KEY or CODEX_AUTH_FILE" },
    // The plan's headers are the listener's to set, not the sandbox's.
    drop: ["authorization", "chatgpt-account-id", "x-openai-fedramp"],
    // A spent login refuses the call with its status: a bad credential, for a fallback
    // (agents/ providerError()).
    authHeaders: async () => (plan ? login.headers() : { authorization: `Bearer ${credential}` }),
    answered: (run, status, headers) => {
      // Expired early or revoked: the next call refreshes it first.
      if (plan && status === 401) login.refused(headers.authorization);
    },
    secrets: () => (plan ? login.secrets() : [credential]),
    log,
  });

  // The plan's tokens, which runs' output must not publish either (runs.mjs).
  return { handle, secrets: () => login?.secrets() ?? [] };
}
