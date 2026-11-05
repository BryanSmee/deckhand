// The github service (#502, docs/services.md): the one service holding the GitHub App's key and
// its installation tokens. It serves
//
//   - the runs' GitHub gateway (/relay/<host>/…, ../listener/github-gateway.mjs) and git gateway
//     (/git/…, ../listener/git-gateway.mjs), which the egress proxy sends a sandbox's calls to,
//     vouching for the network (or pod) they came from (`x-deckhand-sandbox`, as the listener's
//     egress policy told it) and passing the sandbox's own Authorization on in
//     `x-deckhand-run-authorization`: its own is the proxy's service token;
//   - the orchestrator's and edge's own GitHub calls, made with an installation token they never
//     get: as a repo's installation (/as/:owner/:repo/<GitHub's path>), GraphQL
//     (/graphql/:owner/:repo), as the App (/as-app/…) and as one installation (/as-installation/
//     :id/…). Edge only reads: GETs, and GraphQL without a mutation. GitHub's answer comes back
//     as it is, its status in `x-github-status` (the service's own refusals have none);
//   - the runs as the orchestrator decided them (PUT, GET, DELETE /runs/:id: github/runs.mjs),
//     the listener's reactions (PUT /reactions), and the events the orchestrator reads (GET
//     /events, POST /events/ack): pushes, a run's notes, the pull requests runs changed;
//   - the App itself: its public parts (GET /app), /setup's manifest conversion (POST
//     /app/manifest), a listener's key from before this service (PUT /app);
//   - the runner's repos' tarballs and blobs (build contexts, image tags).
//
// Each route names its callers (ROUTES, ../lib/service-token.mjs serviceGuard()). The
// orchestrator's calls that change something carry its fencing epoch, refused when stale (409,
// ../lib/fence.mjs), and may carry an idempotency key: a write asked again with the same key is
// made once, its first answer given again (the orchestrator's handover, #506). Two copies may run
// side by side on one store: a run's state, its calls in flight, the listener's reactions, the
// epoch and the keys are there; each copy keeps its own installation tokens and git mirrors,
// caches only.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RUN_AUTH_HEADER, SANDBOX_HEADER } from "../lib/broker-client.mjs";
import { drainable } from "../lib/drain.mjs";
import { createFence } from "../lib/fence.mjs";
import { fingerprintRedactor, MAX_PRINTS } from "../lib/fingerprints.mjs";
import { healthAnswer, healthInfo } from "../lib/health.mjs";
import { readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { repoAllowed } from "../listener/config.mjs";
import { pullEntry } from "../listener/events.mjs";
import { createGitGateway } from "../listener/git-gateway.mjs";
import { createForkChecks } from "../listener/github-forks.mjs";
import { createGithubGateway } from "../listener/github-gateway.mjs";
import { createGraphqlChecks, createValidator, lookupNodes } from "../listener/github-graphql.mjs";
import { createPullChecks } from "../listener/github-pulls.mjs";
import { createReadChecks, createWriteChecks } from "../listener/github-writes.mjs";
import { createGitHub, getJson } from "../listener/github.mjs";
import { repoPath } from "../listener/repo-config.mjs";
import { parse } from "../listener/vendor/graphql.mjs";
import { NO_METRICS } from "./metrics.mjs";
import { createRuns, STREAM } from "./runs.mjs";

// GitHub's status, the orchestrator's key for a write it may ask again (#506), the statuses a
// call expects (404, 410: not logged as failures): client.mjs's, which the listener has alone.
import { EXPECTED_HEADER, GITHUB_STATUS, IDEMPOTENCY_HEADER } from "./client.mjs";
import { withRequest } from "../lib/log.mjs";
export { EXPECTED_HEADER, GITHUB_STATUS, IDEMPOTENCY_HEADER };

// Where the operator's credentials' fingerprints are kept, and how often a copy reads them.
const FINGERPRINTS_KEY = "fingerprints";
const FINGERPRINTS_MS = 10_000;
// The most sets of the models service's fingerprints kept (one per copy of it, and those it gave
// before a login's refresh, for a while: listener/models-service.mjs).
const MAX_SETS = 16;

// The models service's fingerprints (lib/redact.mjs fingerprints()'s, #504), as the orchestrator
// relays them: redact() takes them among the secrets. Anything else is dropped.
function printSets(sets) {
  if (!Array.isArray(sets)) return [];
  return sets
    .filter((s) => typeof s?.salt === "string" && Array.isArray(s.values))
    .slice(-MAX_SETS);
}

const SANDBOX = ["proxy"];
const READERS = ["edge", "orchestrator"];
const WRITER = ["orchestrator"];
const each = (methods, path, callers) =>
  Object.fromEntries(methods.map((m) => [`${m} ${path}`, callers]));
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

export const ROUTES = {
  // The sandboxes', through the egress proxy.
  ...each(["GET", "HEAD", ...WRITES], "/relay/*", SANDBOX),
  ...each(["GET", "POST"], "/git/*", SANDBOX),
  // The listener's own GitHub calls: edge reads, the orchestrator writes too.
  "GET /as/:owner/:repo/*": READERS,
  ...each(WRITES, "/as/:owner/:repo/*", WRITER),
  "POST /graphql/:owner/:repo": READERS,
  "GET /as-app/*": READERS,
  // The App's one write Deckhand makes: a delivery GitHub couldn't hand over, asked again by
  // edge, which takes the webhooks (redeliveries.mjs, #506). Never a token minted
  // (`…/access_tokens`), a webhook's config changed or an installation removed: no other write
  // as the App is routed.
  "POST /as-app/app/hook/deliveries/:id/attempts": ["edge"],
  "GET /as-installation/:id/*": READERS,
  // The App.
  "GET /app": READERS,
  // A listener's key, which the orchestrator has its data volume of; /setup's conversion, edge's.
  "PUT /app": WRITER,
  "POST /app/manifest": ["edge"],
  // The runs, as the orchestrator decided them, and what they did.
  "PUT /runs/:id": WRITER,
  "GET /runs/:id": WRITER,
  "DELETE /runs/:id": WRITER,
  "PUT /reactions": WRITER,
  // The operator's credentials' fingerprints, which its gateway redacts by (lib/fingerprints.mjs).
  "PUT /fingerprints": WRITER,
  "GET /events": WRITER,
  "POST /events/ack": WRITER,
  // The runner's: a repo's files, and a file's blob id, nothing else of GitHub's.
  "GET /tarballs/:owner/:repo": ["runner"],
  "GET /tarballs/:owner/:repo/:ref": ["runner"],
  "GET /blobs/:owner/:repo": ["runner"],
};

// The longest body the orchestrator sends (a reply is 65 536 characters at most) and the most of
// a GitHub answer kept for an idempotency key.
const MAX_BODY = 16 * 1024 * 1024;
const MAX_KEPT = 1024 * 1024;
// How long a key's answer is given again, how long a call in flight holds it, and how long one
// asked again waits for it.
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const PENDING_TTL_MS = 5 * 60_000;
const PENDING_WAIT_MS = 30_000;
// The orchestrator's long poll of the events.
export const EVENTS_WAIT_MS = 20_000;
const CONSUMER = "orchestrator";

// GitHub's headers passed on to the listener (its pages, its rate limits, a redirect).
const KEPT_HEADERS = [
  "content-type",
  "link",
  "etag",
  "last-modified",
  "location",
  "retry-after",
  "x-github-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-used",
  "x-ratelimit-resource",
  "x-accepted-github-permissions",
];

// What GitHub names a repository's owner and name, and a ref: decoded, nothing that would make
// the API path another one (`..`, `?`, a `/` in a name).
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const validName = (name) => NAME.test(name) && name !== "." && name !== "..";
const validRef = (ref) =>
  /^[A-Za-z0-9_./-]{1,250}$/.test(ref) &&
  ref.split("/").every((part) => part && part !== "." && part !== "..");

function decoded(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new Refused(400, "not a plain path");
  }
}

