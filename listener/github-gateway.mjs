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
// - every REST write is checked (github-writes.mjs): classified, its target's kind resolved from
//   GitHub, then held to its mode's ceiling and the policies' `deny_github`; every GraphQL call
//   is parsed and validated, and each of its mutations checked the same way (github-graphql.mjs),
//   and what goes on is the document as parsed, printed again;
// - a work run that isn't a fork's gets nothing that would bring a fork's code (github-forks.mjs):
//   a fork's repository, a fork's pull request's head, a commit that isn't its repository's,
//   in a fetch, an archive, the API, a page or a file of GitHub's file hosts (FILES:
//   raw.githubusercontent.com, media.githubusercontent.com, patch-diff.githubusercontent.com),
//   relayed here for such a run only (broker-http.mjs), and sent on anonymously: they never get
//   a token, nor count towards its calls in flight, as when they were plain hosts;
// - every write's body is redacted (the run's secret, the operator's credentials, the tokens
//   used for it, anything shaped like a GitHub token) before GitHub gets it, and the run's log
//   says so: what a run posts itself would otherwise skip the redaction of its reply and log;
// - the call goes on with a token minted for the run's repo: a write that passed its checks gets
//   its mode's permissions (modes.mjs permissionsFor()), and what a pull request's own write
//   needs besides (github-pulls.mjs: `gh pr create`, `edit`, `ready`), anything else the same
//   that only read (github-app.mjs readsOf()), so nothing unchecked can write; the answer
//   streams back (upstream.mjs forward()), an Actions log's from where GitHub redirects
//   (ACTIONS_LOGS).
//
// Served on the broker's port, which only the runs' networks reach.
import { addressOf, NOT_ITS_SANDBOX } from "./broker.mjs";
import { githubContent } from "./egress.mjs";
import { NO_TOKEN, readsOf } from "./github-app.mjs";
import { advertisementReader, fetchBody, fetchRequest, MAX_FETCH } from "./github-forks.mjs";
import { pullOf } from "./github-pulls.mjs";
import { pkt } from "./pkt-line.mjs";
import { classify } from "./github-writes.mjs";
import { redact } from "./redact.mjs";
import { baseOf, forward, forwarded, IDLE_MS, MAX_IN_FLIGHT } from "./upstream.mjs";
import { sendJson } from "./web.mjs";

// The largest write body read: GitHub's own limits for an issue or a comment are far below.
export const MAX_WRITE = 16 * 1024 * 1024;
// How much of a watched write's answer is read: an issue's JSON is far below.
export const MAX_ANSWER = 1024 * 1024;
// The redacted writes and refused calls a run's log notes, each once and only so many.
export const MAX_NOTED = 20;

