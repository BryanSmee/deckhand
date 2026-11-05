// GitHub gateway: a sandbox's only way to GitHub. It holds no token: the egress proxy decrypts
// its calls to GitHub's hosts (egress.mjs githubHosts(), with Deckhand's CA, which it trusts)
// and hands each one here as /relay/<host>/<path> (../proxy/proxy.mjs), REST, GraphQL, clones
// and fetches alike. Here:
//
// - the call's run is found by the run token it sent in place of a GitHub token (`GH_TOKEN`,
//   git's credential helper: ../sandbox/), checked offline (broker.mjs check()), or by its
//   sandbox's address when it sent none (git's first request, a download with curl); the token
//   only works from its own sandbox, and a finished run's, another sandbox's or one without
//   `pull` (a research run: github-app.mjs readsGitHub()) get nothing;
// - pushes are refused: they go to the git gateway (git-gateway.mjs, pushInsteadOf);
// - a review's reads of its thread (comments, reviews, review comments) are refused: it reads
//   only what allowed users wrote, from TASK_DIGEST (reviews.mjs);
// - a run without `read:issues` reads its own issue only (issue #497): its REST paths
//   (ownIssuePath()) and, in GraphQL, `repository(owner:, name:) { issue(number:) }` naming it
//   (github-graphql.mjs issueReads()), each with a token minted with `issues: read` for that
//   call alone; any other read of issues is refused;
// - every REST write is checked (github-writes.mjs): classified, its target's kind resolved from
//   GitHub, then held to the policies' `allow_github` and `deny_github`; every GraphQL call
//   is parsed and validated, and each of its mutations checked the same way (github-graphql.mjs),
//   and what goes on is the document as parsed, printed again;
// - a read of CI's results beyond Actions (check runs, statuses: CHECK_READS, or a GraphQL call
//   selecting them) is held to the policies as `read_checks`, once per run;
// - a work run that isn't a fork's gets nothing that would bring a fork's code (github-forks.mjs):
//   a fork's repository, a fork's pull request's head, a commit that isn't its repository's,
//   in a fetch, an archive, the API, a page or a file of GitHub's file hosts (FILES:
//   raw.githubusercontent.com, media.githubusercontent.com, patch-diff.githubusercontent.com),
//   relayed here for such a run only (egress-http.mjs), and sent on anonymously: they never get
//   a token, nor count towards its calls in flight, as when they were plain hosts;
// - every write's body is redacted (the run's tokens, the operator's credentials, the tokens
//   used for it, anything shaped like a GitHub token) before GitHub gets it, and the run's log
//   says so: what a run posts itself would otherwise skip the redaction of its reply and log;
// - the call goes on with a token minted for the run's repo, which only reads what its
//   capabilities give (github-app.mjs readsOf(): GitHub enforces them), so nothing unchecked can
//   write: a write that passed its checks gets one with only the write permission it needs
//   besides (github-writes.mjs writePermissions(): `issues: write` for an issue's,
//   `pull_requests: write` for `gh pr create` or `edit`, `contents: write` for `ready`…); the answer
//   streams back (upstream.mjs forward()), an Actions log's from where GitHub redirects
//   (ACTIONS_LOGS).
//
// Served by the github service (../github/), which sandboxes reach through the egress proxy alone.
import { performance } from "node:perf_hooks";
import { addressOf } from "./broker.mjs";
import { githubContent } from "./egress.mjs";
import { PROJECT_READ, READ_PERMISSIONS, readsGitHub, readsOf } from "./github-app.mjs";
import { advertisementReader, fetchBody, fetchRequest, MAX_FETCH } from "./github-forks.mjs";
import { pullOf } from "./github-pulls.mjs";
import { pkt } from "./pkt-line.mjs";
import { classify, writePermissions } from "./github-writes.mjs";
import { redact } from "../lib/redact.mjs";
import { baseOf, forward, forwarded, IDLE_MS, MAX_IN_FLIGHT } from "../lib/upstream.mjs";
import { sendJson } from "../lib/http.mjs";

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
const EVENT_FEEDS = String.raw`^(?:(?:${REPO}|networks\/[^/]+\/[^/]+|users\/[^/]+|orgs\/[^/]+)\/)?(?:received_)?events(?:\/|$)`;
const THREAD_READS = [
  String.raw`^${REPO}\/(?:issues|pulls)\/comments(?:\/|$)`,
  String.raw`^${REPO}\/issues\/[^/]+\/(?:comments|timeline)(?:\/|$)`,
  String.raw`^${REPO}\/pulls\/[^/]+\/(?:comments|reviews)(?:\/|$)`,
  String.raw`^${REPO}\/(?:commits\/[^/]+\/)?comments(?:\/|$)`,
  EVENT_FEEDS,
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
// The REST reads of issues (paths under the API's base): a repository's, by name or id, lists,
// comments and events included, issue search, and the event feeds, whose issue and comment
// events carry them (THREAD_READS'). A run without `read:issues` is refused them
// but for its own issue's (ownIssuePath()): its token couldn't read them anyway, and this says
// why.
const ISSUE_READS = [
  new RegExp(String.raw`^${REPO}\/issues(?:\/|$)`, "i"),
  /^search\/issues(?:\/|$)/i,
  new RegExp(EVENT_FEEDS, "i"),
];
// Whether a REST path (under the API's base) is the run's own issue or its comments, by its
// repository's name: what a run without `read:issues` reads of issues. By its id
// (`repositories/<id>/…`, GitHub's pagination links): ownIssueId().
export function ownIssuePath(path, run) {
  const match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/comments)?\/?$/i.exec(path);
  return (
    !!match &&
    Number.isInteger(run.issue) &&
    match[1].toLowerCase() === run.repo &&
    Number(match[2]) === run.issue
  );
}
// The same path by its repository's id → the id it names, or null when it isn't the run's
// issue's path under some id (whether the id is its repository's is the gateway's to look up).
export function ownIssueId(path, run) {
  const match = /^repositories\/(\d+)\/issues\/(\d+)(?:\/comments)?\/?$/i.exec(path);
  if (!match || !Number.isInteger(run.issue) || Number(match[2]) !== run.issue) return null;
  return Number(match[1]);
}
// What a chat is told of a write: its permissions profile's GitHub level is read only.
export const CHAT_READS =
  "a chat only reads GitHub: its permissions profile's level is read only, and its answers stay in the conversation";
