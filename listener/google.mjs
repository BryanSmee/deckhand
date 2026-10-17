// Google endpoint, the Antigravity CLI's like openai.mjs is Codex's. With a GEMINI_API_KEY, a
// sandbox's `agy` gets GOOGLE_GEMINI_BASE_URL=<broker>/google and the run's secret as its key
// (agents/antigravity.mjs, antigravity.sh); here the secret in `x-goog-api-key` is checked
// against the broker, swapped for the operator's key, and the call goes on to Google (or the
// listener's GEMINI_BASE_URL). With a Google AI plan's login instead (AGY_AUTH_FILE,
// antigravity-login.mjs), `agy` has no base URL: the egress proxy decrypts the hosts that carry
// its token, for its runs only (egress.mjs, agents/antigravity.mjs `relayed`), and sends each
// request here as /relay/<host>/<path>, where the secret in `Authorization: Bearer` is swapped
// for the plan's access token. Served on the broker's port, which only the runs' networks reach.
import { baseOf, createApiProxy } from "./upstream.mjs";

// An API key first, as Claude Code's and Codex's orders put one before a plan's login.
export const GOOGLE_CREDENTIALS = ["GEMINI_API_KEY", "AGY_AUTH_FILE"];

export const GEMINI_URL = "https://generativelanguage.googleapis.com";

// Gemini's API under /v1 or /v1beta (models/<name>:<method>), nothing else (createApiProxy()).
const GEMINI_PATH = /^\/google\/(v1(?:beta)?(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+(?::[A-Za-z]+)?)$/;

// The paths each relayed host serves to `agy` (checked against agy 1.4.0), nothing else: the
// plan's token opens more than the CLI's API, and a sandbox mustn't reach the rest with it.
export const RELAYED_PATHS = {
  "daily-cloudcode-pa.googleapis.com": "v1internal:[A-Za-z]+",
  "www.googleapis.com": "oauth2/v2/userinfo",
};

// Errors in Google's shape, so `agy` shows them as such.
const ERRORS = {
  body: (status, message) => ({ error: { status, message } }),
  auth: "UNAUTHENTICATED",
  unavailable: "UNAVAILABLE",
  notFound: "NOT_FOUND",
};

export function createGoogleRelay({
  broker, // broker.mjs: the run a secret belongs to
  credential = null, // the operator's GEMINI_API_KEY
  upstream = GEMINI_URL, // the listener's GEMINI_BASE_URL, if any (or host => url in tests)
  login = null, // without a key: antigravity-login.mjs's, from AGY_AUTH_FILE
  log = () => {},
}) {
  const plan = !credential && login;
  const hostUrl = typeof upstream === "function" ? upstream : (host) => `https://${host}`;
  const base = baseOf(
    typeof upstream === "function" ? upstream("generativelanguage.googleapis.com") : upstream,
  );

  const gemini = createApiProxy({
    broker,
    pathRe: GEMINI_PATH,
    errorShape: ERRORS,
    notApi: "not a Gemini API path",
    secretOf: (req) => req.headers["x-goog-api-key"],
    // Only the Antigravity CLI's runs: another agent's secret gets no key.
    routeOf: (run) =>
      run.provider !== "google"
        ? { missing: "not a run of the Antigravity CLI" }
        : credential
          ? { base, what: "Google" }
          : { missing: "the operator set no GEMINI_API_KEY" },
    drop: ["authorization", "x-goog-api-key"],
    authHeaders: async () => ({ "x-goog-api-key": credential }),
    log,
  });

  const proxies = [
    { prefix: "/google/", handle: gemini.handle },
    ...Object.entries(RELAYED_PATHS).map(([host, path]) => {
      const prefix = `/relay/${host}/`;
      const { handle } = createApiProxy({
        broker,
        pathRe: new RegExp(`^${prefix.replaceAll(".", "\\.")}(${path})$`),
        errorShape: ERRORS,
        notApi: `not a path the Antigravity CLI calls on ${host}`,
        secretOf: (req) => {
          const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
          return scheme === "Bearer" ? secret : undefined;
        },
        // Only the Antigravity CLI's runs: another agent's secret gets no plan.
        routeOf: (run) =>
          run.provider !== "google"
            ? { missing: "not a run of the Antigravity CLI" }
            : plan
              ? { base: new URL(`${hostUrl(host)}/`), what: "Google" }
              : { missing: "the operator set no AGY_AUTH_FILE" },
        drop: ["authorization"],
        authHeaders: () => plan.headers(),
        answered: (run, status, headers) => {
          // Expired early or revoked: the next call refreshes it first.
          if (status === 401) plan.refused(headers.authorization);
        },
        log,
      });
      return { prefix, handle };
    }),
  ];

  async function handle(req, res) {
    const proxy = proxies.find((p) => req.url.startsWith(p.prefix)) ?? proxies.at(-1);
    return proxy.handle(req, res);
  }

  // The operator's key or the plan's tokens, which runs' output must not publish (runs.mjs).
  return { handle, secrets: () => (credential ? [credential] : plan ? login.secrets() : []) };
}
