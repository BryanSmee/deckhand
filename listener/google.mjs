// Google endpoint, the Antigravity CLI's like openai.mjs is Codex's, though `agy` has no base
// URL to point at the listener: the egress proxy decrypts the hosts that carry its token, for
// its runs only (egress.mjs, agents/antigravity.mjs `relayed`), and sends each request here as
// /relay/<host>/<path>. The run's secret, the sandbox's access token, is checked against the
// broker and swapped for the plan's (antigravity-login.mjs), and the call goes on to the host,
// streaming back. Served on the broker's port, which only the runs' networks reach.
import { createApiProxy } from "./upstream.mjs";

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
  login = null, // antigravity-login.mjs's, from AGY_AUTH_FILE
  upstream = (host) => `https://${host}`, // the tests' servers
  log = () => {},
}) {
  const proxies = Object.entries(RELAYED_PATHS).map(([host, path]) => {
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
          : login
            ? { base: new URL(`${upstream(host)}/`), what: "Google" }
            : { missing: "the operator set no AGY_AUTH_FILE" },
      drop: ["authorization"],
      authHeaders: () => login.headers(),
      answered: (run, status, headers) => {
        // Expired early or revoked: the next call refreshes it first.
        if (status === 401) login.refused(headers.authorization);
      },
      log,
    });
    return { prefix, handle };
  });

  async function handle(req, res) {
    const proxy = proxies.find((p) => req.url.startsWith(p.prefix)) ?? proxies[0];
    return proxy.handle(req, res);
  }

  // The plan's tokens, which runs' output must not publish either (runs.mjs).
  return { handle, secrets: () => login?.secrets() ?? [] };
}