// A repository in a REST path: by name, or by id, as GitHub's own pagination links name it.
const REPO = String.raw`(?:repos\/[^/]+\/[^/]+|repositories\/\d+)`;
// Where a review may not read (paths under the API's base, without its query): the thread's
// comments, reviews and review comments, the timeline that holds them, commit comments, and the
// event feeds, whose comment and review events carry their bodies (a repository's, a network's,
// a user's, an organization's, the public one).
const THREAD_READS = [
  String.raw`^${REPO}\/(?:issues|pulls)\/comments(?:\/|$)`,
  String.raw`^${REPO}\/issues\/[^/]+\/(?:comments|timeline)(?:\/|$)`,
  String.raw`^${REPO}\/pulls\/[^/]+\/(?:comments|reviews)(?:\/|$)`,
  String.raw`^${REPO}\/(?:commits\/[^/]+\/)?comments(?:\/|$)`,
  String.raw`^(?:(?:${REPO}|networks\/[^/]+\/[^/]+|users\/[^/]+|orgs\/[^/]+)\/)?(?:received_)?events(?:\/|$)`,
  // Issue search: `in:comments` matches comment text, and its text matches quote it.
  String.raw`^search\/issues(?:\/|$)`,
].map((re) => new RegExp(re, "i"));
// The same in GraphQL, read as text until #406 parses it: any name that holds "comment",
// "review", "timeline" or "contentedit", whatever its case: their fields (`comments`,
// `issueComments`, `commitComments`, `latestReviews`, `timelineItems`, `userContentEdits`…),
// types and interfaces (`Comment`, `IssueComment`, `PullRequestReview`…), and search, whose
// text matches quote what they matched. It refuses more than it must (`reviewDecision`): a
// review reads its pull request over REST.
const THREAD_FIELDS = /comment|review|timeline|contentedit|search|textmatch/i;
// An Actions run's or job's logs (paths under the API's base): GitHub answers with a redirect
// to a storage host of its own (Azure blobs, behind a signed URL), which the egress proxy
// doesn't let a sandbox reach. The gateway follows it (proxied()), once, without any
// credential, and sends the logs back: what a CI fix run reads (reviews.mjs ciFixMessage()).
export const ACTIONS_LOGS = new RegExp(
  String.raw`^${REPO}\/actions\/(?:jobs\/\d+|runs\/\d+(?:\/attempts\/\d+)?)\/logs$`,
  "i",
);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// The REST paths (under the API's base) that need one of the App's optional permissions
// (github-app.mjs OPTIONAL_PERMISSIONS), at least to read: a run's token goes without one its
// installation lacks, and the call is refused here, naming it, rather than by GitHub, without.
// Only its own repository's, by name: another's (a public repository's CI) GitHub may answer
// without the permission, and the run's installation isn't the one to accept it.
export const NEEDS = [{ permission: "actions", path: /^repos\/([^/]+\/[^/]+)\/actions(?:\/|$)/i }];
// What a call needs of the optional permissions: its path's (NEEDS) when the path is `repo`'s,
// read, and what a checked write needs beyond its mode's (`permissions`), at their levels.
export function needed(path, permissions = {}, repo = "") {
  const wanted = { ...permissions };
  for (const { permission, path: re } of NEEDS) {
    const named = re.exec(path)?.[1];
    if (named && named.toLowerCase() === repo.toLowerCase()) wanted[permission] ??= "read";
  }
  return wanted;
}
// Where an Actions log's redirect is followed to: GitHub's log storage (Azure blobs, its content
// hosts), or GitHub's own host (an Enterprise Server's storage behind it). The listener isn't
// behind the egress proxy: any other host goes back to the sandbox, which can't reach it.
export function logStorage(host, github) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  return (
    name === String(github).toLowerCase() ||
    /^(?:[a-z0-9-]+\.)+blob\.core\.windows\.net$/.test(name) ||
    githubContent(name)
  );
}

// What git fetches with on the web host; a review reads nothing else there (web pages show the
// comments).
// Any case: GitHub may route a path whatever its case, and a spelling these miss must not reach
// it unchecked (github-forks.mjs refuses any other page of a repository).
const GIT_READ = /^[^/]+\/[^/]+?(?:\.git)?\/(?:info\/refs|git-upload-pack)$/i;
const GIT_PUSH = /\/git-receive-pack$/i;
// A fetch's calls, and the repository they name.
const GIT_FETCH = /^([^/]+\/[^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack)$/i;
// GitHub's file hosts (egress.mjs GITHUB_FILES, the same list): relayed, and sent on without a
// token. How a work run's calls there are checked (github-forks.mjs callTargets()): their path
// past `prefix`, read as `kind` reads it. GitHub's other content hosts (egress.mjs
// githubContent(): release assets, avatars…) are relayed too, read only, and sent
// on as they are to the host they name: whatever `Host` the sandbox wrote, so that none answers
// as one of these.
export const FILES = [
  { host: "raw.githubusercontent.com", kind: "raw", prefix: "" },
  { host: "media.githubusercontent.com", kind: "raw", prefix: "media/" },
  { host: "patch-diff.githubusercontent.com", kind: "web", prefix: "raw/" },
];

// Headers some front ends route or rewrite by (the path, the host, the method): never passed
// on, so that GitHub reads the call the checks read, whatever it honours.
export const ROUTING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-original-url",
  "x-rewrite-url",
  "x-original-host",
  "x-host",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
];

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

