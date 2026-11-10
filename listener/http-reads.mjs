// What the dashboard reads beside api/state (#1069, from http.mjs): whether a user may read a
// run's log, and api/review's reads of GitHub.
import { sendJson } from "../lib/http.mjs";
import { repoAllowed } from "./config.mjs";
import { TASKS } from "./http-state.mjs";
import { keepLast } from "../lib/capped.mjs";

// GET /api/review's reads of GitHub (#911): each costs a pull request, its reviews, a config and
// an issue per follow-up, from the installation's rate limit, and each open Review tab may ask
// again. One read per pull request at a time, kept this long once done, for so many of them.
const REVIEW_MS = 5_000;
const REVIEWS_KEPT = 200;

// `ctx` (../orchestrator/server.mjs); `seeing` and `repoOf`, http-state.mjs createState()'s.
export function createReads(ctx, { seeing, repoOf }) {
  const { config, log } = ctx;

  // Whether `user` may read `run`'s log: `logs:read` on its repo. A run with an owner (a
  // chat's): its owner's alone.
  async function readsLog(user, run) {
    if (run.owner && run.owner !== user) return false;
    const repo = run.repo ?? repoOf(run.key);
    return (await seeing(user, [repo].filter(Boolean), "logs:read"))(repo);
  }

  // The reads of api/review (#911), by pull request: { version, read, at } (at: null until done).
  const reviewReads = new Map();

  // reviews.findings() of pull request `number` of `repo`, shared by the requests asking at once
  // and kept REVIEW_MS once done, while its review entry (`version`: a new round, its merge seen,
  // its follow-ups filed, what the Review tab reads again on) stays the same. A failed read
  // isn't kept: the next request asks again. Asked once `user` may see the repo's tasks.
  function readReview(repo, number) {
    const now = ctx.now ?? Date.now;
    const key = `${repo.toLowerCase()}#${number}`;
    const version = JSON.stringify(ctx.reviews.entry?.(repo, number) ?? null);
    const kept = reviewReads.get(key);
    if (kept?.version === version && (kept.at === null || now() - kept.at < REVIEW_MS)) {
      return kept.read;
    }
    const read = ctx.reviews.findings(repo, number);
    const entry = { version, read, at: null };
    keepLast(reviewReads, key, entry, REVIEWS_KEPT);
    read.then(
      () => (entry.at = now()),
      () => reviewReads.get(key) === entry && reviewReads.delete(key),
    );
    return read;
  }

  // GET /api/review?repo=<owner/repo>&number=<pr>: the last review the App posted on that pull
  // request, its findings read from GitHub now (reviews.mjs findings()), for the task page's
  // Review tab. As a run's log: 404 for a repo `user` may not see the tasks of, as for a pull
  // request without one, so neither says the other exists.
  async function reviewOf(res, user, params) {
    const repo = params.get("repo") ?? "";
    const number = Number(params.get("number"));
    const none = () => sendJson(res, { error: "No review of Deckhand's on it." }, 404);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) {
      return none();
    }
    if (!ctx.reviews?.findings || !repoAllowed(config, repo)) return none();
    if (!(await seeing(user, [repo], TASKS))(repo)) return none();
    let found;
    try {
      found = await readReview(repo, number);
    } catch (error) {
      log(`api/review ${repo}#${number}: ${error.message ?? error}`);
      return sendJson(res, { error: "GitHub couldn't be read: try again." }, 502);
    }
    return found ? sendJson(res, found) : none();
  }

  return { readsLog, reviewOf };
}