// owner, name → "owner/name", or a 400.
function repoOf(owner, name) {
  const [o, n] = [decoded(owner), decoded(name)];
  if (!validName(o) || !validName(n)) throw new Refused(400, "not a repository");
  return `${o}/${n}`;
}

// Whether a GraphQL document mutates (or subscribes): what edge may not send. One that doesn't
// parse is refused too: GitHub would refuse it anyway.
export function mutates(query) {
  let doc;
  try {
    doc = parse(String(query ?? ""));
  } catch {
    return true;
  }
  return doc.definitions.some((d) => d.kind === "OperationDefinition" && d.operation !== "query");
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// `app`: app.mjs createAppHolder()'s; `broker`: the broker's keys, as
// ../listener/broker-service.mjs gives them ({ keys(), serviceKeys(), unknownKey() }); `bound`:
// the callers' networks (../lib/service-token.mjs networkCallers()), or null on Kubernetes;
// `policies`: ../listener/policies.mjs's, for the runs' writes and pushes; `grants`: { projects(repo),
// workflows(repo), workflowSecrets(repo) }: the projects the operator grants a repo's runs
// (allow_projects), and whether it grants `workflows` and `workflow_secrets`.
export function createGithubService({
  config,
  store,
  app,
  broker,
  bound,
  policies,
  grants = { projects: () => [], workflows: () => false, workflowSecrets: () => false },
  mirrorDir,
  fetch = globalThis.fetch,
  now = Date.now,
  sleep = realSleep,
  log = () => {},
  // The gateways' own options, the tests' (maxInFlight, idleMs…).
  gatewayOptions = {},
  // What GET /health says: when it started, its version (../lib/health.mjs).
  health = healthInfo(),
  // Its metrics' hooks (metrics.mjs githubMetrics()): none counted without.
  metrics = NO_METRICS,
}) {
  const guard = serviceGuard({
    service: "github",
    keys: { get: (kid) => broker.serviceKeys().get(kid) },
    routes: ROUTES,
    bound,
    now,
  });
  // A caller's token signed with a key this copy doesn't know yet (its broker's keys not read
  // since the broker started, or changed): read again once, then checked again, as a run token
  // is (runs.mjs check()).
  async function guarded(req) {
    try {
      return guard(req);
    } catch (error) {
      if (!(error instanceof Refused) || !/unknown key/.test(error.message)) throw error;
      await broker.unknownKey();
      return guard(req);
    }
  }
  const fence = createFence({ store, service: "github service", now });
  const runs = createRuns({
    store,
    keys: () => broker.keys(),
    unknownKey: broker.unknownKey,
    now,
    log,
  });
  const { github } = createGitHub(() => app.get());
  const lookup = (repo, path) => getJson(github, repo, path, [404, 410]);
  const bot = () => app.get()?.identity().name ?? null;
  // The policies' messages name the bot (policies.mjs).
  if (config) Object.defineProperty(config, "bot", { get: bot, configurable: true });

  // Whether a repo's runs read projects: kept a while per repo rather than reading the grants
  // folder on each call (a broken one said once per while).
  const PROJECT_READS_MS = 30_000;
  const projectReads = new Map();
  function readsProjects(repo) {
    const known = projectReads.get(repo);
    if (known && now() - known.at < PROJECT_READS_MS) return known.reads;
    let reads = false;
    try {
      reads = grants.projects(repo).length > 0;
    } catch (error) {
      log(`GitHub gateway: ${repo}: its grants: ${error.message ?? error}`);
    }
    projectReads.set(repo, { at: now(), reads });
    return reads;
  }

  let gitGateway = null;
  const pullChecks = createPullChecks({
    lookup,
    // A granted repo's workflows, in the merge a new or changed pull request runs them from.
    checkWorkflows: (repo, branch, base) => gitGateway.checkBranch(repo, branch, base),
    // The dashboard has the change at once, whether its delivery comes or not.
    record: (repo, pr, readyAt) =>
      void runs.event({ type: "pull", ...pullEntry(repo, pr, readyAt) }),
    log,
  });
  const writeChecks = createWriteChecks({
    lookup,
    bot,
    listenerReacted: runs.reacted,
    users: (repo, run) => run?.users ?? [],
    needsInputLabel: (run) => run?.needsInputLabel ?? null,
    projects: grants.projects,
    policies,
    pulls: pullChecks,
    log,
  });
  const forkChecks = createForkChecks({
    get: (repo, path, expected) => getJson(github, repo, path, expected),
    shared: runs.advertised,
    log,
  });
  const graphqlChecks = createGraphqlChecks({
    validator: createValidator().check,
    files: forkChecks.checkGraphql,
    nodes: (repo, ids) => lookupNodes(github, repo, ids),
    checkWrite: writeChecks.checkWrite,
    budget: writeChecks.budget,
    log,
  });
  // The network (or pod) a sandbox's call came from, as vouched for (sandboxCall()).
  const sandboxOf = (req) => req.deckhandSandbox ?? "";
  const gatewayRuns = {
    check: (credential, from) =>
      runs.check(credential, typeof from === "string" ? from : sandboxOf(from)),
  };
  const gateway = createGithubGateway({
    broker: gatewayRuns,
    app: () => app.get(),
    api: config.githubApi,
    web: config.githubUrl,
    forks: forkChecks,
    clientOf: async (req) => sandboxOf(req),
    runFrom: (sandbox) => runs.bySandbox(sandbox),
    // The run's tokens are the broker's, redacted by their shape (lib/redact.mjs), and the one
    // the call carries; the operator's credentials, which this service doesn't hold, by the
    // fingerprints the orchestrator sends (docs/security.md, The GitHub gateway): the models
    // service's sets here, the others through scrub().
    secrets: () => sets,
    scrub: () => (text) => redactor(text),
    checkWrite: writeChecks.check,
    checkGraphql: graphqlChecks.check,
    checkRead: createReadChecks({ policies }).checkRead,
    wroteWrite: writeChecks.answered,
    readsProjects,
    repoId: async (repo) => (await lookup(repo, `/repos/${repo}`))?.id ?? null,
    inFlight: runs.inFlight,
    observe: metrics.api,
    onGit: metrics.git,
    log,
    ...gatewayOptions,
  });
  gitGateway = createGitGateway({
    broker: gatewayRuns,
    app: () => app.get(),
    policies,
    allowWorkflows: grants.workflows,
    allowWorkflowSecrets: grants.workflowSecrets,
    forks: forkChecks,
    githubUrl: config.githubUrl,
    mirrorDir,
    fetch,
    onGit: metrics.git,
    onRefused: metrics.refused,
    log,
  });

  // The operator's credentials' fingerprints, as the orchestrator last sent them (PUT
  // /fingerprints), read again from the store every FINGERPRINTS_MS: both copies redact by them.
  let redactor = (text) => text;
  let sets = [];
  let readAt = -Infinity;
  async function fingerprints() {
    if (now() - readAt < FINGERPRINTS_MS) return;
    readAt = now();
    try {
      const kept = await store.get(FINGERPRINTS_KEY);
      redactor = fingerprintRedactor(kept);
      sets = printSets(kept?.sets);
    } catch (error) {
      log(`GitHub service: the operator's credentials' fingerprints (${error.message})`);
    }
  }

  // --- The sandboxes' calls -----------------------------------------------------------------

  // The vouched network kept on the request, apart from its headers (which the gateway passes
  // on to GitHub), and the sandbox's own Authorization put back where the gateways read it.
  async function sandboxCall(req, res, path) {
    await fingerprints();
    const sandbox = req.headers[SANDBOX_HEADER];
    req.deckhandSandbox = typeof sandbox === "string" ? sandbox : "";
    const auth = req.headers[RUN_AUTH_HEADER];
    delete req.headers[SANDBOX_HEADER];
    delete req.headers[RUN_AUTH_HEADER];
    if (typeof auth === "string" && auth) req.headers.authorization = auth;
    else delete req.headers.authorization;
    return path.startsWith("/git/") ? gitGateway.handle(req, res) : gateway.handle(req, res);
  }

  // --- The listener's own calls -------------------------------------------------------------

  const headersOf = (answer) =>
    Object.fromEntries(
      KEPT_HEADERS.filter((h) => answer.headers.get(h) !== null).map((h) => [
        h,
        answer.headers.get(h),
      ]),
    );

  function sendAnswer(res, { status, headers, body }) {
    res.writeHead(200, {
      ...headers,
      [GITHUB_STATUS]: String(status),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  async function streamAnswer(res, answer) {
    res.writeHead(200, {
      ...headersOf(answer),
      [GITHUB_STATUS]: String(answer.status),
      "cache-control": "no-store",
    });
    if (!answer.body) return res.end();
    await pipeline(Readable.fromWeb(answer.body), res);
  }

  // A write's answer, read whole, made once per idempotency key: asked again with the same key,
  // its first answer (a success's: a failure may be tried again) without asking GitHub; while
  // the first is in flight (through the other copy), once it is over.
  // A GraphQL answer whose errors came with a 200 (a rate limit, a refusal): not kept for its
  // key, as a failed status isn't, so that the write asked again is tried again.
  function graphqlFailed(answer) {
    if (!answer.url?.startsWith("/graphql/")) return false;
    try {
      return Array.isArray(JSON.parse(answer.body.toString("utf8"))?.errors);
    } catch {
      return true;
    }
  }

  // `caller`: the guard's. Only the orchestrator's keys count, each its own with the call's
  // method and path: edge, which only reads, can't take a key the orchestrator's write will
  // carry, and have its answer given in that write's place.
  async function once(req, caller, make) {
    const read = async () => {
      const answer = await make();
      return {
        status: answer.status,
        headers: headersOf(answer),
        body: Buffer.from(await answer.arrayBuffer()),
        url: req.url,
      };
    };
    const key = req.headers[IDEMPOTENCY_HEADER];
    if (caller !== "orchestrator" || typeof key !== "string" || !key) return read();
    const scoped = JSON.stringify([caller, req.method, req.url, key]);
    const slot = `idempotency/${createHash("sha256").update(scoped).digest("hex")}`;
    const started = now();
    for (;;) {
      if (await store.setIfAbsent(slot, { state: "pending" }, { ttlMs: PENDING_TTL_MS })) {
        let answer;
        try {
          answer = await read();
        } catch (error) {
          await store.delete(slot).catch(() => {});
          throw error;
        }
        if (answer.status >= 200 && answer.status < 300 && !graphqlFailed(answer)) {
          const kept = answer.body.length <= MAX_KEPT ? answer.body.toString("base64") : null;
          const done = {
            state: "done",
            status: answer.status,
            headers: answer.headers,
            body: kept,
          };
          await store.set(slot, done, { ttlMs: IDEMPOTENCY_TTL_MS }).catch(async (error) => {
            log(`GitHub service: ${key}: its answer isn't kept (${error.message})`);
            await store.delete(slot).catch(() => {});
          });
        } else await store.delete(slot);
        return answer;
      }
      const known = await store.get(slot);
      if (known?.state === "done") {
        log(`GitHub service: ${key} asked again: its first answer given`);
        return {
          status: known.status,
          headers: { ...known.headers, "x-deckhand-replayed": "1" },
          body: Buffer.from(known.body ?? "", "base64"),
        };
      }
      if (known && now() - started >= PENDING_WAIT_MS) {
        throw new Refused(409, `a call with the idempotency key ${key} is still in flight`);
      }
      if (known) await sleep(200);
    }
  }

  // A call as the App's: `make()` → GitHub's Response. A GET streamed, a write made once.
  async function asGitHub(req, res, caller, make) {
    if (!app.get()) throw new Refused(412, "no GitHub App yet: set it up at /setup");
    if (req.method === "GET") return streamAnswer(res, await reached(make));
    sendAnswer(res, await once(req, caller, () => reached(make)));
  }

  // `make()`'s answer, GitHub refusing the App's own setup of the call (its installation looked
  // up, a token minted: github-app.mjs json(), GitHub's status on the error) passed on as the
  // service's refusal with that status: a repository out of the App's reach is a 404 to the
  // caller, not the service failing, which a caller may take for a hiccup (policies.mjs
  // transient(), #785). A 5xx or a rate limit stays a failure.
  async function reached(make) {
    try {
      return await make();
    } catch (error) {
      const status = error?.status;
      if (error instanceof Refused || !Number.isInteger(status)) throw error;
      if (status < 400 || status >= 500 || status === 429) throw error;
      throw new Refused(status, `GitHub answered ${status} for the App's access to it`);
    }
  }

  async function bodyOf(req) {
    const length = (req.headers["content-length"] ?? "").trim();
    if (length === "0" || (!length && req.headers["transfer-encoding"] === undefined)) {
      return undefined;
    }
    return readJsonBody(req, MAX_BODY);
  }

  const expected = (req) =>
    String(req.headers[EXPECTED_HEADER] ?? "")
      .split(",")
      .map(Number)
      .filter(Number.isInteger);

  // --- The runner's -------------------------------------------------------------------------

  async function tarball(res, repo, ref) {
    // The repos the operator lets through, as for a run.
    if (!repoAllowed(config, repo)) throw new Refused(403, `${repo} isn't allowed`);
    if (!app.get()) throw new Refused(412, "no GitHub App yet");
    const path = `/repos/${repo}/tarball${ref === undefined ? "" : `/${encodeURIComponent(ref)}`}`;
    const answer = await github(repo, "GET", path);
    if (!answer.ok)
      throw new Refused(answer.status === 404 ? 404 : 502, `GitHub: ${answer.status}`);
    res.writeHead(200, { "content-type": "application/gzip" });
    return pipeline(Readable.fromWeb(answer.body), res);
  }

  async function blob(res, repo, url) {
    const path = url.searchParams.get("path") ?? "";
    const ref = url.searchParams.get("ref");
    if (!repoPath(path) || (ref !== null && !validRef(ref))) {
      throw new Refused(400, "not a repository, a path and a ref");
    }
    if (!repoAllowed(config, repo)) throw new Refused(403, `${repo} isn't allowed`);
    if (!app.get()) throw new Refused(412, "no GitHub App yet");
    const where = `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    const answer = await github(
      repo,
      "GET",
      ref === null ? where : `${where}?ref=${encodeURIComponent(ref)}`,
      null,
      [404],
    );
    if (answer.status === 404) throw new Refused(404, `no ${path} in ${repo}`);
    if (!answer.ok) throw new Refused(502, `GitHub: ${answer.status}`);
    const file = await answer.json();
    if (file?.type !== "file") throw new Refused(404, `${path} of ${repo} is not a file`);
    return sendJson(res, { sha: file.sha });
  }

  // --- The orchestrator's events ------------------------------------------------------------

  async function events(res, url) {
    const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, EVENTS_WAIT_MS);
    const until = now() + wait;
    let gone = false;
    res.on("close", () => (gone = true));
    for (;;) {
      const found = await store.read(STREAM, CONSUMER, { count: 100 });
      if (found.length || gone || now() >= until) return sendJson(res, { events: found });
      await sleep(Math.min(250, until - now()));
    }
  }

  // --- Routing ------------------------------------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, "http://github");
    const path = url.pathname;
    if (req.method === "GET" && path === "/health") {
      return sendJson(res, healthAnswer(health, { app: !!app.get() }));
    }
    if (req.method === "GET" && path === "/ready") {
      // Out of rotation until the broker answered it too: run tokens and callers can't be checked
      // before, and a new pod's calls may not get out yet (#391).
      const ready = !draining && (broker.ready?.() ?? true);
      return sendJson(res, { ok: ready, app: !!app.get() }, ready ? 200 : 503);
    }
    const caller = await guarded(req);
    // What it asks GitHub from here on is that caller's (metrics.mjs).
    return metrics.as(caller, () => routed(req, res, url, path, caller));
  }

  async function routed(req, res, url, path, caller) {
    if (path.startsWith("/relay/") || path.startsWith("/git/")) return sandboxCall(req, res, path);
    // What the orchestrator changes carries its epoch: a copy that lost its lease changes nothing.
    if (caller === "orchestrator" && req.method !== "GET") await fence(req);

    let m = /^\/as\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (m) {
      const repo = repoOf(m[1], m[2]);
      const body = await bodyOf(req);
      return asGitHub(req, res, caller, () =>
        app.get().request(repo, req.method, m[3] + url.search, body, expected(req)),
      );
    }
    m = /^\/graphql\/([^/]+)\/([^/]+)$/.exec(path);
    if (m) {
      const repo = repoOf(m[1], m[2]);
      const body = await readJsonBody(req, MAX_BODY);
      if (caller !== "orchestrator" && mutates(body?.query)) {
        throw new Refused(403, `${caller} may not send a GraphQL mutation`);
      }
      if (!app.get()) throw new Refused(412, "no GitHub App yet: set it up at /setup");
      return sendAnswer(
        res,
        await once(req, caller, () =>
          reached(() => app.get().request(repo, "POST", "/graphql", body)),
        ),
      );
    }
    m = /^\/as-app(\/.*)$/.exec(path);
    // What ROUTES lets through, checked again here: a GET, or a delivery's redelivery.
    if (m && req.method !== "GET" && !/^\/app\/hook\/deliveries\/\d+\/attempts$/.test(m[1])) {
      throw new Refused(403, `no ${req.method} as the App but a delivery's redelivery`);
    }
    if (m) return asGitHub(req, res, caller, () => app.get().asApp(req.method, m[1] + url.search));
    m = /^\/as-installation\/(\d+)(\/.*)$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      return asGitHub(req, res, caller, () =>
        app.get().asInstallation(id, req.method, m[2] + url.search),
      );
    }
    if (path === "/app") {
      if (req.method === "GET") return sendJson(res, app.info());
      const refused = app.handOver(await readJsonBody(req, 64 * 1024));
      if (refused) throw new Refused(refused.status, refused.message);
      return sendJson(res, app.info());
    }
    if (path === "/app/manifest") {
      const { code } = (await readJsonBody(req, 64 * 1024)) ?? {};
      const made = await app.convert(code);
      if (!made.credentials) throw new Refused(made.status, made.message);
      return sendJson(res, made.credentials);
    }
    m = /^\/runs\/([^/]+)$/.exec(path);
    if (m) {
      const id = decoded(m[1]);
      if (req.method === "PUT") {
        if (!(await runs.put(id, await readJsonBody(req, MAX_BODY)))) {
          throw new Refused(400, "not a run: its repo?");
        }
        return res.writeHead(204).end();
      }
      if (req.method === "GET") {
        const state = await runs.state(id);
        if (!state) throw new Refused(404, `no run ${id}`);
        return sendJson(res, state);
      }
      return sendJson(res, { state: await runs.end(id) });
    }
    if (path === "/fingerprints") {
      const body = (await readJsonBody(req, 16 * 1024 * 1024)) ?? {};
      const { salt, prints } = body;
      if (typeof salt !== "string" || !Array.isArray(prints) || prints.length > MAX_PRINTS) {
        throw new Refused(400, "salt, prints?");
      }
      if (body.sets !== undefined && !Array.isArray(body.sets)) throw new Refused(400, "sets?");
      const kept = {
        salt,
        prints: prints.filter((p) => typeof p === "string"),
        sets: printSets(body.sets),
      };
      await store.set(FINGERPRINTS_KEY, kept);
      redactor = fingerprintRedactor(kept);
      sets = kept.sets;
      readAt = now();
      return res.writeHead(204).end();
    }
    if (path === "/reactions") {
      const { repo, subject, content, held } = (await readJsonBody(req, 64 * 1024)) ?? {};
      if (![repo, subject, content].every((v) => typeof v === "string" && v)) {
        throw new Refused(400, "repo, subject, content?");
      }
      await runs.claim(repo, subject, content, held !== false);
      return res.writeHead(204).end();
    }
    if (path === "/events") return events(res, url);
    if (path === "/events/ack") {
      const { ids } = (await readJsonBody(req, 64 * 1024)) ?? {};
      const acked = await store.ack(STREAM, CONSUMER, Array.isArray(ids) ? ids.map(String) : []);
      return sendJson(res, { acked });
    }
    m = /^\/tarballs\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (m) {
      const ref = m[3] === undefined ? undefined : decoded(m[3]);
      if (ref !== undefined && !validRef(ref)) throw new Refused(400, "not a ref");
      return tarball(res, repoOf(m[1], m[2]), ref);
    }
    m = /^\/blobs\/([^/]+)\/([^/]+)$/.exec(path);
    if (m) return blob(res, repoOf(m[1], m[2]), url);
    throw new Refused(404, "no such endpoint");
  }

  let draining = false;
  const server = drainable(
    createServer(
      withRequest((req, res) =>
        handle(req, res).catch((error) => {
          if (res.headersSent) {
            if (!(error instanceof Refused))
              (log.error ?? log)(
                `GitHub service: ${req.method} ${req.url.split("?")[0]}: ${error.stack ?? error}`,
              );
            return res.destroy();
          }
          // A body left unread: dropped, so the answer reaches the client.
          req.resume();
          if (error instanceof Refused)
            return sendJson(res, { message: error.message }, error.status);
          (log.error ?? log)(
            `GitHub service: ${req.method} ${req.url.split("?")[0]}: ${error.stack ?? error}`,
          );
          sendJson(res, { message: "the github service failed" }, 500);
        }),
      ),
    ),
  );
  server.startDraining = () => (draining = true);
  return { server, runs, gateway, gitGateway };
}