// `body` without `secrets` (redact()), everything else in it as it was sent: each string of its
// JSON decoded, so an escaped character can't split a secret, and replaced in place; then the
// rest as text (a number, or a body that isn't JSON). A body that isn't UTF-8 is redacted as
// bytes (latin1 keeps each one). Null when nothing was redacted.
export function redactBody(body, secrets) {
  const text = body.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(body)) {
    const bytes = body.toString("latin1");
    const out = redact(bytes, secrets);
    return out === bytes ? null : Buffer.from(out, "latin1");
  }
  let out = text;
  try {
    JSON.parse(text);
    // In valid JSON, a quote outside a string starts one: the literals are exactly these.
    out = text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => {
      const value = JSON.parse(literal);
      const clean = redact(value, secrets);
      return clean === value ? literal : JSON.stringify(clean);
    });
  } catch {}
  out = redact(out, secrets);
  return out === text ? null : Buffer.from(out);
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
  // GitHub's file hosts (FILES), each with the `url` its calls go to (https://<host>).
  files = FILES,
  // host → the URL GitHub's other content hosts' calls go to, or null for a host that isn't one
  // (egress.mjs githubContent()).
  content = (host) => (githubContent(host) ? new URL(`https://${host.toLowerCase()}/`) : null),
  // github-forks.mjs createForkChecks(): what a work run that isn't a fork's may fetch. None:
  // nothing is checked.
  forks = null,
  // req → the address of the sandbox that sent it: the one the egress proxy names when it
  // relayed the call (broker-http.mjs clientAddress()).
  clientOf = async (req) => addressOf(req),
  // address → the live run whose sandbox has it (never its engine), or null: a call without a
  // secret (broker-http.mjs runFrom()).
  runFrom = async () => null,
  // run → the secrets its writes must not carry, besides its tokens: its own secret and the
  // operator's credentials (secrets.mjs operatorSecrets()).
  secrets = () => [],
  // (run, { method, path, body }) → null when a REST write may go on, else { status, message }
  // (github-writes.mjs createWriteChecks()). None: every REST write is refused.
  checkWrite = async () => ({ status: 403, message: "no write is checked here" }),
  // (run, body) → a GraphQL call's { body, write, creates, comments, reacts, unreacts,
  // permissions, pulls } as it goes on, or { refused } (github-graphql.mjs
  // createGraphqlChecks()). None: every GraphQL call is refused.
  checkGraphql = async () => ({ refused: { status: 403, message: "no GraphQL is checked here" } }),
  // (run, { method, path, body, graphql, creates, comments, reacts, unreacts, pulls, at },
  // status, answer) → GitHub's answer to a write that went on and may create an issue, post a
  // comment, add or remove a reaction or change a pull request (a REST write, a GraphQL
  // `createIssue`, `addComment`, `addReaction`, `removeReaction` or pull request mutation), its
  // bytes up to MAX_ANSWER, `at` when it was sent (github-writes.mjs answered(): the issues a
  // run created, the comments it posted and its reactions, the dashboard's pull requests).
  wroteWrite = () => {},
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
  const fileHosts = files.map((f) => ({ ...f, base: baseOf(f.url ?? `https://${f.host}`) }));
  // GraphQL's path as route() decodes it, and the spellings GitHub may read as it too.
  const graphqlPaths = new Set(["graphql", graphql.pathname.slice(1).toLowerCase()]);
  const isGraphql = (path) => graphqlPaths.has(path.toLowerCase().replace(/\/+$/, ""));
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

  // /relay/<host>/<path> → { target, api, file, path }: the URL on GitHub, whether it is the
  // API's (REST or GraphQL), which of its file hosts' (FILES) or the web host's, and the path
  // under that base, decoded. Null for a host that isn't GitHub's or a path that would leave it.
  function route(url) {
    const match = /^\/relay\/([^/]+)(\/[^]*)$/.exec(url);
    if (!match) return null;
    const [, host, rest] = match;
    // Only a host spelled as the egress proxy relays one (lowercase, no trailing dot, no port): a
    // sandbox can reach this port directly too, and another spelling of a checked host must not
    // pass for an unchecked one (`raw.githubusercontent.com.` for a content host, say).
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host)) return null;
    if (rest.startsWith("//") || rest.split("?")[0].includes("\\")) return null;
    for (const base of [apiBase, webBase]) {
      if (base.hostname !== host) continue;
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
    const other = fileHosts.some((f) => f.host === host) ? null : content(host);
    const file =
      fileHosts.find((f) => f.host === host) ?? (other && { host, base: other, passthrough: true });
    if (file) {
      let target;
      try {
        target = new URL(rest, file.base.origin);
      } catch {
        return null;
      }
      if (target.origin !== file.base.origin) return null;
      return { target, api: false, file, path: decoded(target.pathname, file.base) };
    }
    return null;
  }

  // The path under `base`, percent-decoded and with repeated slashes as one: what GitHub reads.
  // The URL parser has resolved its dot segments, encoded ones too (`%2e%2e`), in the URL that
  // goes on: what is checked is what is sent. Null for one whose decoding still holds a dot
  // segment (`..%2f`), a backslash or a NUL, which a front end could read otherwise.
  function decoded(pathname, base) {
    const under = pathname.startsWith(base.pathname)
      ? pathname.slice(base.pathname.length)
      : pathname.slice(1);
    let path;
    try {
      path = decodeURIComponent(under).replace(/\/{2,}/g, "/");
    } catch {
      return null;
    }
    if (/(?:^|\/)\.{1,2}(?:\/|$)|[\\\0]/.test(path)) return null;
    return path;
  }

  async function handle(req, res) {
    const where = route(req.url);
    if (!where || where.path === null) return fail(res, 404, "not a GitHub host it relays");
    const run = await runOf(req, res);
    if (!run) return;
    const call = `${req.method} ${where.target.pathname}`;
    if (!where.api && (GIT_PUSH.test(where.path) || /service=git-receive-pack/i.test(req.url))) {
      return fail(res, 403, "pushes go through Deckhand's git gateway (pushInsteadOf)");
    }
    // Git's fetch, as git sends it: its advertisement a GET, its pack request a POST. Any other
    // method there would be a write, streamed past the fetch's checks.
    const fetching = where.api || where.file ? null : GIT_FETCH.exec(where.path);
    if (fetching && req.method !== (/info\/refs$/i.test(fetching[2]) ? "GET" : "POST")) {
      req.resume();
      return fail(res, 405, `git's ${fetching[2]} takes no ${req.method}`);
    }
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    // A read with a body would go on unread, past redaction and a review's check: git and gh
    // never send one, so it is refused rather than read.
    const sized = (req.headers["content-length"] ?? "0").trim() !== "0";
    if (!write && (sized || req.headers["transfer-encoding"] !== undefined)) {
      req.resume();
      return fail(res, 400, `a ${req.method} with a body`);
    }
    // A fetch's pack request is a POST, and binary: streamed, not redacted (a work run's is read
    // for what it wants, below: forkCheck()).
    const streamed = !write || (!where.api && /\/git-upload-pack$/i.test(where.path));
    if (where.file && write) return fail(res, 405, `${where.file.host} is only read`);
    const review = run.mode === "review";
    // Files aren't the thread: a review reads them as before.
    if (review && !where.file && refusedToReview(where)) return refuseThread(run, res, call);
    const github = app();
    if (!github) return fail(res, 503, "the GitHub App is not set up");
    // A file host's call holds no token, and was a plain host's before: not counted, so a setup
    // that downloads many files at once isn't cut off part-way.
    const counted = !where.file;
    const calls = inFlight.get(run) ?? 0;
    if (counted && calls >= maxInFlight) {
      return fail(res, 429, `more than ${maxInFlight} calls at once`);
    }
    if (counted) inFlight.set(run, calls + 1);
    // A rerun's slot (github-writes.mjs reserve()): free again once the call is over, unless
    // GitHub's answer made it a rerun done.
    let slot = null;
    try {
      let body;
      // A fetch's: the repository whose refs GitHub's answer advertises (info/refs, ls-refs), for
      // its wants (github-forks.mjs remember()); whether its body was inflated.
      let advertised = null;
      let inflated = false;
      // A path's optional permission first: what checks a work run's call for a fork's code
      // (forkCheck()) reads GitHub with the same permission, and would fail without a word.
      if (where.api && !isGraphql(where.path)) {
        const lacks = await unaccepted(github, run, needed(where.path, {}, run.repo));
        if (lacks) {
          req.resume();
          return refuse(run, res, call, write, lacks);
        }
      }
      const fork = await forkCheck(run, req, where);
      if (fork?.refused) return refuseFork(run, req, res, where, call, fork.refused, fork.git);
      if (where.file) return await anonymous(req, res, where);
      if (fork?.fetch && req.method === "POST") {
        // Read whole, to check what it wants: git compresses a long negotiation.
        body = await readBody(req, maxWrite, idleMs, clock);
        if (body === null) return fail(res, 413, `a fetch over ${maxWrite} bytes`);
        let request;
        try {
          inflated = req.headers["content-encoding"] !== undefined;
          body = fetchBody(body, req.headers["content-encoding"]);
          request = fetchRequest(body);
        } catch (error) {
          const message = /maxOutputLength|buffer/i.test(error.message)
            ? `a fetch over ${MAX_FETCH} bytes`
            : error.message;
          return refuseFork(run, req, res, where, call, { status: 400, message }, true);
        }
        const refused = await forks.checkFetch(run, fork.fetch, request);
        if (refused) return refuseFork(run, req, res, where, call, refused, true);
        if (request.command === "ls-refs") advertised = fork.fetch;
      } else if (fork?.fetch) advertised = fork.fetch;
      if (!streamed) {
        // A compressed body would hide what redaction and a review's check look for: refused
        // rather than inflated, as the git gateway does.
        const encoding = String(req.headers["content-encoding"] ?? "identity")
          .trim()
          .toLowerCase();
        if (encoding !== "identity") {
          req.resume();
          return fail(res, 415, `a ${encoding}-encoded body: Deckhand reads writes uncompressed`);
        }
        body = await readBody(req, maxWrite, idleMs, clock);
        if (body === null) return fail(res, 413, `a write over ${maxWrite} bytes`);
        // Every body a review sends, whatever its path's spelling: its token only reads, so a
        // POST of its is GraphQL, or a write GitHub refuses anyway.
        if (review && readsThread(body.toString("latin1"))) {
          return refuseThread(run, res, call);
        }
        body = redacted(run, req, body, call);
      }
      // Its URL is the sandbox's to choose too, but isn't rewritten: a path names what is
      // written to, so one holding a secret is refused (and noted) rather than redacted.
      if (write && urlHolds(run, req, where.target)) {
        note(
          run,
          `Deckhand refused the run's GitHub write ${clip(run, call)}: its URL holds a secret`,
        );
        return fail(res, 403, "this write's URL holds a secret");
      }
      // A write whose answer may say which issue it created: read as it goes on. `writing`:
      // whether it passed a write's checks, so its token may write; `permissions`, what it needs
      // beyond its mode's.
      let watched = null;
      let writing = false;
      let permissions = {};
      const graphqlCall = where.api && isGraphql(where.path);
      let refused = null;
      // GitHub may read parameters from a query too, which the checks never see: no write they
      // classify needs one. GraphQL is a POST: a GET's query would go on unparsed.
      if (graphqlCall && req.method !== "POST") {
        refused = { status: 405, message: "GraphQL is a POST of its JSON" };
      } else if ((write && where.api) || graphqlCall) {
        if (where.target.search) {
          refused = {
            status: 400,
            message: "a write with a query string: send its fields in the body",
          };
        }
      }
      if (!refused && graphqlCall) {
        const checked = await checkGraphql(run, body);
        if (checked.refused) refused = checked.refused;
        else {
          // Redacted again as printed: GraphQL's own escapes (`\u0064`) decode only now, which
          // the call's JSON hid from the redaction above.
          body = redacted(run, req, checked.body, call);
          writing = checked.write;
          permissions = checked.permissions ?? {};
          const pulls = checked.pulls ?? [];
          const comments = checked.comments ?? [];
          const reacts = checked.reacts ?? [];
          const unreacts = checked.unreacts ?? [];
          const answers = [checked.creates, comments, reacts, unreacts, pulls];
          if (answers.some((list) => list.length)) {
            watched = {
              method: req.method,
              path: where.path,
              body,
              graphql: true,
              creates: checked.creates,
              comments,
              reacts,
              unreacts,
              pulls,
            };
          }
        }
      } else if (!refused && write && where.api) {
        const classified = classify(req.method, where.path, body);
        const pull = pullOf(classified);
        watched = {
          method: req.method,
          path: where.path,
          body,
          graphql: false,
          pulls: pull ? [pull] : [],
        };
        // The checks may add what GitHub's answer is kept with (a rerun's run: github-writes.mjs
        // check()).
        const asked = { method: req.method, path: where.path, body };
        refused = await checkWrite(run, asked);
        if (asked.rerun) watched.rerun = slot = asked.rerun;
        // A POST that writes nothing (rendering markdown) passes, with a token that only reads.
        writing = !refused && !classified?.read;
        permissions = classified?.permissions ?? {};
      }
      // The write's own permissions: its path's were checked above.
      if (!refused && writing) refused = await unaccepted(github, run, needed("", permissions));
      if (refused) return refuse(run, res, call, write, refused);
      await proxied(req, res, run, github, where, body, watched, writing && permissions, {
        advertised,
        inflated,
      });
    } finally {
      slot?.release?.();
      if (counted) inFlight.set(run, inFlight.get(run) - 1);
    }
  }

  // A call refused by the gateway's checks: noted in the run's log and the listener's.
  function refuse(run, res, call, write, refused) {
    note(
      run,
      `Deckhand refused the run's GitHub ${write ? "write" : "call"} ${clip(run, call)}: ${refused.message}`,
    );
    log(`GitHub gateway: refused ${clip(run, call)} for ${run.repo}: ${refused.message}`);
    return fail(res, refused.status, refused.message);
  }

  // A refusal when the run's installation lacks an optional permission the call needs: its
  // token goes without it (github-app.mjs OPTIONAL_PERMISSIONS), and GitHub's own refusal
  // wouldn't say what to do.
  async function unaccepted(github, run, wanted) {
    let lacks;
    try {
      lacks = await github.lacking?.(run.repo, wanted);
    } catch {
      // The token's own mint tells the run when GitHub can't be asked.
      return null;
    }
    if (!lacks) return null;
    const them = lacks.missing.length > 1 ? "them" : "it";
    const where = lacks.url ? ` on ${lacks.url}` : "";
    return {
      status: 403,
      message: `this needs the GitHub App's ${lacks.missing.join(", ")} permission, which its installation${lacks.account ? ` on ${lacks.account}` : ""} lacks: the operator adds ${them} to the App's settings if ${lacks.missing.length > 1 ? "they aren't" : "it isn't"} there, and an owner of the account accepts ${them}${where} (Deckhand's docs/setup.md)`,
    };
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

  // A call's query as the checks read it: split on `;` too, as some servers do (Rack before
  // 3), so a parameter can't hide behind one.
  const queryOf = (target) => new URLSearchParams(target.search.replace(/;/g, "&"));

  // A restricted run's call (github-forks.mjs restricted()) → { refused, git } when it would
  // bring a fork's code, { fetch } (the repository) for a git call whose fetch is checked and
  // whose advertisement is remembered, or null. GraphQL's are github-graphql.mjs's.
  async function forkCheck(run, req, where) {
    if (!forks?.restricted(run)) return null;
    if (where.api && isGraphql(where.path)) return null;
    const { file } = where;
    // GitHub's other content hosts serve no repository's file: nothing to check.
    if (file?.passthrough) return null;
    if (file) {
      // A path these checks don't read is refused: fail closed.
      if (!where.path.toLowerCase().startsWith(file.prefix)) {
        return {
          refused: { status: 403, message: `a path of ${file.host}'s Deckhand doesn't read` },
          git: false,
        };
      }
      const refused = await forks.checkCall(run, {
        kind: file.kind,
        path: where.path.slice(file.prefix.length),
        query: queryOf(where.target),
        accept: String(req.headers.accept ?? ""),
      });
      return refused && { refused, git: false };
    }
    const git = where.api ? null : GIT_FETCH.exec(where.path);
    if (git) {
      const scoped = await forks.fetchScope(run, git[1]);
      if (scoped?.refused) return { refused: scoped.refused, git: true };
      return scoped ? { fetch: scoped.repo } : null;
    }
    const refused = await forks.checkCall(run, {
      kind: where.api ? "api" : "web",
      path: where.path,
      query: queryOf(where.target),
      accept: String(req.headers.accept ?? ""),
    });
    return refused && { refused, git: false };
  }

  // What would bring a fork's code, refused and noted. Git shows a fetch's `ERR` line as
  // "remote error: …", and a refused first request's plain text as "remote: …"; gh shows the
  // API's message; a page or raw file gets the text.
  function refuseFork(run, req, res, { api }, call, { status, message }, git) {
    note(run, `Deckhand refused the run's GitHub call ${clip(run, call)}: ${message}`);
    log(`GitHub gateway: refused ${clip(run, call)} for ${run.repo}: ${message}`);
    req.resume();
    if (git && req.method === "POST") {
      res.writeHead(200, {
        "content-type": "application/x-git-upload-pack-result",
        "cache-control": "no-cache",
      });
      return res.end(pkt(`ERR Deckhand: ${message}\n`));
    }
    if (api) return fail(res, status, message);
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(`Deckhand: ${message}\n`);
  }

  // A file host's call, anonymously: it gets no token, nor the sandbox's credentials, as when it
  // was a plain host.
  function anonymous(req, res, { target, file }) {
    return forward(req, res, {
      target,
      headers: forwarded(req.headers, ["authorization", "cookie", ...ROUTING_HEADERS]),
      unreachable: () => fail(res, 502, `${file.host} can't be reached`),
      log,
      what: "GitHub gateway",
      idleMs,
      clock,
    });
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
  // Percent-decoded first: an encoded secret is one too.
  function clip(run, call) {
    let text = call;
    try {
      text = decodeURIComponent(call);
    } catch {}
    return redact(text, [...secrets(run), ...run.tokens]).slice(0, 200);
  }

  // Whether `target` holds one of the run's secrets, as sent or percent-decoded.
  function urlHolds(run, req, target) {
    const values = [...secrets(run), secretOf(req.headers.authorization), ...run.tokens];
    const raw = target.pathname + target.search;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw.replaceAll("+", " "));
    } catch {}
    return redact(raw, values) !== raw || redact(decoded, values) !== decoded;
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

  // `watched`: a write whose answer goes to wroteWrite(); `writing`: for one that passed its
  // checks, whose token may write, the permissions it needs beyond its mode's; else false.
  // `advertised`: the repository whose refs the answer advertises to the run's git, remembered
  // (github-forks.mjs); `inflated`: whether `body` is the request's own, inflated.
  async function proxied(
    req,
    res,
    run,
    github,
    { target, api, path },
    body,
    watched,
    writing,
    { advertised = null, inflated = false } = {},
  ) {
    let token;
    const permissions = writing ? { ...run.extra, ...writing } : readsOf(run.extra);
    try {
      ({ token } = await github.repoToken(run.repo, permissions));
    } catch (error) {
      log(`GitHub gateway: token for ${run.repo}: ${error.message ?? error}`);
      return fail(res, 502, "GitHub refused the token");
    }
    run.tokens.add(token);
    const headers = forwarded(req.headers, [
      "authorization",
      "cookie",
      ...ROUTING_HEADERS,
      ...(inflated ? ["content-encoding"] : []),
    ]);
    // git asks with Basic, as GitHub expects an App's token on its web host.
    headers.authorization = api
      ? `token ${token}`
      : `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    if (body !== undefined) headers["content-length"] = String(body.length);
    // A watched write's answer is read as it goes on: uncompressed, and only so much of it.
    let status = 0;
    let answer = [];
    let size = 0;
    if (watched || advertised) headers["accept-encoding"] = "identity";
    // An advertisement is read as it streams, only its refs kept (github-forks.mjs).
    const refs = advertised ? advertisementReader() : null;
    const tap = (chunk) => {
      refs?.push(chunk);
      if (!watched) return;
      size += chunk.length;
      if (size <= MAX_ANSWER) answer?.push(chunk);
      else answer = null;
    };
    const at = Date.now();
    // An Actions log's redirect, followed here: HTTPS only (or the API's own scheme, a test's
    // plain HTTP), with none of the run's or the App's credentials, the signed URL being its own.
    const logs = api && req.method === "GET" && ACTIONS_LOGS.test(path);
    const follow = (code, answer) => {
      if (!REDIRECTS.has(code) || !answer.location) return null;
      let next;
      try {
        next = new URL(answer.location, target);
      } catch {
        return null;
      }
      if (next.protocol !== "https:" && next.protocol !== target.protocol) return null;
      if (next.username || next.password) return null;
      if (!logStorage(next.hostname, target.hostname)) return null;
      const plain = forwarded(req.headers, ["authorization", "cookie", ...ROUTING_HEADERS]);
      return { target: next, headers: plain };
    };
    await forward(req, res, {
      target,
      headers,
      body,
      unreachable: () => fail(res, 502, "GitHub can't be reached"),
      log,
      what: "GitHub gateway",
      idleMs,
      clock,
      // No answer (`lost`): 0, the write may have gone out all the same (github-writes.mjs
      // answered() counts a rerun then).
      ...((watched || advertised) && {
        tap,
        answered: (code, _, lost) => (status = lost ? 0 : code),
      }),
      ...(logs && { follow }),
    });
    if (refs && status === 200) forks.remember(run, advertised, refs.refs());
    if (!watched || !answer) return;
    try {
      wroteWrite(run, { ...watched, at }, status, Buffer.concat(answer));
    } catch (error) {
      log(`GitHub gateway: after ${clip(run, `${watched.method} ${target.pathname}`)}: ${error}`);
    }
  }

  return { handle };
}
