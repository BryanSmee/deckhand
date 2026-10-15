// The graph's work area (the dashboard's Graph page): a repo's backlog, its open issues with no
// task yet, and what dragging one does: start it, queue it after another issue ("/after #n"),
// move its wait or cancel it. Each action is what a comment would do, checked as a comment
// that waited is (tasks.mjs resume()), and written on the issue as the App's comment: bot
// comments never reach admit(), so the listener queues or holds the work itself.
//
//   GET  /api/repos/<owner>/<repo>/issues the backlog and the repo's modes (GitHub asked at
//                                         most once per ISSUES_MS)
//   POST /api/repos/<owner>/<repo>/work   { action: "start", number, mode? }
//                                         { action: "queue", number, after, mode? }
//                                         { action: "dequeue", number }
import { issueList } from "./waits.mjs";
import { CONFIG_FILE, modeNames } from "./repo-config.mjs";
import { sameOrigin } from "./repos.mjs";
import { readBody, sendJson } from "./web.mjs";

// How long a repo's open issues are kept: the dashboard polls them.
export const ISSUES_MS = 30_000;
const MAX_BODY = 4096;
const ACTIONS = ["start", "queue", "dequeue"];

const send = (res, status, value) => sendJson(res, value, status);

// A refusal the dashboard shows as it is.
class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const refuse = (status, message) => {
  throw new Refused(status, message);
};

// The action asked for, checked: { action, number, after, mode }. Throws Refused.
export function parseAction(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    refuse(400, "Not JSON.");
  }
  const { action, number, after = null, mode = null } = body ?? {};
  const issue = (n) => Number.isSafeInteger(n) && n > 0;
  if (!ACTIONS.includes(action)) refuse(400, `The action is one of ${ACTIONS.join(", ")}.`);
  if (!issue(number)) refuse(400, "`number` is an issue number.");
  if (action === "queue" && !issue(after)) refuse(400, "`after` is an issue number.");
  if (mode !== null && (typeof mode !== "string" || !/^[\w-]+$/.test(mode))) {
    refuse(400, "`mode` is a mode's name.");
  }
  return { action, number, after: action === "queue" ? after : null, mode };
}

// Whether the wait of `from` leads, from one blocker to the next, to issue `to`: queueing `to`
// after `from` would then make each wait for the other, and neither would start.
export function leadsTo(get, repo, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop();
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(get(`${repo}#${n}`)?.blockers ?? []));
  }
  return false;
}

