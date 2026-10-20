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

// Errors in Anthropic's shape, so Claude Code shows them as such.
const ERRORS = {
  body: (type, message) => ({ type: "error", error: { type, message } }),
  auth: "authentication_error",
  unavailable: "api_error",
  notFound: "not_found_error",
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
  // Anthropic (or the operator's gateway) unless the broker gives the run another provider.
  const providerOf = (run) => (run.provider && run.provider !== "anthropic" ? run.provider : null);
  const settingsOf = (run) => {
    const provider = providerOf(run);
    return provider ? (providers[provider] ?? {}) : own;
  };

  return createApiProxy({
    broker,
    pathRe: API_PATH,
    errorShape: ERRORS,
    notApi: "not an Anthropic API path",
    secretOf,
    routeOf: (run) => {
      const provider = providerOf(run);
      const { name, credential, upstream } = settingsOf(run);
      if (!name || !credential) {
        return {
          missing: provider
            ? `the operator set no credential for ${provider}`
            : "the operator set no Claude credential",
        };
      }
      return { base: baseOf(upstream), what: provider ?? "Anthropic" };
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
