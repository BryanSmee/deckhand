// Anthropic endpoint: the operator's Claude credential never enters a sandbox, where Claude's
// tools, the repo's setup and a fork's code could read it (and post it on a public issue).
// A sandbox gets ANTHROPIC_BASE_URL=<broker>/anthropic and the run's agent token in the variable
// the credential would be in (agents/claude.mjs env()), so Claude Code keeps its mode: an OAuth token
// goes as `Authorization: Bearer`, with its beta, a gateway's token (ANTHROPIC_AUTH_TOKEN,
// for OpenRouter say) as `Authorization: Bearer` too, an API key as `x-api-key`. Here the secret
// is checked against the broker and swapped for the credential, in the same header, and the
// request goes on to Anthropic; the answer streams back as it comes. The secret dies with the
// run. Served on the broker's port, which only the runs' networks reach.
import { baseOf, createApiProxy } from "./upstream.mjs";

// Which one runs take when several are set: a bearer token (a gateway's), then a plan's OAuth
// token, already paid for, then an API key, billed per token. Not Claude Code's own order (the
// key before the plan): a run gets one of them, and FALLBACKS can name the key
// (`claude@anthropic:key`) for when the plan's limit is reached.
export const CREDENTIALS = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

// The credentials an entry can name (`claude@anthropic:plan`), each with its variable and how
// replies name it.
export const NAMED = {
  plan: { variable: "CLAUDE_CODE_OAUTH_TOKEN", label: "plan" },
  key: { variable: "ANTHROPIC_API_KEY", label: "API key" },
};

// How the dashboard tells a run's credential (a run record's `auth`), by its variable: a
// gateway's token, a plan's, or an API key, billed per token.
export const AUTHS = {
  ANTHROPIC_AUTH_TOKEN: "gateway",
  ...Object.fromEntries(Object.entries(NAMED).map(([name, { variable }]) => [variable, name])),
};

// The variable that holds the operator's default credential, or null.
export function credentialName(env) {
  return CREDENTIALS.find((name) => env[name]) ?? null;
}

// How long a plan's usage limit lasts when its answer doesn't say: its window, 5 hours.
export const PLAN_WINDOW_MS = 5 * 3600_000;

// When a plan's limit resets, in ms, from its 429: the reset its rate limit headers give (in
// seconds since the epoch), or null. Not Retry-After: a short rate limit Claude Code retries
// past says nothing of the plan's limit.
export function resetOf(headers) {
  const reset = Number(headers["anthropic-ratelimit-unified-reset"]);
  return reset > 0 ? reset * 1000 : null;
}

// The run's agent token, from whichever header Claude Code sent it in.
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
  broker, // broker.mjs: the run a token belongs to
  name, // credentialName(): which header the credential goes in
  credential, // its value
  // The credentials a run can name (broker.mjs provide()): { plan, key } (NAMED) → value.
  named = {},
  upstream = "https://api.anthropic.com", // the listener's ANTHROPIC_BASE_URL, if any
  // Other providers (agents/claude.mjs), for runs the broker gives one: { openrouter: { name,
  // credential, upstream } }.
  providers = {},
  log = () => {},
}) {
  const own = { name, credential, upstream };
  // A run on a named credential (`claude@anthropic:key`) gets that one, and never another.
  const namedOf = (run) => {
    const { variable } = NAMED[run.credential];
    return { name: variable, credential: named[run.credential], upstream };
  };
  // Claude Code's runs only, each on its provider: Anthropic (or the operator's gateway), with
  // the default credential or the one the run names, or one of `providers`. Another agent's
  // run, or one whose provider or credential isn't known (null), gets no credential.
  const settingsOf = (run) => {
    if (run.provider === "anthropic") {
      if (!run.credential) return own;
      return Object.hasOwn(NAMED, run.credential) ? namedOf(run) : null;
    }
    return Object.hasOwn(providers, run.provider ?? "") ? providers[run.provider] : null;
  };

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
        const which = run.credential ? `no ${name}` : "no Claude credential";
        return {
          missing: own
            ? `the operator set ${which}`
            : `the operator set no credential for ${run.provider}`,
        };
      }
      return { base: baseOf(upstream), what: own ? "Anthropic" : run.provider };
    },
    drop: ["authorization", "x-api-key"],
    // In the header Claude Code sent the token in.
    authHeaders: async (run) => {
      const { name, credential } = settingsOf(run);
      return name === "ANTHROPIC_API_KEY"
        ? { "x-api-key": credential }
        : { authorization: `Bearer ${credential}` };
    },
    // A plan's limit: when it resets, for the fallback that takes over until then
    // (agents/select.mjs nextFallback()). Any other answer clears it: the run got past it, and
    // a later failure is another one.
    answered: (run, status, _headers, answer) => {
      if (settingsOf(run)?.name !== NAMED.plan.variable) return;
      run.apiReset = status === 429 ? resetOf(answer) : null;
    },
    secrets: () =>
      [
        credential,
        ...Object.values(named),
        ...Object.values(providers).map((p) => p.credential),
      ].filter(Boolean),
    log,
  });
}
