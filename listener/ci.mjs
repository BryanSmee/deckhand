// What CI says of a commit: failed, running or passed, over its GitHub Actions runs, its check
// runs (other Apps' CI, code scanning…) and its commit statuses (older services' CI). One rule
// for the merge gate and the review's CI step (reviews.mjs), which pass it Actions runs only so
// far (`mergeable_state` stands for the rest there), and the dashboard's CI status of a task's
// pull request (pulls.mjs, #436), over all three (commitCi()).

// Conclusions that pass, of an Actions run or a check run: they neither stop a merge nor start
// a CI fix run.
export const PASSED = new Set(["success", "skipped", "neutral"]);
// GitHub Actions' own App: its check runs are its jobs, which the Actions runs already decide.
const ACTIONS_APP = "github-actions";

// A commit's CI → { state, failed, going }: `failed` when one completed with any other
// conclusion (even while others go on), else `running` while one hasn't completed, else
// `passed`, or `none` without any. `failed` and `going` hold them as GitHub gave them (a
// status's name is its `context`).
//
// - `runs`: its Actions runs (`…/actions/runs?head_sha=`). A run cancelled and replaced by a
//   newer one of its workflow and event (`cancel-in-progress` when `gh pr ready` starts it
//   again) decides nothing (countedRuns()); any other failure still does.
// - `checks`: its check runs (`…/commits/<sha>/check-runs`, the latest of each name). With
//   `runs` given, those of GitHub Actions are left to them.
// - `statuses`: its commit statuses (`…/commits/<sha>/status`'s, or `…/statuses`, the newest of
//   each context deciding): `pending` is running, `success` passed, `failure` and `error` failed.
//
// An array alone is `runs`.
export function ciState(input = {}) {
  const { runs, checks = [], statuses = [] } = Array.isArray(input) ? { runs: input } : input;
  const counted = countedRuns(runs ?? []);
  const others = checks.filter((c) => runs === undefined || c.app?.slug !== ACTIONS_APP);
  const contexts = latestStatuses(statuses);
  const done = (x) => x.status === "completed";
  const failed = [
    ...counted.filter((r) => done(r) && !PASSED.has(r.conclusion)),
    ...others.filter((c) => done(c) && !PASSED.has(c.conclusion)),
    ...contexts.filter((s) => s.state !== "pending" && s.state !== "success"),
  ];
  const going = [
    ...counted.filter((r) => !done(r)),
    ...others.filter((c) => !done(c)),
    ...contexts.filter((s) => s.state === "pending"),
  ];
  const all = counted.length + others.length + contexts.length;
  const state = failed.length ? "failed" : going.length ? "running" : all ? "passed" : "none";
  return { state, failed, going };
}

// `runs` without those cancelled and replaced: a newer run of the same workflow and event (by
// `run_number`, then `created_at`, then `id`) exists. Only `cancelled`: a newer run that passes
// or is skipped (a label starting the workflow again, its jobs skipped) never hides a failure.
// A run without `workflow_id` stands alone.
export function countedRuns(runs) {
  const newest = new Map();
  const order = (r) => [r.run_number ?? 0, String(r.created_at ?? ""), r.id ?? 0];
  runs.forEach((r, i) => {
    const key = r.workflow_id == null ? `run:${i}` : `${r.workflow_id}:${r.event ?? ""}`;
    const kept = newest.get(key);
    if (!kept || newer(order(r), order(kept))) newest.set(key, r);
  });
  const latest = new Set(newest.values());
  return runs.filter((r) => latest.has(r) || r.conclusion !== "cancelled");
}

// The newest status of each context (by `updated_at`, then `created_at`, then `id`): a service
// posts `pending`, then its result, and `…/statuses` lists them all.
export function latestStatuses(statuses) {
  const newest = new Map();
  const order = (s) => [String(s.updated_at ?? ""), String(s.created_at ?? ""), s.id ?? 0];
  for (const s of statuses) {
    const key = String(s.context ?? "");
    const kept = newest.get(key);
    if (!kept || newer(order(s), order(kept))) newest.set(key, s);
  }
  return [...newest.values()];
}

// Whether the sort key `x` comes after `y`.
function newer(x, y) {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// A commit's CI for the dashboard (pulls.mjs, #436) → { state, runs: [{ name, state, url }] },
// over ciState()'s input: its state, and each run, check run and status that counts, as running,
// failed or passed, failed ones first. A cancelled run replaced by a newer one isn't listed, nor
// the check runs of GitHub Actions when its runs are given: ciState() leaves them out too.
export function ciSummary(input = {}) {
  const { runs, checks = [], statuses = [] } = Array.isArray(input) ? { runs: input } : input;
  const counted = countedRuns(runs ?? []);
  const others = checks.filter((c) => runs === undefined || c.app?.slug !== ACTIONS_APP);
  const contexts = latestStatuses(statuses);
  const { state, failed, going } = ciState({ runs, checks, statuses });
  const of = (x) => (failed.includes(x) ? "failed" : going.includes(x) ? "running" : "passed");
  const RANK = { failed: 0, running: 1, passed: 2 };
  const items = [
    ...counted.map((r) => ({
      name: r.name ?? r.display_title ?? "?",
      state: of(r),
      url: r.html_url,
    })),
    ...others.map((c) => ({ name: c.name ?? "?", state: of(c), url: c.html_url ?? c.details_url })),
    ...contexts.map((s) => ({ name: s.context ?? "?", state: of(s), url: s.target_url })),
  ]
    .map(({ url, ...item }) => ({ ...item, url: typeof url === "string" && url ? url : null }))
    .sort((a, b) => RANK[a.state] - RANK[b.state]);
  return { state, runs: items };
}

// Commit `sha`'s CI as GitHub has it now (`github(repo, method, path, body, expected)`, the
// App's calls) → { sha, state, runs } (ciSummary()), or null when GitHub gave none of it. Each
// of its Actions runs, check runs and statuses is left out when GitHub refuses it (an
// installation that hasn't accepted `checks` or `statuses` yet): without the Actions runs,
// GitHub Actions' check runs stand for them.
export async function commitCi(github, repo, sha) {
  const at = encodeURIComponent(sha);
  const read = async (path, field) => {
    const res = await github(repo, "GET", path, undefined, [403, 404, 422]);
    if (!res.ok) return undefined;
    return (await res.json())?.[field] ?? [];
  };
  const [runs, checks, statuses] = await Promise.all([
    read(`/repos/${repo}/actions/runs?head_sha=${at}&per_page=100`, "workflow_runs"),
    read(`/repos/${repo}/commits/${at}/check-runs?per_page=100`, "check_runs"),
    read(`/repos/${repo}/commits/${at}/status?per_page=100`, "statuses"),
  ]);
  if (!runs && !checks && !statuses) return null;
  return { sha, ...ciSummary({ runs, checks: checks ?? [], statuses: statuses ?? [] }) };
}