// What a run is told when it reads issues beyond its own without `read:issues`.
export const ownIssueOnly = (run) =>
  `this run's capabilities don't give \`read:issues\`: it reads ${Number.isInteger(run.issue) ? `its own issue (#${run.issue}) only` : "no issue"}`;
// The read capability that gives a token permission (github-app.mjs READ_PERMISSIONS).
const CAPABILITY_OF = Object.fromEntries(
  Object.entries(READ_PERMISSIONS).flatMap(([cap, names]) => names.map((name) => [name, cap])),
);
// What a run is told when a read needs permissions its capabilities don't give.
export function unreadable(permissions) {
  const caps = [...new Set(permissions.map((p) => CAPABILITY_OF[p] ?? p))];
  return `this run's capabilities don't give ${caps.map((c) => `\`${c}\``).join(", ")}, which this reads with (${permissions.join(", ")})`;
}
// An Actions run's or job's logs (paths under the API's base): GitHub answers with a redirect
// to a storage host of its own (Azure blobs, behind a signed URL), which the egress proxy
// doesn't let a sandbox reach. The gateway follows it (proxied()), once, without any
// credential, and sends the logs back: what a CI fix run reads (reviews.mjs ciFixMessage()).
export const ACTIONS_LOGS = new RegExp(
  String.raw`^${REPO}\/actions\/(?:jobs\/\d+|runs\/\d+(?:\/attempts\/\d+)?)\/logs$`,
  "i",
);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// The reads of CI's results beyond Actions (check runs and suites, commit statuses), which
// `deny_github` sees as `read_checks` (checkRead()), of any repository, by name or id: a
// commit's, and one by its id. A ref may hold a slash (GitHub's path decoded).
const CHECKS_PATH = String.raw`\/(?:commits\/.+\/)?check-(?:runs|suites)(?:\/|$)`;
const STATUSES_PATH = String.raw`\/(?:commits\/.+\/status(?:es)?|statuses\/.+)\/?$`;
export const CHECK_READS = [
  { permission: "checks", path: new RegExp(`^${REPO}${CHECKS_PATH}`, "i") },
  { permission: "statuses", path: new RegExp(`^${REPO}${STATUSES_PATH}`, "i") },
];
// The REST paths (under the API's base) that need one of the App's optional permissions
// (github-app.mjs OPTIONAL_PERMISSIONS), at least to read: a run's token goes without one its
// installation lacks, and the call is refused here, naming it, rather than by GitHub, without.
// Only its own repository's, by name: another's (a public repository's CI) GitHub may answer
// without the permission, and the run's installation isn't the one to accept it.
export const NEEDS = [
  { permission: "actions", path: /^repos\/([^/]+\/[^/]+)\/actions(?:\/|$)/i },
  { permission: "checks", path: new RegExp(String.raw`^repos\/([^/]+\/[^/]+)${CHECKS_PATH}`, "i") },
  {
    permission: "statuses",
    path: new RegExp(String.raw`^repos\/([^/]+\/[^/]+)${STATUSES_PATH}`, "i"),
  },
];
// Whether a REST path reads CI's results beyond Actions (CHECK_READS).
export const readsChecks = (path) => CHECK_READS.some(({ path: re }) => re.test(path));
// What a call needs of the optional permissions: its path's (NEEDS) when the path is `repo`'s,
// read, and what a checked write needs (`permissions`), at their levels.
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

// The run token a call sent in place of a GitHub token:
// `token <token>` (gh), `Bearer <token>` or Basic with it as the password (git). Undefined without an Authorization header; "" for one that
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
// `scrub(text)`: more that is redacted the same way, by what isn't held here (the operator's
// credentials' fingerprints, the github service's: lib/fingerprints.mjs).
export function redactBody(body, secrets, scrub = (text) => text) {
  const clean = (text) => scrub(redact(text, secrets));
  const text = body.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(body)) {
    const bytes = body.toString("latin1");
    const out = clean(bytes);
    return out === bytes ? null : Buffer.from(out, "latin1");
  }
  let out = text;
  try {
    JSON.parse(text);
    // In valid JSON, a quote outside a string starts one: the literals are exactly these.
    out = text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => {
      const value = JSON.parse(literal);
      const cleaned = clean(value);
      return cleaned === value ? literal : JSON.stringify(cleaned);
    });
  } catch {}
  out = clean(out);
  return out === text ? null : Buffer.from(out);
}

// A GraphQL answer whose check or status fields GitHub refused (`FORBIDDEN`, "Resource not
// accessible by integration": its token went without a permission its installation lacks) →
// the answer with those errors' messages as Deckhand's `message`, which `gh` prints; null when
// it has none, or isn't JSON. Only an error whose `path` is at or under one of `paths` (the
// response paths of those fields, github-graphql.mjs checkSelections(), without list indices):
// any other refusal (another repository's data, SAML, an IP allow list…) keeps GitHub's own
// message, and so does every error when `paths` is null. The data GitHub could answer is kept.
export function explained(answer, message, paths) {
  if (!paths?.length) return null;
  let doc;
  try {
    doc = JSON.parse(answer.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(doc?.errors)) return null;
  const forbidden = (e) =>
    e?.type === "FORBIDDEN" || /not accessible by integration/i.test(String(e?.message ?? ""));
  const under = (e) => {
    if (!Array.isArray(e?.path)) return false;
    const keys = e.path.filter((k) => typeof k === "string");
    return paths.some((p) => p.length <= keys.length && p.every((k, i) => k === keys[i]));
  };
  let changed = false;
  doc.errors = doc.errors.map((e) => {
    if (!forbidden(e) || !under(e)) return e;
    changed = true;
    return { ...e, message: `Deckhand: ${message}` };
  });
  return changed ? Buffer.from(JSON.stringify(doc)) : null;
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

// A run's calls in flight, counted in this process: the gateway's default (`inFlight`).
export function countInFlight() {
  const calls = new WeakMap();
  return {
    // → the call's slot, or null when the run has `max` in flight.
    take(run, max) {
      const n = calls.get(run) ?? 0;
      if (n >= max) return null;
      calls.set(run, n + 1);
      return {};
    },
    release: (run) => calls.set(run, (calls.get(run) ?? 1) - 1),
  };
}

// What a pack request's answer says, read pkt-line by pkt-line from its start: whether it
// carries the pack (protocol v2's "packfile" section line, v0's pack on side-band 1 or bare
// after the acknowledgments), or GitHub's error ("ERR …", side-band 3: an object it doesn't
// have, say). Neither: a round of negotiation, or ls-refs. Whole lines only, so a ref named
// …packfile is no pack. Read until one of them, within its first MAX_PACK_SCAN bytes.
const MAX_PACK_SCAN = 1024 * 1024;
export function packIn() {
  let held = Buffer.alloc(0);
  let seen = 0;
  // null while reading; "pack", "error", or "unknown" for what isn't pkt-lines.
  let said = null;
  function line(payload) {
    if (payload.toString("latin1") === "packfile\n") return "pack";
    if (payload.subarray(0, 4).toString("latin1") === "ERR ") return "error";
    if (payload[0] === 1 && payload.subarray(1, 5).toString("latin1") === "PACK") return "pack";
    if (payload[0] === 3) return "error";
    return null;
  }
  return {
    push(chunk) {
      if (said || seen > MAX_PACK_SCAN) return;
      seen += chunk.length;
      held = Buffer.concat([held, chunk]);
      while (!said && held.length >= 4) {
        const head = held.subarray(0, 4).toString("latin1");
        if (head === "PACK") return void (said = "pack");
        if (!/^[0-9a-f]{4}$/i.test(head)) return void (said = "unknown");
        const length = parseInt(head, 16);
        // A flush, delimiter or response-end packet: no payload.
        if (length < 4) {
          held = held.subarray(4);
          continue;
        }
        if (held.length < length) return;
        said = line(held.subarray(4, length));
        held = held.subarray(length);
      }
    },
    found: () => said === "pack",
    failed: () => said === "error",
  };
}

export function createGithubGateway({
  broker, // broker.mjs: the run a token belongs to
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
  // req → where the call came from: the network (or pod) the egress proxy vouched for, in the
  // github service (../github/service.mjs).
  clientOf = async (req) => addressOf(req),
  // that → the live run whose sandbox it is (never its engine), or null: a call without a token.
  runFrom = async () => null,
  // run → the secrets its writes must not carry, besides its GitHub tokens: its own tokens and
  // the operator's credentials (secrets.mjs operatorSecrets()).
  secrets = () => [],
  // run → (text) → the text without what `secrets` can't list: the operator's credentials, by
  // their fingerprints, where they aren't held (the github service's, lib/fingerprints.mjs).
  scrub = () => (text) => text,
  // (run, { method, path, body }) → null when a REST write may go on, else { status, message }
  // (github-writes.mjs createWriteChecks()). None: every REST write is refused.
  checkWrite = async () => ({ status: 403, message: "no write is checked here" }),
  // (run, action) → null when the run may make that kind of read, else { status, message }
  // (github-writes.mjs createReadChecks(): `read_checks`, `read_projects`, once per run). None:
  // every such read is refused.
  checkRead = async () => ({ status: 403, message: "no read of CI's checks is checked here" }),
  // (run, body) → a GraphQL call's { body, write, creates, comments, reacts, unreacts,
  // permissions, pulls, reads, readPaths } as it goes on, or { refused } (github-graphql.mjs
  // createGraphqlChecks()). None: every GraphQL call is refused.
  checkGraphql = async () => ({ refused: { status: 403, message: "no GraphQL is checked here" } }),
  // (run, { method, path, body, graphql, creates, comments, reacts, unreacts, pulls, at },
  // status, answer) → GitHub's answer to a write that went on and may create an issue, post a
  // comment, add or remove a reaction or change a pull request (a REST write, a GraphQL
  // `createIssue`, `addComment`, `addReaction`, `removeReaction` or pull request mutation), its
  // bytes up to MAX_ANSWER, `at` when it was sent (github-writes.mjs answered(): the issues a
  // run created, the comments it posted and its reactions, the dashboard's pull requests).
  wroteWrite = () => {},
  // repo → whether its runs' tokens read the organization's projects (v2): the operator grants
  // it one (grants.mjs allowProjects), which `gh project item-add` looks up before it adds an
  // item. None: they don't.
  readsProjects = () => false,
  // repo → its id on GitHub, or null: what GitHub's pagination links name it by
  // (`repositories/<id>/…`), for a run's own issue's next page (ownIssueId()). None: such a
  // path is refused to a run without `read:issues`.
  repoId = async () => null,
  // ({ caller, status, seconds, headers, authorization }) → nothing: each call relayed to
  // GitHub's API once answered, `status` null when it wasn't (the github service's metrics).
  observe = () => {},
  // (op, result) → nothing: each git fetch or clone relayed, `ok`, `refused` or `failed` (its
  // metrics too).
  onGit = () => {},
  log = () => {},
  maxInFlight = MAX_IN_FLIGHT,
  // { take(run, max) → a slot when the run had fewer than `max` calls in flight, else null;
  // release(run, slot) }: this process's count by default, the github service's store for its
  // copies.
  inFlight = countInFlight(),
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
  // run → what its log noted.
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
    // Deckhand's own refusals of a fetch's request, beside refuseFork()'s: the command ends there.
    const refusedFetch = () => fetching && onGit("fetch", "refused");
    if (fetching && req.method !== (/info\/refs$/i.test(fetching[2]) ? "GET" : "POST")) {
      refusedFetch();
      req.resume();
      return fail(res, 405, `git's ${fetching[2]} takes no ${req.method}`);
    }
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    // A read with a body would go on unread, past redaction and a review's check: git and gh
    // never send one, so it is refused rather than read.
    const sized = (req.headers["content-length"] ?? "0").trim() !== "0";
    if (!write && (sized || req.headers["transfer-encoding"] !== undefined)) {
      refusedFetch();
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
    // What its capabilities read, which its token gets (proxied()).
    const reads = readsOf(run.caps);
    // Issues without `read:issues`: its own only, with a token that reads issues for that call.
    let ownIssue = false;
    if (where.api && !write && !isGraphql(where.path) && !reads.issues) {
      ownIssue =
        ownIssuePath(where.path, run) || (await ownRepoId(run, ownIssueId(where.path, run)));
      if (!ownIssue && ISSUE_READS.some((re) => re.test(where.path))) {
        req.resume();
        return refuse(run, res, call, false, { status: 403, message: ownIssueOnly(run) });
      }
    }
    const github = app();
    if (!github) {
      if (fetching) onGit("fetch", "failed");
      return fail(res, 503, "the GitHub App is not set up");
    }
    // A file host's call holds no token, and was a plain host's before: not counted, so a setup
    // that downloads many files at once isn't cut off part-way.
    const counted = !where.file;
    const inFlightSlot = counted ? await inFlight.take(run, maxInFlight) : null;
    if (counted && !inFlightSlot) {
      refusedFetch();
      return fail(res, 429, `more than ${maxInFlight} calls at once`);
    }
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
        const wanted = needed(where.path, {}, run.repo);
        // A read its capabilities don't give: its token goes without, and GitHub wouldn't say why.
        const ungiven = Object.keys(wanted).filter((name) => !reads[name]);
        const lacks =
          !write && ungiven.length
            ? { status: 403, message: unreadable(ungiven) }
            : await unaccepted(github, run, wanted);
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
        if (body === null) {
          refusedFetch();
          return fail(res, 413, `a fetch over ${maxWrite} bytes`);
        }
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
      // to (writePermissions()).
      let watched = null;
      let writing = false;
      let permissions = {};
      // What a read needs of the optional permissions (CI's results, over GraphQL).
      let checkFields = {};
      // Where those fields are in its answer (explained()).
      let readPaths = null;
      // Whether a GraphQL call writes, once the GraphQL checks parsed it.
      let parsedWrite = null;
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
        // A refusal for what the App couldn't see (a project, without its permission): the
        // permission's message when the installation lacks it, since GitHub's look-up alone
        // can't tell a missing node from one it hides.
        if (checked.refused?.needs) {
          refused = (await unaccepted(github, run, checked.refused.needs)) ?? checked.refused;
        } else if (checked.refused) refused = checked.refused;
        else {
          // Redacted again as printed: GraphQL's own escapes (`\u0064`) decode only now, which
          // the call's JSON hid from the redaction above.
          body = redacted(run, req, checked.body, call);
          writing = checked.write;
          parsedWrite = checked.write;
          permissions = checked.permissions ?? {};
          checkFields = checked.reads ?? {};
          readPaths = checked.readPaths ?? null;
          ownIssue = checked.ownIssue === true;
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
        permissions = writePermissions(classified);
      }
      // A chat's GitHub level (profiles.mjs LEVELS) is read only, whatever the policies allow
      // it: no write of a chat's goes on, a REST one or a GraphQL mutation (`push` is never
      // among its capabilities, so the git gateway refuses its pushes). A level above read would
      // travel in the run's claims, as its capabilities do.
      if (!refused && writing && run.mode === "chat")
        refused = { status: 403, message: CHAT_READS };
      // The write's own permissions: its path's were checked above.
      if (!refused && writing) refused = await unaccepted(github, run, needed("", permissions));
      // CI's results beyond Actions: the policies' answer, once per run (a REST read's
      // permission was checked above).
      const checks = graphqlCall
        ? "checks" in checkFields || "statuses" in checkFields
        : where.api && !write && readsChecks(where.path);
      if (!refused && checks) refused = await checkRead(run, "read_checks");
      // A GraphQL read of CI's checks the installation lacks a permission for goes on without
      // it: GitHub answers the rest (`gh pr view` selects the rollup, on commits without any
      // check too), and its refusal of those fields is explained (explained()).
      let lacks = null;
      if (!refused && graphqlCall && Object.keys(checkFields).length) {
        // Fields its capabilities don't read: refused by GitHub, which the answer explains.
        const ungiven = Object.keys(checkFields).filter((name) => !reads[name]);
        lacks = ungiven.length
          ? { message: unreadable(ungiven) }
          : await unaccepted(github, run, checkFields);
      }
      // A GraphQL call is a POST whatever it does: a write once parsed only if it mutates (a
      // refused read of checks is a call, not a write).
      if (refused) return refuse(run, res, call, parsedWrite ?? write, refused);
      await proxied(req, res, run, github, where, body, watched, writing && permissions, {
        advertised,
        inflated,
        ownIssue,
        lacks: lacks && { message: lacks.message, paths: readPaths },
      });
    } finally {
      await slot?.release?.();
      if (inFlightSlot) await inFlight.release(run, inFlightSlot);
    }
  }

  // repo → its id, once GitHub said it: a repository's id never changes.
  const repoIds = new Map();
  // Whether `id` (null: none) is the run's repository's: a lookup that fails says no.
  async function ownRepoId(run, id) {
    if (id === null) return false;
    if (!repoIds.has(run.repo)) {
      try {
        const found = await repoId(run.repo);
        if (Number.isInteger(found)) repoIds.set(run.repo, found);
      } catch (error) {
        log(`GitHub gateway: ${run.repo}'s id: ${error.message ?? error}`);
      }
    }
    return repoIds.get(run.repo) === id;
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
      const checked = await broker.check(secret, ip);
      if (!checked.run) return (fail(res, checked.status, checked.message), null);
      run = checked.run;
    }
    if (!readsGitHub(run)) {
      return (fail(res, 403, "this run gets nothing from GitHub: it doesn't have `pull`"), null);
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
    // The git command ends here, whether at its advertisement or a pack request.
    if (git) onGit("fetch", "refused");
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
    return scrub(run)(redact(text, [...secrets(run), ...run.tokens])).slice(0, 200);
  }

  // Whether `target` holds one of the run's secrets, as sent or percent-decoded.
  function urlHolds(run, req, target) {
    const values = [...secrets(run), secretOf(req.headers.authorization), ...run.tokens];
    const clean = scrub(run);
    const raw = target.pathname + target.search;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw.replaceAll("+", " "));
    } catch {}
    return [raw, decoded].some((text) => clean(redact(text, values)) !== text);
  }

  // The write's body without the run's secrets; noted when it had one. It still goes on.
  function redacted(run, req, body, call) {
    const values = [...secrets(run), secretOf(req.headers.authorization), ...run.tokens];
    const clean = redactBody(body, values, scrub(run));
    if (!clean) return body;
    note(run, `Deckhand redacted a secret from the run's GitHub write ${clip(run, call)}`);
    log(`GitHub gateway: redacted a secret from ${clip(run, call)} for ${run.repo}`);
    return clean;
  }

  // `watched`: a write whose answer goes to wroteWrite(); `writing`: for one that passed its
  // checks, whose token may write, the permissions it needs to; else false.
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
    { advertised = null, inflated = false, lacks = null, ownIssue = false } = {},
  ) {
    // GitHub's answer, counted once: an API call's status, rate limit and time to its headers.
    // A git fetch (or clone) is counted once whatever number of requests it takes (protocol v2:
    // the advertisement, ls-refs, a fetch per negotiation round): `failed` at the request GitHub
    // fails, answers with an error or cuts short, `ok` at the one whose answer carries the whole
    // pack (packIn()), `refused` at the one Deckhand refuses (refuseFork(), handle()). A command
    // that wants nothing (ls-remote, a fetch with nothing new) brings no pack: not counted.
    const advertising =
      !api &&
      req.method === "GET" &&
      /\/info\/refs$/i.test(path) &&
      target.searchParams.get("service") === "git-upload-pack";
    const packing = !api && req.method === "POST" && /\/git-upload-pack$/i.test(path);
    const packed = packing ? packIn() : null;
    let gitStatus = 0;
    let token;
    // What its capabilities read, and its own issue for a call that reads only that.
    let reads = { ...readsOf(run.caps), ...(ownIssue && { issues: "read" }) };
    try {
      // Only a run the policies let read them (`read_projects`: Deckhand's defaults, the modes
      // that add items) reads the organization's projects: a review, an inbox entry or a
      // discussion reads outsiders' text, and nothing narrows the read to the granted projects.
      if ((await readsProjects(run.repo)) && !(await checkRead(run, "read_projects"))) {
        reads = { ...reads, ...PROJECT_READ };
      }
    } catch (error) {
      // Its token reads no project: what needs one fails at GitHub, the rest goes on.
      log(`GitHub gateway: ${run.repo}: its grants: ${error.message ?? error}`);
    }
    // Its reads, and a checked write's own permission: never another write.
    const permissions = writing ? { ...reads, ...writing } : reads;
    try {
      ({ token } = await github.repoToken(run.repo, permissions));
    } catch (error) {
      log(`GitHub gateway: token for ${run.repo}: ${error.message ?? error}`);
      if (advertising || packing) onGit("fetch", "failed");
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
    // A pack request's answer too, for packIn() to read: a pack is compressed already.
    if (watched || advertised || lacks || packing) headers["accept-encoding"] = "identity";
    // An advertisement is read as it streams, only its refs kept (github-forks.mjs).
    const refs = advertised ? advertisementReader() : null;
    const tap = (chunk) => {
      packed?.push(chunk);
      refs?.push(chunk);
      if (!watched) return;
      size += chunk.length;
      if (size <= MAX_ANSWER) answer?.push(chunk);
      else answer = null;
    };
    const at = Date.now();
    const started = performance.now();
    let counted = false;
    const count = (code, answerHeaders, lost) => {
      if (counted) return;
      counted = true;
      if (api) {
        const seconds = (performance.now() - started) / 1000;
        const { authorization } = headers;
        observe({
          caller: "proxy",
          status: lost ? null : code,
          seconds,
          headers: answerHeaders,
          authorization,
        });
      } else if (advertising || packing) {
        gitStatus = lost ? 0 : code;
        if (advertising && !(gitStatus > 0 && gitStatus < 400)) onGit("fetch", "failed");
      }
    };
    // What the answer changed, kept before its end reaches the run (`settle`, forward()), so that
    // its next call sees it whichever copy of the github service takes it; after a call GitHub
    // never answered, once forward() is over. Once either way.
    let kept = null;
    const after = () =>
      (kept ??= (async () => {
        if (refs && status === 200) await forks.remember(run, advertised, refs.refs());
        if (!watched || !answer) return;
        await wroteWrite(run, { ...watched, at }, status, Buffer.concat(answer));
      })().catch((error) =>
        log(`GitHub gateway: after ${clip(run, `${req.method} ${target.pathname}`)}: ${error}`),
      ));
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
    const how = await forward(req, res, {
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
      heard: (code, answerHeaders) => count(code, answerHeaders, false),
      answered: (code, answerHeaders, lost) => {
        count(code, answerHeaders, lost);
        if (watched || advertised) status = lost ? 0 : code;
      },
      ...((watched || advertised || packing) && { tap }),
      ...((watched || advertised) && { settle: after }),
      ...(logs && { follow }),
      ...(lacks && {
        transform: (code, _, answer) => {
          const out = explained(answer, lacks.message, lacks.paths);
          if (out) {
            const call = `${req.method} ${target.pathname}`;
            note(
              run,
              `Deckhand explained GitHub's refusal of ${clip(run, call)}: ${lacks.message}`,
            );
          }
          return out;
        },
        maxTransform: MAX_ANSWER,
      }),
    });
    // The sandbox gone before GitHub answered: a call without an answer.
    count(0, null, true);
    // An answer cut short (GitHub's connection lost or idle, the sandbox gone) ends the command
    // there: a pack begun isn't a pack come. An advertisement's bad status was counted already.
    const answeredWell = gitStatus > 0 && gitStatus < 400;
    if (packing && (!(answeredWell && how === "done") || packed.failed())) onGit("fetch", "failed");
    else if (packing && packed.found()) onGit("fetch", "ok");
    else if (advertising && answeredWell && how !== "done") onGit("fetch", "failed");
    await after();
  }

  return { handle };
}
