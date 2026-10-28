// GitHub gateway: a sandbox's only way to GitHub. It holds no token: the egress proxy decrypts
// its calls to GitHub's hosts (egress.mjs githubHosts(), with Deckhand's CA, which it trusts)
// and hands each one here as /relay/<host>/<path> (../proxy/proxy.mjs), REST, GraphQL, clones
// and fetches alike. Here:
//
// - the call's run is found by the secret it sent in place of a token (`GH_TOKEN`, git's
//   credential helper: ../sandbox/), or by its sandbox's address when it sent none (git's first
//   request, a download with curl); the secret only works from its own sandbox (broker.mjs
//   sentBy()), and a finished run's, another sandbox's or a research run's (NO_TOKEN) get
//   nothing;
// - pushes are refused: they go to the git gateway (git-gateway.mjs, pushInsteadOf);
// - a review's reads of its thread (comments, reviews, review comments) are refused: it reads
//   only what allowed users wrote, from TASK_DIGEST (reviews.mjs);
// - every write's body is redacted (the run's secret, the operator's credentials, the tokens
//   used for it, anything shaped like a GitHub token) before GitHub gets it, and the run's log
//   says so: what a run posts itself would otherwise skip the redaction of its reply and log;
// - the call goes on with a token minted for the run's repo, with its mode's permissions
//   (modes.mjs permissionsFor()), and the answer streams back (upstream.mjs forward()).
//
// Served on the broker's port, which only the runs' networks reach.
import { NOT_ITS_SANDBOX } from "./broker.mjs";
import { NO_TOKEN } from "./github-app.mjs";
import { redact } from "./redact.mjs";
import { baseOf, forward, forwarded, IDLE_MS, MAX_IN_FLIGHT } from "./upstream.mjs";
import { sendJson } from "./web.mjs";

// The largest write body read: GitHub's own limits for an issue or a comment are far below.
export const MAX_WRITE = 16 * 1024 * 1024;
// The redacted writes and refused calls a run's log notes, each once and only so many.
export const MAX_NOTED = 20;

// Where a review may not read (paths under the API's base, without its query): the thread's
// comments, reviews and review comments, the timeline that holds them, and commit comments.
const THREAD_READS = [
  /^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/comments(?:\/|$)/i,
  /^repos\/[^/]+\/[^/]+\/issues\/[^/]+\/(?:comments|timeline)(?:\/|$)/i,
  /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/(?:comments|reviews)(?:\/|$)/i,
  /^repos\/[^/]+\/[^/]+\/(?:commits\/[^/]+\/)?comments(?:\/|$)/i,
];
// The same in GraphQL, read as text until #406 parses it: the fields and types that hold them.
const THREAD_FIELDS =
  /\b(?:comments|reviews|latestReviews|latestOpinionatedReviews|reviewThreads|timeline|timelineItems|IssueComment|CommitComment|DiscussionComment|PullRequestReview|PullRequestReviewComment|PullRequestReviewThread)\b/;
// What git fetches with on the web host; a review reads nothing else there (web pages show the
// comments).
const GIT_READ = /^[^/]+\/[^/]+?(?:\.git)?\/(?:info\/refs|git-upload-pack)$/;
const GIT_PUSH = /\/git-receive-pack$/;

// The secret a call sent in place of a token: `token <secret>` (gh), `Bearer <secret>` or Basic
// with it as the password (git). Undefined without an Authorization header; "" for one that
// holds none.
export function secretOf(header) {
  if (!header) return undefined;
  const [scheme, value = ""] = String(header).trim().split(/\s+/);
  if (/^(?:token|bearer)$/i.test(scheme)) return value;
  if (/^basic$/i.test(scheme)) {
    const pair = Buffer.from(value, "base64").toString("utf8");
    return pair.slice(pair.indexOf(":") + 1);
  }
  return "";
}

// `body` without `secrets` (redact()): each string of its JSON when it is JSON, so an escaped
// character can't split a secret, else as text. Null when nothing was redacted.
export function redactBody(body, secrets) {
  const text = body.toString("utf8");
  let changed = false;
  const clean = (value) => {
    const out = redact(value, secrets);
    if (out !== value) changed = true;
    return out;
  };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const out = clean(text);
    return changed ? Buffer.from(out) : null;
  }
  const walk = (value) =>
    typeof value === "string"
      ? clean(value)
      : Array.isArray(value)
        ? value.map(walk)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), walk(v)]))
          : value;
  const out = walk(parsed);
  // Neither strings nor keys held one, but the raw text does (a number, say): as text.
  if (!changed && redact(text, secrets) !== text) return Buffer.from(clean(text));
  return changed ? Buffer.from(JSON.stringify(out)) : null;
}

