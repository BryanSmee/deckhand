// Edge's metrics (#655): what reaches Deckhand from outside. GitHub's webhooks and what became of
// each, the redeliveries edge asks for, the public port's requests by route, sign-ins, the
// dashboard's active users and its open log streams. Declared on the service's registry
// (../lib/metrics.mjs), served on METRICS_PORT.
//
// What the internet sends (an event's name, a path) never becomes a label as it is: an event
// outside those GitHub sends the App is `other`, and a path is its route's pattern
// (`/api/runs/:id/stream`), `other` for one edge doesn't serve, so no request makes a series.
import { APP_EVENTS } from "../listener/github-app.mjs";
import { SHOT_PATH } from "../lib/shots.mjs";
import { leaseMetric, OTHER } from "../lib/metrics.mjs";
import { countKeys } from "../lib/store.mjs";

// The events GitHub sends: the App's (APP_EVENTS), and those it sends every App unasked.
export const WEBHOOK_EVENTS = [
  ...APP_EVENTS,
  "ping",
  "installation",
  "installation_repositories",
  "installation_target",
  "github_app_authorization",
  "meta",
];

// What became of a delivery:
//   accepted       on the stream, for the orchestrator
//   duplicate      already taken (GitHub's second send, the other copy's), or a commit's CI
//                  change already waiting
//   ignored        not JSON, or a CI change for a repo that isn't allowed: answered, dropped
//   bad_signature  no signature, or one the webhook secret doesn't verify
//   refused        while starting (no App yet) or draining (SIGTERM): GitHub marks it failed,
//                  the redeliveries ask for it again
//   too_large      over edge's cap, as its content-length said
//   busy           no place to read it (too many being read at once)
//   unread         its body cut short, too slow, or over the cap without saying so
//   failed         the store couldn't keep it (503: asked again)
export const WEBHOOK_RESULTS = [
  "accepted",
  "duplicate",
  "ignored",
  "bad_signature",
  "refused",
  "too_large",
  "busy",
  "unread",
  "failed",
];

// The dashboard's API actions on a repo (../listener/work.mjs, repos.mjs, discussions.mjs).
const REPO_ACTIONS = [
  "issues",
  "work",
  "answer",
  "rerun",
  "review",
  "dismiss",
  "inbox",
  "lane",
  "order",
  "analyze",
  "onboard",
  "refresh",
  "config",
  "discussions",
];

// The public port's routes: [pattern, test]. A string tests the path itself.
const ROUTES = [
  ["/", "/"],
  ["/health", "/health"],
  ["/ready", "/ready"],
  ["/webhook", "/webhook"],
  ["/status", "/status"],
  ["/setup", "/setup"],
  ["/setup/callback", "/setup/callback"],
  ["/auth/login", "/auth/login"],
  ["/auth/callback", "/auth/callback"],
  ["/auth/logout", "/auth/logout"],
  ["/shots/:folder/:name", SHOT_PATH],
  ["/mcp", /^\/mcp\/?$/],
  ["/.well-known/oauth-protected-resource", /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/],
  ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server"],
  ["/oauth/register", "/oauth/register"],
  ["/oauth/authorize", "/oauth/authorize"],
  ["/oauth/token", "/oauth/token"],
  ["/oauth/revoke", "/oauth/revoke"],
  ["/api/mcp/clients", "/api/mcp/clients"],
  ["/api/mcp/clients/:id/revoke", /^\/api\/mcp\/clients\/[A-Za-z0-9_-]+\/revoke$/],
  ["/api/state", "/api/state"],
  ["/api/server", "/api/server"],
  ["/api/github-status", "/api/github-status"],
  ["/api/health", "/api/health"],
  ["/api/sync", "/api/sync"],
  ["/api/review", "/api/review"],
  ["/api/runs/:id/stream", /^\/api\/runs\/[\w.-]+\/stream$/],
  ["/api/repos", "/api/repos"],
  ["/api/repos/refresh", "/api/repos/refresh"],
  ...REPO_ACTIONS.map((action) => [
    `/api/repos/:owner/:repo/${action}`,
    new RegExp(`^/api/repos/[\\w.-]+/[\\w.-]+/${action}$`),
  ]),
  [
    "/api/repos/:owner/:repo/discussions/:number",
    /^\/api\/repos\/[\w.-]+\/[\w.-]+\/discussions\/\d+$/,
  ],
  [
    "/api/repos/:owner/:repo/discussions/:number/comments",
    /^\/api\/repos\/[\w.-]+\/[\w.-]+\/discussions\/\d+\/comments$/,
  ],
  // The dashboard's build: its scripts and styles, and the files at its root (theme.js, icons).
  ["/assets/:file", /^\/assets\/[^/]+$/],
  ["/:file", /^\/[^/]+\.[a-z0-9]+$/i],
];
export const ROUTE_PATTERNS = [...ROUTES.map(([pattern]) => pattern), OTHER];

// A path's route pattern, `other` for none of edge's.
export function routeOf(path) {
  const found = ROUTES.find(([, test]) =>
    typeof test === "string" ? test === path : test.test(path),
  );
  return found ? found[0] : OTHER;
}

