// Google endpoint, the Antigravity CLI's like openai.mjs is Codex's. With a GEMINI_API_KEY, a
// sandbox's `agy` gets GOOGLE_GEMINI_BASE_URL=<broker>/google and the run's agent token as its
// key (../listener/agents/antigravity.mjs, antigravity.sh); the egress proxy sends those calls
// here, where the token in `x-goog-api-key` is checked (runs.mjs, from its own sandbox), swapped
// for the operator's key, and the call goes on to Google (or GEMINI_BASE_URL). With a Google AI
// plan's login instead (AGY_AUTH_FILE, antigravity-login.mjs), `agy` has no base URL: the egress
// proxy decrypts the hosts that carry its token, for its runs only (../listener/egress.mjs,
// agents/antigravity.mjs `relayed`), and sends each request here as /relay/<host>/<path>, where
// the token in `Authorization: Bearer` is swapped for the plan's access token.
import { GEMINI_URL } from "../listener/agents/credentials.mjs";
import { baseOf, createApiProxy } from "./upstream.mjs";

export { GEMINI_URL };

// Gemini's API under /v1 or /v1beta (models/<name>:<method>), nothing else (createApiProxy()).
const GEMINI_PATH = /^\/google\/(v1(?:beta)?(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+(?::[A-Za-z]+)?)$/;

// What `agy` calls there: generating, counting tokens and the model list. Not files, cached
// contents, tuned models or batches, which the operator's key opens too.
const GEMINI_ROUTES = [
  [
    "POST",
    /^v1(?:beta)?\/models\/[A-Za-z0-9._-]+:(?:generateContent|streamGenerateContent|countTokens)$/,
  ],
  ["GET", /^v1(?:beta)?\/models(?:\/[A-Za-z0-9._-]+)?$/],
];

// The calls each relayed host serves to `agy` (checked against agy 1.4.0), nothing else: the
// plan's token opens more than the CLI's API, and a sandbox mustn't reach the rest with it.
export const RELAYED_PATHS = {
  "daily-cloudcode-pa.googleapis.com": ["POST", "v1internal:[A-Za-z]+"],
  "www.googleapis.com": ["GET", "oauth2/v2/userinfo"],
};

// Errors in Google's shape, so `agy` shows them as such.
const ERRORS = {
  body: (status, message) => ({ error: { status, message } }),
  auth: "UNAUTHENTICATED",
  forbidden: "PERMISSION_DENIED",
  unavailable: "UNAVAILABLE",
  notFound: "NOT_FOUND",
  busy: "RESOURCE_EXHAUSTED",
};

export function createGoogleRelay({
  runs, // runs.mjs: the run an agent token belongs to
  credential = null, // the operator's GEMINI_API_KEY
  upstream = GEMINI_URL, // GEMINI_BASE_URL, if any (or host => url in tests)
  login = null, // without a key: antigravity-login.mjs's, from AGY_AUTH_FILE
  log = () => {},
}) {
  const plan = !credential && login;
  const hostUrl = typeof upstream === "function" ? upstream : (host) => `https://${host}`;
  const base = baseOf(
    typeof upstream === "function" ? upstream("generativelanguage.googleapis.com") : upstream,
  );

  const gemini = createApiProxy({
    runs,
    pathRe: GEMINI_PATH,
    routes: GEMINI_ROUTES,
    errorShape: ERRORS,
    notApi: "not a Gemini API path",
    secretOf: (req) => req.headers["x-goog-api-key"],
    // Only the Antigravity CLI's runs: another agent's token gets no key.
    routeOf: (run) =>
      run.provider !== "google"
        ? { missing: "not a run of the Antigravity CLI" }
        : credential
          ? { base, what: "Google" }
          : { missing: "the operator set no GEMINI_API_KEY" },
    drop: ["authorization", "x-goog-api-key"],
    authHeaders: async () => ({ "x-goog-api-key": credential }),
    secrets: () => [credential],
    log,
  });

  const proxies = [
    { prefix: "/google/", handle: gemini.handle },
    ...Object.entries(RELAYED_PATHS).map(([host, [method, path]]) => {
      const prefix = `/relay/${host}/`;
      const { handle } = createApiProxy({
        runs,
        pathRe: new RegExp(`^${prefix.replaceAll(".", "\\.")}(${path})$`),
        routes: [[method, /^/]],
        errorShape: ERRORS,
        notApi: `not a path the Antigravity CLI calls on ${host}`,
        secretOf: (req) => {
          const [scheme, secret] = (req.headers.authorization ?? "").split(" ");
          return scheme === "Bearer" ? secret : undefined;
        },
        // Only the Antigravity CLI's runs: another agent's token gets no plan.
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
        secrets: () => (plan ? plan.secrets() : []),
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