// Whether a GraphQL call's body (as text) reads a thread's comments or reviews.
export function readsThread(text) {
  let query = "";
  try {
    query = JSON.stringify(JSON.parse(text));
  } catch {}
  return THREAD_FIELDS.test(text) || THREAD_FIELDS.test(query);
}

// The request's body, up to `max` bytes (null past it), with `idleMs` between chunks at most.
function readBody(req, max, idleMs, clock) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let timer = null;
    const idle = () => {
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        req.destroy();
        reject(new Error(`no bytes for ${Math.round(idleMs / 1000)} s`));
      }, idleMs);
    };
    idle();
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        clock.clearTimeout(timer);
        req.removeAllListeners("data");
        req.resume();
        return resolve(null);
      }
      chunks.push(chunk);
      idle();
    });
    req.on("end", () => (clock.clearTimeout(timer), resolve(Buffer.concat(chunks))));
    req.on("error", (error) => (clock.clearTimeout(timer), reject(error)));
  });
}

export function createGithubGateway({
  broker, // broker.mjs: the run a secret belongs to
  app, // () => the GitHub App (github-app.mjs), or null before /setup
  api, // the listener's GITHUB_API
  web, // its GITHUB_URL
  // req → the address of the sandbox that sent it: the one the egress proxy names when it
  // relayed the call (broker-http.mjs clientAddress()).
  clientOf = async (req) => (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, ""),
  // address → the live run whose sandbox (or engine) has it, or null: a call without a secret.
  runFrom = async () => null,
  // run → the secrets its writes must not carry, besides its tokens: its own secret and the
  // operator's credentials (secrets.mjs operatorSecrets()).
  secrets = () => [],
  log = () => {},
  maxInFlight = MAX_IN_FLIGHT,
  maxWrite = MAX_WRITE,
  idleMs = IDLE_MS,
  clock = globalThis,
}) {
  const apiBase = baseOf(api);
  // GitHub Enterprise Server's GraphQL is beside its REST API (/api/graphql, /api/v3/).
  const graphql = new URL(apiBase.pathname.endsWith("/v3/") ? "../graphql" : "graphql", apiBase);
  const webBase = baseOf(web);
  // run → its calls in flight; run → what its log noted.
  const inFlight = new WeakMap();
  const noted = new WeakMap();

  // GitHub's error shape, which gh shows as is.
  const fail = (res, status, message) => sendJson(res, { message: `Deckhand: ${message}` }, status);

  // A line in the run's log, once per text and up to MAX_NOTED of them.
  function note(run, text) {
    const seen = noted.get(run) ?? new Set();
    noted.set(run, seen);
    if (seen.has(text) || seen.size > MAX_NOTED) return;
    seen.add(text);
    run.note?.(
      seen.size > MAX_NOTED
        ? `Deckhand noted ${MAX_NOTED} of the run's GitHub calls already: the rest aren't`
        : text,
    );
  }

  // /relay/<host>/<path> → { target, api, path }: the URL on GitHub, whether it is the API's
  // (REST or GraphQL) or the web host's, and the path under that base, decoded. Null for a host
  // that isn't GitHub's or a path that would leave it.
  function route(url) {
    const match = /^\/relay\/([^/]+)(\/[^]*)$/.exec(url);
    if (!match) return null;
    const [, host, rest] = match;
    if (rest.startsWith("//") || /\\/.test(rest)) return null;
    for (const base of [apiBase, webBase]) {
      if (base.hostname !== host.toLowerCase()) continue;
      let target;
      try {
        target = new URL(rest, base.origin);
      } catch {
        return null;
      }
      if (target.origin !== base.origin) return null;
      if (base === webBase) return { target, api: false, path: decoded(target.pathname, webBase) };
      const { pathname } = target;
      if (pathname.startsWith(apiBase.pathname) || pathname === graphql.pathname) {
        return { target, api: true, path: decoded(pathname, apiBase) };
      }
      // Not the API's: the web host's, when it is the same host (GitHub Enterprise Server).
    }
    return null;
  }

  // The path under `base`, percent-decoded and with repeated slashes as one: what GitHub reads.
  function decoded(pathname, base) {
    const under = pathname.startsWith(base.pathname)
      ? pathname.slice(base.pathname.length)
      : pathname.slice(1);
    try {
      return decodeURIComponent(under).replace(/\/{2,}/g, "/");
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    const where = route(req.url);
    if (!where || where.path === null) return fail(res, 404, "not a GitHub host it relays");
    const run = await runOf(req, res);
    if (!run) return;
    const call = `${req.method} ${where.target.pathname}`;
    if (!where.api && (GIT_PUSH.test(where.path) || /service=git-receive-pack/.test(req.url))) {
      return fail(res, 403, "pushes go through Deckhand's git gateway (pushInsteadOf)");
    }
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    // A fetch's pack request is a POST, and binary: streamed, never read.
    const streamed = !write || (!where.api && /\/git-upload-pack$/.test(where.path));
    const review = run.mode === "review";
    if (review && refusedToReview(where)) return refuseThread(run, res, call);
    const github = app();
    if (!github) return fail(res, 503, "the GitHub App is not set up");
    const calls = inFlight.get(run) ?? 0;
    if (calls >= maxInFlight) return fail(res, 429, `more than ${maxInFlight} calls at once`);
    inFlight.set(run, calls + 1);
    try {
      let body;
      if (!streamed) {
        body = await readBody(req, maxWrite, idleMs, clock);
        if (body === null) return fail(res, 413, `a write over ${maxWrite} bytes`);
        if (review && where.target.pathname === graphql.pathname && readsThread(String(body))) {
          return refuseThread(run, res, call);
        }
        body = redacted(run, req, body, call);
      }
      await proxied(req, res, run, github, where, body);
    } finally {
      inFlight.set(run, inFlight.get(run) - 1);
    }
  }

  // The call's run, or null once it was answered with why not.
  async function runOf(req, res) {
    const ip = await clientOf(req);
    const secret = secretOf(req.headers.authorization);
    let run;
    if (secret === undefined) {
      run = ip ? await runFrom(ip) : null;
      if (!run) return (fail(res, 401, "unknown or finished run"), null);
    } else {
      run = broker.runOf(secret);
      if (!run) return (fail(res, 401, "unknown or finished run"), null);
      if (!(await broker.sentBy(run, req, ip))) return (fail(res, 403, NOT_ITS_SANDBOX), null);
    }
    if (run.extra === NO_TOKEN) {
      return (fail(res, 403, "this run gets nothing from GitHub"), null);
    }
    return run;
  }

  function refusedToReview({ api, path }) {
    if (!api) return !GIT_READ.test(path);
    return THREAD_READS.some((re) => re.test(path));
  }

  function refuseThread(run, res, call) {
    note(
      run,
      `Deckhand refused the review's call ${clip(run, call)}: it reads its thread from TASK_DIGEST`,
    );
    return fail(
      res,
      403,
      "a review reads its pull request's comments and reviews from $TASK_DIGEST only",
    );
  }

  // The path is the sandbox's to choose: without the run's secrets, as any of its output.
  function clip(run, call) {
    return redact(call, [...secrets(run), ...run.tokens]).slice(0, 200);
  }

  // The write's body without the run's secrets; noted when it had one. It still goes on.
  function redacted(run, req, body, call) {
    const values = [...secrets(run), secretOf(req.headers.authorization), ...run.tokens];
    const clean = redactBody(body, values);
    if (!clean) return body;
    note(run, `Deckhand redacted a secret from the run's GitHub write ${clip(run, call)}`);
    log(`GitHub gateway: redacted a secret from ${clip(run, call)} for ${run.repo}`);
    return clean;
  }

  async function proxied(req, res, run, github, { target, api }, body) {
    let token;
    try {
      ({ token } = await github.repoToken(run.repo, run.extra));
    } catch (error) {
      log(`GitHub gateway: token for ${run.repo}: ${error.message ?? error}`);
      return fail(res, 502, "GitHub refused the token");
    }
    run.tokens.add(token);
    const headers = forwarded(req.headers, ["authorization", "cookie"]);
    // git asks with Basic, as GitHub expects an App's token on its web host.
    headers.authorization = api
      ? `token ${token}`
      : `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    if (body !== undefined) headers["content-length"] = String(body.length);
    await forward(req, res, {
      target,
      headers,
      body,
      unreachable: () => fail(res, 502, "GitHub can't be reached"),
      log,
      what: "GitHub gateway",
      idleMs,
      clock,
    });
  }

  return { handle };
}
