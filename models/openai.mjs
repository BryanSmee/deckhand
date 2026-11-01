// OpenAI endpoint, Codex's like anthropic.mjs is Claude Code's: the operator's OPENAI_API_KEY
// never enters a sandbox. A sandbox's Codex gets <broker>/openai as its provider's base URL
// and the run's agent token as its key (../listener/agents/codex.mjs); the egress proxy sends
// those calls here, where the token is checked (runs.mjs), swapped for the key, and the call goes
// on to OpenAI (or OPENAI_BASE_URL), streaming back. With a ChatGPT plan's login instead
// (CODEX_AUTH_FILE, chatgpt.mjs), the call goes to ChatGPT's Codex backend with the plan's
// tokens, which the models service alone holds and refreshes.
import { CHATGPT_URL } from "./chatgpt.mjs";
import { baseOf, createApiProxy } from "./upstream.mjs";

// Paths under the provider's base URL, nothing else (createApiProxy()).
const API_PATH = /^\/openai\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/;

// What Codex calls there, on the API as on ChatGPT's Codex backend: its responses, their
// compaction and the model list. Not files, batches, stored responses or vector stores, which
// the operator's key opens too.
const ROUTES = [
  ["POST", /^responses(?:\/compact)?$/],
  ["GET", /^models(?:\/[A-Za-z0-9_-]+)?$/],
];

// Errors in OpenAI's shape, so Codex shows them as such.
const ERRORS = {
  body: (type, message) => ({ error: { type, message } }),
  auth: "invalid_request_error",
  forbidden: "permission_denied",
  unavailable: "server_error",
  notFound: "not_found",
  busy: "rate_limit_exceeded",
};

export function createOpenAiProxy({
  runs, // runs.mjs: the run an agent token belongs to
  credential, // the operator's OPENAI_API_KEY
  upstream = "https://api.openai.com/v1", // OPENAI_BASE_URL, if any
  login = null, // without a key: chatgpt.mjs's login, and where its calls go
  chatgptUrl = CHATGPT_URL,
  // usage.mjs's: the plan's answers' rate limit headers, for the dashboard's bars.
  usage = null,
  log = () => {},
}) {
  const plan = !credential && login;
  const base = baseOf(plan ? chatgptUrl : upstream);

  const { handle } = createApiProxy({
    runs,
    pathRe: API_PATH,
    routes: ROUTES,
    errorShape: ERRORS,
    notApi: "not an OpenAI API path",
    secretOf: (req) => {
      const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
      return scheme === "Bearer" ? secret : undefined;
    },
    // Only Codex's runs: another agent's token gets no key.
    routeOf: (run) =>
      run.provider !== "openai"
        ? { missing: "not a run of Codex" }
        : credential || login
          ? { base, what: "OpenAI" }
          : { missing: "the operator set no OPENAI_API_KEY or CODEX_AUTH_FILE" },
    // The plan's headers are the service's to set, not the sandbox's.
    drop: ["authorization", "chatgpt-account-id", "x-openai-fedramp"],
    // A spent login refuses the call with its status: a bad credential, for a fallback
    // (agents/ providerError()).
    authHeaders: async () => (plan ? login.headers() : { authorization: `Bearer ${credential}` }),
    answered: (run, status, headers, answer) => {
      if (!plan) return;
      // Expired early or revoked: the next call refreshes it first.
      if (status === 401) login.refused(headers.authorization);
      usage?.codexAnswered(status, answer);
    },
    secrets: () => (plan ? login.secrets() : [credential]),
    log,
  });

  // The plan's tokens, which runs' output must not publish either (runs.mjs).
  return { handle, secrets: () => login?.secrets() ?? [] };
}
