// Anthropic endpoint: the operator's Claude credential never enters a sandbox, where Claude's
// tools, the repo's setup and a fork's code could read it (and post it on a public issue).
// A sandbox gets ANTHROPIC_BASE_URL=<broker>/anthropic and the run's secret in the variable
// the credential would be in (sandboxEnv()), so Claude Code keeps its mode: an OAuth token
// goes as `Authorization: Bearer`, with its beta, a gateway's token (ANTHROPIC_AUTH_TOKEN,
// for OpenRouter say) as `Authorization: Bearer` too, an API key as `x-api-key`. Here the secret
// is checked against the broker and swapped for the credential, in the same header, and the
// request goes on to Anthropic; the answer streams back as it comes. The secret dies with the
// run. Served on the broker's port, which only the runs' networks reach.
import { baseOf, createApiProxy } from "./upstream.mjs";

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

// Anthropic's API under /v1, nothing else (createApiProxy()).
const API_PATH = /^\/anthropic\/(v1(?:\/[A-Za-z0-9_-]+)+)$/;

// What Claude Code calls there: its messages, their token counts and the model list. Not files,
// batches or the admin API, which the operator's credential opens too.
const ROUTES = [
  ["POST", /^v1\/messages(?:\/count_tokens)?$/],
  ["GET", /^v1\/models(?:\/[A-Za-z0-9_-]+)?$/],
];

// Errors in Anthropic's shape, so Claude Code shows them as such.
const ERRORS = {
  body: (type, message) => ({ type: "error", error: { type, message } }),
  auth: "authentication_error",
  forbidden: "permission_error",
  unavailable: "api_error",
  notFound: "not_found_error",
  busy: "rate_limit_error",
};

export function createAnthropicProxy({
  broker, // broker.mjs: the run a secret belongs to
  name, // credentialName(): which header the credential goes in
  credential, // its value
  upstream = "https://api.anthropic.com", // the listener's ANTHROPIC_BASE_URL, if any
  // Other providers (agents/claude.mjs), for runs the broker gives one: { openrouter: { name,
  // credential, upstream } }.
  providers = {},
  log = () => {},
}) {
  const own = { name, credential, upstream };
  // Claude Code's runs only, each on its provider: Anthropic (or the operator's gateway), or
  // one of `providers`. Another agent's run, or one whose provider isn't known (null), gets no
  // credential.
  const settingsOf = (run) =>
    run.provider === "anthropic"
      ? own
      : Object.hasOwn(providers, run.provider ?? "")
        ? providers[run.provider]
        : null;

  return createApiProxy({
    broker,
    pathRe: API_PATH,
    routes: ROUTES,
    errorShape: ERRORS,
    notApi: "not an Anthropic API path",
    secretOf,
    routeOf: (run) => {
      const settings = settingsOf(run);
      if (!settings) return { missing: "not a run of Claude Code" };
      const own = run.provider === "anthropic";
      const { name, credential, upstream } = settings;
      if (!name || !credential) {
        return {
          missing: own
            ? "the operator set no Claude credential"
            : `the operator set no credential for ${run.provider}`,
        };
      }
      return { base: baseOf(upstream), what: own ? "Anthropic" : run.provider };
    },
    drop: ["authorization", "x-api-key"],
    // In the header Claude Code sent the secret in.
    authHeaders: async (run) => {
      const { name, credential } = settingsOf(run);
      return name === "ANTHROPIC_API_KEY"
        ? { "x-api-key": credential }
        : { authorization: `Bearer ${credential}` };
    },
    secrets: () => [credential, ...Object.values(providers).map((p) => p.credential)],
    log,
  });
}