// A status as its class (`4xx`), `none` when the client left before an answer. Anyone can get a
// 400, 401 or 503 on any route without a session: exact statuses would make route × status a
// bound only the cap on series holds, and past it a signed-in user's 200 would be `other`.
export const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx", "none"];
export const statusClass = (res) => (res.headersSent ? `${String(res.statusCode)[0]}xx` : "none");

export const SIGN_IN_RESULTS = [
  "allowed", // a session cookie given
  "refused", // signed in on GitHub as someone not in ALLOWED_USERS
  "expired", // back from GitHub without its state (a sign-in left too long, another browser)
  "cancelled", // GitHub sent an error back: Cancel on its authorize page
  "failed", // GitHub refused the code, didn't say who it was, or didn't answer; or no App yet
];

// A user counts as active this long after their last request with a session.
export const ACTIVE_MS = 15 * 60_000;
// A user's mark, written again at most this often by each copy.
const MARK_MS = 60_000;
// The store's keys of the users active: one each, expiring ACTIVE_MS after their last request.
const ACTIVE_PREFIX = "active-users/";

// `store`: edge's, which both copies share, so that both count the same users. → what edge's
// modules call: webhook(event, result), redelivered(), request(req, res), signIn(result),
// seen(login), stream() → its end.
export function edgeMetrics(registry, { store, now = Date.now }) {
  const webhooks = registry.counter(
    "deckhand_webhooks_received_total",
    "GitHub's webhook deliveries, by event and what became of them.",
    {
      labels: ["event", "result"],
      values: { event: [...WEBHOOK_EVENTS, OTHER], result: WEBHOOK_RESULTS },
    },
  );
  const redeliveries = registry.counter(
    "deckhand_webhooks_redelivered_total",
    "Failed deliveries edge asked GitHub to send again.",
  );
  const requests = registry.counter(
    "deckhand_http_requests_total",
    "Requests on the public port, by route (its pattern) and status class (2xx…, none).",
    {
      labels: ["route", "status"],
      values: { route: ROUTE_PATTERNS, status: STATUS_CLASSES },
      // Every declared pair: the cap is never what bounds it.
      maxSeries: ROUTE_PATTERNS.length * (STATUS_CLASSES.length + 1),
    },
  );
  const durations = registry.histogram(
    "deckhand_http_request_duration_seconds",
    "How long requests on the public port took, from their start to their answer's end (a live log's whole life), in seconds.",
    { labels: ["route"], values: { route: ROUTE_PATTERNS } },
  );
  const signIns = registry.counter(
    "deckhand_sign_ins_total",
    "Sign-ins to the dashboard, by result.",
    { labels: ["result"], values: { result: SIGN_IN_RESULTS } },
  );
  const streams = registry.gauge(
    "deckhand_log_streams_open",
    "Runs' live logs this copy is streaming to a browser.",
  );
  registry.gauge(
    "deckhand_sessions_active",
    "Users signed in to the dashboard who used it in the last 15 minutes, on any copy.",
    { collect: () => countKeys(store, ACTIVE_PREFIX) },
  );

  // When this copy last marked each login.
  const marked = new Map();

  return {
    webhook(event, result) {
      webhooks.inc({ event: WEBHOOK_EVENTS.includes(event) ? event : OTHER, result });
    },
    redelivered: () => redeliveries.inc(),
    // Counted once its answer ends, or the client goes first (status `none` before an answer).
    request(req, res) {
      const route = routeOf((req.url ?? "").split("?")[0]);
      const done = durations.startTimer({ route });
      res.once("close", () => {
        done();
        requests.inc({ route, status: statusClass(res) });
      });
    },
    signIn: (result) => signIns.inc({ result }),
    // A request with a session: its user's mark kept fresh, once a minute at most. Nobody
    // waits for it (the tests do): a mark the store didn't keep is written at the next request.
    seen(login) {
      const at = now();
      if (at - (marked.get(login) ?? -Infinity) < MARK_MS) return Promise.resolve();
      marked.set(login, at);
      for (const [other, when] of marked) if (at - when >= ACTIVE_MS) marked.delete(other);
      return store.set(`${ACTIVE_PREFIX}${login}`, at, { ttlMs: ACTIVE_MS }).then(
        () => {},
        () => marked.delete(login),
      );
    },
    // A live log streaming: → its end, once.
    stream() {
      streams.inc();
      let open = true;
      return () => {
        if (open) streams.dec();
        open = false;
      };
    },
  };
}

// Every metric edge's server declares (server.mjs), and test/metrics-services.test.mjs: its own
// and the redeliveries' lease (`redeliveries()`: whether this copy polls). → { counted:
// edgeMetrics()'s hooks, leases: leaseMetric()'s }.
export function declareMetrics(registry, { store, redeliveries, now }) {
  return {
    counted: edgeMetrics(registry, { store, now }),
    leases: leaseMetric(registry, { "edge/redeliveries": redeliveries }),
  };
}
