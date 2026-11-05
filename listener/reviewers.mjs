// Reviewers on Deckhand's pull requests (issue #452): the logins a repo's `review.request`
// names, requested by the listener with its own token, never by a run (a run doesn't pick who
// gets notified). Asked when Deckhand's pull request turns ready, and again when a run that
// pushed to it while it was ready is over (a fix run, a CI fix run, a rebase, a maintainer's
// follow-up): a moved head is what the reviewers have to look at again. Only users the
// operator allows (ALLOWED_USERS), never a team; each head commit once, across redeliveries
// and restarts (the store's `requested`). The policies' `deny_request_review` may refuse it, keyed on
// the mode of the run whose pull request it is (Deckhand's default, ../policy/gh-reviewers.rego:
// work runs only).
import { repoAllowed } from "./config.mjs";
import { headInRepo, linkedIssue, prId, taskKey } from "./events.mjs";
import { getJson, paginate } from "./github.mjs";
import { BUILT_IN } from "./modes.mjs";
import { isPolicyError, pullInput } from "./policies.mjs";
import { sameTask } from "./spelling.mjs";

// A requested head commit is forgotten after this: the pull request is long merged or closed.
const KEEP_MS = 90 * 24 * 3600_000;

// A `pull_request` delivery about Deckhand's own pull request turning ready (marked ready, or
// opened as ready), on a branch of the repo → { repo, base, pr }, or null.
export function readyPull(config, event, p) {
  if (event !== "pull_request") return null;
  const pr = p.pull_request;
  const ready = p.action === "ready_for_review" || (p.action === "opened" && pr && !pr.draft);
  const repo = p.repository?.full_name;
  if (!ready || !p.installation?.id || !repo || !repoAllowed(config, repo)) return null;
  if (!ownReady(config, repo, pr)) return null;
  return { repo, base: p.repository.default_branch || "main", pr };
}

// Whether GitHub's pull request `pr` is Deckhand's own, open, ready and on a branch of `repo`.
export function ownReady(config, repo, pr) {
  const login = pr?.user?.login?.toLowerCase();
  if (!config.bot || login !== config.bot.toLowerCase()) return false;
  return pr.state === "open" && !pr.draft && headInRepo(pr, repo);
}

// Whether a run that is over asks for its pull request's reviewers again (pushed()): one that
// could push, finished (not an error, a cancel or a stop to ask, whose `WIP:` push is
// unfinished work), and pushed during the run (`record.lastPushAt`, the git gateway's), on a
// task whose pull request (`pull`, pulls.mjs's) is ready. A maintainer's push followed by a
// run that pushed nothing isn't a fix.
export function askAfterRun({ light, record, pull }) {
  return !light && record?.status === "ok" && !!record.lastPushAt && pull?.state === "ready";
}

// The logins to request on `pr`: the repo's `review.request`, those the operator still allows
// (ALLOWED_USERS may have narrowed since the settings were read), never its author.
export function reviewersFor(config, settings, pr) {
  const author = pr?.user?.login?.toLowerCase();
  return (settings?.review?.request ?? []).filter(
    (login) => config.users.includes(login) && login !== author,
  );
}

// What the policies read of the run whose pull request it is (github-writes.mjs runTraits()'s
// fields), from its record (runlog.mjs newRecord()); none known: `mode` null.
export function runFields(record) {
  const mode = record?.taskMode ?? null;
  return {
    mode,
    custom_mode: !!mode && !BUILT_IN.has(mode),
    reason: record?.reason ?? null,
  };
}

// The run whose pull request `pr` is (GitHub's), among `runs` (runlog.mjs records, newest
// first): the newest on task `key` that could push and had started when GitHub created it, so
// the run that opened it, not a later follow-up in another mode. Null when none is known any
// more (an older run dropped from the history).
export function openerOf(runs, key, pr) {
  const created = Date.parse(pr?.created_at ?? "");
  return (
    runs.find(
      (r) =>
        sameTask(r.key, key) &&
        !r.light &&
        Number.isFinite(created) &&
        Number.isFinite(r.startedAt) &&
        r.startedAt <= created,
    ) ?? null
  );
}

// The input of `deny_request_review` (docs/repo-config.md#the-reviewers-input): the pull
// request's (pullInput(), no review), the `reviewers` to request, `when` ("ready": it turned
// ready; "fix": a run pushed to it since), and the run's fields (runFields()).
export function requestInput({
  info,
  pr,
  files,
  issue,
  reviewers,
  when,
  run,
  bot = null,
  external = null,
  now = Date.now,
}) {
  return {
    ...pullInput({ decision: "request_review", info, pr, files, issue, bot, external, now }),
    reviewers,
    when,
    ...run,
  };
}