// `github(repo, method, path, body, expected)`: the App's calls. `repoSettings(repo, base)`:
// the default branch's config. `reply(repo, number, text)`: the App's comment (comments.mjs).
// `waits` (waits.mjs), `accept(item)` (tasks.mjs). `boardKeys()`: the keys of the tasks on the
// dashboard; `busy(key)`: a run going or queued, which can't be moved.
export function createWorkApi({
  config,
  github,
  repoSettings,
  reply,
  waits,
  accept,
  boardKeys,
  busy,
  publicUrl = () => null,
  now = Date.now,
  log = () => {},
}) {
  // "owner/repo" → { at, read: Promise<{ issues, modes, errors }> }
  const backlogs = new Map();

  const allowed = (repo) => !config.repos.length || config.repos.includes(repo.toLowerCase());

  // The repo's default branch, or a 404 when the App can't read it.
  async function baseOf(repo) {
    const res = await github(repo, "GET", `/repos/${repo}`, undefined, [404]);
    if (res.status === 404) refuse(404, `The App is not installed on ${repo}.`);
    if (!res.ok) throw new Error(`GitHub GET /repos/${repo}: ${res.status}`);
    return (await res.json()).default_branch || "main";
  }

  // The repo's open issues, newest first (pull requests are issues to this API: left out), and
  // the modes the dashboard offers: onboarding is the listener's own.
  async function readBacklog(repo) {
    const base = await baseOf(repo);
    const { settings, errors } = await repoSettings(repo, base);
    const res = await github(
      repo,
      "GET",
      `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100`,
    );
    const list = res.ok ? await res.json() : null;
    if (!Array.isArray(list)) throw new Error(`GitHub GET issues of ${repo}: ${res.status}`);
    return {
      issues: list
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, title: i.title ?? null, url: i.html_url })),
      modes: errors.length ? [] : modeNames(settings).filter((m) => m !== "onboarding"),
      errors: errors.length > 0,
    };
  }

  async function backlog(res, repo) {
    let known = backlogs.get(repo.toLowerCase());
    if (!known || now() - known.at >= ISSUES_MS) {
      known = { at: now(), read: readBacklog(repo) };
      backlogs.set(repo.toLowerCase(), known);
      // A failure is not kept: the next poll asks again.
      known.read.catch(
        () => backlogs.get(repo.toLowerCase()) === known && backlogs.delete(repo.toLowerCase()),
      );
    }
    const { issues, modes, errors } = await known.read;
    // The tasks change between two reads: an issue started a moment ago leaves at once.
    const keys = boardKeys();
    send(res, 200, {
      issues: issues.filter((i) => !keys.has(`${repo}#${i.number}`)),
      modes,
      errors,
      readAt: known.at,
    });
  }

  // The checks a comment passes, for the signed-in `user`: the repo's config without errors,
  // the user in both the operator's and the repo's users, an open issue (not a pull request)
  // with no run going or queued. Returns { settings, base, issue }; throws Refused.
  async function checked(repo, user, number) {
    const login = user.toLowerCase();
    if (!config.users.includes(login)) refuse(403, `${user} is not in ALLOWED_USERS.`);
    const base = await baseOf(repo);
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length) {
      refuse(
        409,
        `${CONFIG_FILE} of ${repo} has errors: no run starts there until they are fixed.`,
      );
    }
    if (!settings.users.includes(login)) refuse(403, `${user} is not among ${repo}'s users.`);
    const res = await github(repo, "GET", `/repos/${repo}/issues/${number}`, undefined, [404, 410]);
    if (res.status === 404 || res.status === 410)
      refuse(404, `#${number} isn't an issue of ${repo}.`);
    if (!res.ok) throw new Error(`GitHub GET #${number}: ${res.status}`);
    const issue = await res.json();
    if (issue.pull_request) refuse(422, `#${number} is a pull request: start its issue instead.`);
    if (issue.state !== "open") refuse(409, `#${number} is closed.`);
    if (busy(`${repo}#${number}`)) {
      refuse(409, `#${number} is running or queued: it can't be moved now.`);
    }
    return { settings, base, issue };
  }

  // The App's comment on the issue: the record of who did what, and where the run's reactions
  // go, as on the comment it stands for.
  async function comment(repo, number, text) {
    const res = await reply(repo, number, text);
    if (!res.ok) throw new Error(`GitHub POST a comment on #${number}: ${res.status}`);
    const c = await res.json();
    return { id: c.id, html_url: c.html_url, node_id: c.node_id };
  }

  // What a trigger comment ("Deckhand", with "/mode <name>" unless it is work) would queue.
  function itemOf(repo, issue, mode, user, base, settings) {
    return {
      repo,
      id: String(issue.number),
      kind: "issue",
      number: issue.number,
      title: issue.title ?? null,
      trigger: "work",
      modeLine: mode === "work" ? null : mode,
      text: "",
      replyTo: issue.number,
      author: user,
      base,
      settings,
    };
  }

  const inMode = (mode) => (mode === "work" ? "" : ` in \`${mode}\` mode`);

  async function act(repo, user, { action, number, after, mode }) {
    const key = `${repo}#${number}`;
    const { settings, base, issue } = await checked(repo, user, number);
    const wait = waits.get(key);
    if (action === "dequeue") {
      if (!wait) refuse(409, `#${number} doesn't wait for anything.`);
      waits.cancel(key, `cancelled from the dashboard by @${user}`);
      await comment(
        repo,
        number,
        `No longer waiting for ${issueList(wait.blockers)}: cancelled from the dashboard by @${user}. Nothing starts until a trigger comment or the dashboard says so.`,
      );
      return `#${number} no longer waits.`;
    }
    // Moving a wait keeps its mode, unless another one is picked.
    const wanted = mode ?? wait?.item.modeLine ?? "work";
    if (!modeNames(settings).includes(wanted)) refuse(422, `${repo} has no mode \`${wanted}\`.`);
    const item = itemOf(repo, issue, wanted, user, base, settings);
    if (action === "queue") {
      if (after === number) refuse(422, `#${number} can't wait for itself.`);
      if (leadsTo(waits.get, repo, after, number)) {
        refuse(422, `#${after} waits for #${number}: each would wait for the other.`);
      }
      const state = await waits.stateOf(repo, after);
      if (state === "missing") refuse(422, `#${after} isn't an issue or pull request of ${repo}.`);
      if (state === "not-done") refuse(422, `#${after} was closed without being done.`);
      if (state === "open") {
        if (wait?.blockers.length === 1 && wait.blockers[0] === after && !mode) {
          return `#${number} already waits for #${after}.`;
        }
        const text = wait
          ? `Moved from the dashboard by @${user}: now after #${after}${inMode(wanted)} (it waited for ${issueList(wait.blockers)}).`
          : `Queued from the dashboard by @${user}, after #${after}${inMode(wanted)}.`;
        item.comment = await comment(
          repo,
          number,
          `${text} It starts when #${after} is done (closed as completed, or merged).`,
        );
        await waits.hold(item, [after]);
        return `#${number} waits for #${after}.`;
      }
      // Done already: it starts now, as "/after" would.
    }
    waits.cancel(key, `started from the dashboard by @${user}`);
    const why = action === "queue" ? `: #${after} is done already` : "";
    const was =
      wait && action === "start" ? ` It no longer waits for ${issueList(wait.blockers)}.` : "";
    item.comment = await comment(
      repo,
      number,
      `Started from the dashboard by @${user}${inMode(wanted)}${why}.${was}`,
    );
    await accept(item);
    return `#${number} started.`;
  }

  async function work(req, res, user, repo) {
    if (!sameOrigin(req, publicUrl())) {
      log(`Work area: refused for ${user}: Origin ${req.headers.origin ?? "missing"}`);
      return send(res, 403, { error: "Not from this dashboard." });
    }
    const asked = parseAction((await readBody(req, MAX_BODY)).toString("utf8"));
    log(
      `Work area: ${user} asks ${asked.action} ${repo}#${asked.number}${asked.after ? ` after #${asked.after}` : ""}`,
    );
    const message = await act(repo, user, asked);
    send(res, 200, { message });
  }

  // Handles /api/repos/<owner>/<repo>/issues and /work; false for any other path.
  function handle(req, res, user) {
    const { pathname } = new URL(req.url, "http://localhost");
    const one = /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/(issues|work)$/.exec(pathname);
    if (!one) return false;
    const repo = `${one[1]}/${one[2]}`;
    const post = one[3] === "work";
    const run = async () => {
      if (post && req.method !== "POST") return send(res, 405, { error: "POST only." });
      if (!post && req.method !== "GET") return send(res, 405, { error: "GET only." });
      if (!user) return send(res, 401, { error: "Sign in first." });
      if (!allowed(repo)) return send(res, 404, { error: `${repo} is not in ALLOWED_REPOS.` });
      return post ? work(req, res, user, repo) : backlog(res, repo);
    };
    run().catch((error) => {
      if (error instanceof Refused) {
        log(`Work area: ${repo}: refused for ${user}: ${error.message}`);
        if (!res.headersSent) send(res, error.status, { error: error.message });
        return;
      }
      log(`Work area: ${error.stack ?? error}`);
      if (!res.headersSent) {
        send(res, 502, { error: "GitHub didn't answer: see the listener's logs." });
      }
    });
    return true;
  }

  return { handle };
}