// `repoSettings(repo, base)`: the repo's settings from its default branch; `github`: the App's
// calls; `runOf(key, pr)`: the record of the run whose pull request `pr` is, on task `key`
// (openerOf()), or null; `policies`: the policies' engine (policies.mjs), none without;
// `decided(repo, pr, entry)`: a decision a policy was asked for, for the task's page.
// `requested`: the Map the requests are kept in (storeMap()'s).
export function createReviewers({
  requested = new Map(),
  config,
  repoSettings,
  github,
  runOf = () => null,
  // The login whose machine pushed a pull request (pulls.mjs externalOf(), #598), or null.
  externalOf = () => null,
  policies = null,
  decided = () => {},
  // Who may do what where (permissions.mjs): a reviewer needs `tasks:read` on the repo.
  permissions = null,
  log = () => {},
  now = Date.now,
}) {
  // Those of `logins` who may see `repo`'s tasks: a reviewer who can't is never asked. A
  // decision that fails throws: nothing is requested nor remembered, and the next delivery or
  // run's end asks again.
  async function readers(repo, logins) {
    if (!permissions) return logins;
    const may = await permissions.whoMay(logins, repo, "tasks:read");
    const out = logins.filter((l) => may.has(l.toLowerCase()));
    if (out.length < logins.length) {
      const left = logins.filter((l) => !out.includes(l));
      log(`${repo}: reviewers left out, without tasks:read: ${left.join(", ")}`);
    }
    return out;
  }

  // In `requested`, "org/repo#pr-5" → { head, at }: the head commit last asked about,
  // requested or refused.
  // Pull request key → the request being decided: a delivery and a run's end at once ask once.
  const going = new Map();

  // One request at a time per pull request.
  function serial(key, work) {
    const before = going.get(key) ?? Promise.resolve();
    const next = before.then(work, work);
    going.set(key, next);
    const clear = () => going.get(key) === next && going.delete(key);
    next.then(clear, clear);
    return next;
  }

  // A `pull_request` delivery: Deckhand's pull request turned ready.
  async function ready(event, payload) {
    const found = readyPull(config, event, payload);
    if (!found) return null;
    return request(found.repo, found.base, found.pr.number, "ready");
  }

  // A run that could push is over on pull request `number` of `repo`: its reviewers again, if
  // it is still ready and its head moved since they were asked.
  function pushed({ repo, base, number }) {
    return request(repo, base, number, "fix");
  }

  // Requests the reviewers of `repo`'s `review.request` on pull request `number`, read from
  // GitHub now, unless its head was asked about already. → the logins requested, or null.
  function request(repo, base, number, when) {
    // Lower case: a delivery and a run may spell the repo differently.
    const key = taskKey(repo.toLowerCase(), prId(number));
    return serial(key, async () => {
      const { settings, errors } = await repoSettings(repo, base);
      if (errors.length || !settings.review?.request?.length) return null;
      const pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
      if (!pr || !ownReady(config, repo, pr)) return null;
      const head = pr.head?.sha ?? null;
      if (head && requested.get(key)?.head === head) return null;
      const reviewers = await readers(repo, reviewersFor(config, settings, pr));
      if (!reviewers.length) return null;
      // Never asked about before (its ready delivery was lost, or `review.request` is new):
      // this is its turning ready, as far as its reviewers know.
      if (!requested.has(key)) when = "ready";
      const task = taskKey(repo, linkedIssue(pr, repo, config.bot) ?? prId(number));
      const run = runFields(runOf(task, pr));
      const denied = await deny(repo, base, pr, { reviewers, when, run });
      if (denied.length) {
        log(`${key}: reviewers not requested: ${denied.join(" | ")}`);
        // A rule's refusal holds at this head; a failure (GitHub couldn't give the input, a
        // policy that didn't compile) is asked again at the next delivery or run's end.
        if (!denied.some(isPolicyError)) remember(key, head);
        return null;
      }
      const res = await github(
        repo,
        "POST",
        `/repos/${repo}/pulls/${number}/requested_reviewers`,
        { reviewers },
        [422],
      );
      if (!res.ok) {
        log(`${key}: requesting ${reviewers.join(", ")}: GitHub answered ${res.status}`);
        // A login that isn't a collaborator: GitHub refuses the whole request, and would again.
        // Anything else (5xx, a rate limit) is asked again at the next delivery or run's end.
        if (res.status === 422) remember(key, head);
        return null;
      }
      remember(key, head);
      log(`${key}: reviewers requested (${when}): ${reviewers.join(", ")}`);
      return reviewers;
    });
  }

  // Why the policies refuse requesting `reviewers` on `pr` (`deny_request_review`): their
  // messages, or [] (always without policies). The decision is kept for the task's page.
  async function deny(repo, base, pr, { reviewers, when, run }) {
    if (!policies) return [];
    const issue = linkedIssue(pr, repo, config.bot);
    const input = async () => {
      const info = await getJson(github, repo, `/repos/${repo}`);
      const files = await paginate(
        (path) => github(repo, "GET", path),
        `/repos/${repo}/pulls/${pr.number}/files`,
      );
      const found = issue
        ? {
            number: issue,
            ...(await getJson(github, repo, `/repos/${repo}/issues/${issue}`, [404, 410])),
          }
        : null;
      return requestInput({
        info,
        pr,
        files,
        issue: found,
        reviewers,
        when,
        run,
        bot: config.bot,
        external: externalOf(repo, pr.number),
        now,
      });
    };
    const rule = "deny_request_review";
    const {
      applied,
      messages,
      input: saw,
      layers,
    } = await policies.decide(rule, repo, base, input);
    if (applied) {
      const gates = [
        { name: "Deckhand's own pull request, ready", passed: true },
        { name: "Allowed users only", passed: true },
      ];
      const entry = {
        decision: "request_review",
        rule,
        denied: messages.length > 0,
        messages,
        pr: pr.number,
        gates,
        ...(layers?.length && { layers }),
        ...(saw && { input: saw }),
      };
      try {
        decided(repo, pr, entry);
      } catch (error) {
        log(`${repo}#${pr.number}: keeping its ${rule} decision: ${error.message ?? error}`);
      }
    }
    return messages;
  }

  function remember(key, head) {
    const cutoff = now() - KEEP_MS;
    for (const [k, v] of requested) if (v.at < cutoff && k !== key) requested.delete(k);
    requested.set(key, { head, at: now() });
  }

  return { ready, pushed, request };
}
