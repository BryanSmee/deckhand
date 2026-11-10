// Auto-merge's gates (reviews.mjs, `review.merge`): what blocks a merge (mergeBlockers()), the
// files a run's push may not change (trustedFile()), and why a pull request isn't merged
// (mergeRefusal()); the pull request's input to the policies (mergeInput(), readPullInput()).
import { ciState, countedRuns } from "./ci.mjs";
import { waitsForInput } from "./comments.mjs";
import { headInRepo, linkedIssue, taskKey } from "./events.mjs";
import { getJson, paginate } from "./github.mjs";
import { passed, pullInput } from "./policies.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { above, blockingComments } from "./review-parse.mjs";
import { policyWhy, short } from "./review-texts.mjs";

// What an auto-merge blocks on (autoMerge()): critical and high findings always; medium ones
// too, unless `allowed` (`review.max_allowed_severity`, for the review that decides the merge)
// is medium; and every blocking comment, whatever `allowed` says. Low findings never: a
// "request changes" verdict still blocks (autoMerge()), issue #288.
export function mergeBlockers(review, allowed = "low") {
  return [...above(review, allowed), ...blockingComments(review)];
}

// The files Deckhand trusts on the default branch: an auto-merge that changed one would let a
// run widen its own config, so such a pull request always waits for a human. → whether `path`
// (a changed file's, repo-relative) is one: the config and `.deckhand/`, `.github/`, any
// CODEOWNERS, and the files the config names (instructions, Dockerfile, the review
// instructions, the modes' instructions).
export function trustedFile(settings, path) {
  const named = new Set(
    [
      settings?.instructions,
      settings?.dockerfile,
      settings?.review?.instructions,
      ...Object.values(settings?.modes ?? {}).map((m) => m?.instructions),
    ]
      .filter((p) => typeof p === "string" && p)
      .map((p) => p.replace(/^\.\//, "")),
  );
  return (
    path === CONFIG_FILE ||
    path.startsWith(".deckhand/") ||
    // Without case, as the git gateway reads workflow folders (git-mirror.mjs): a workflow
    // `workflow_secrets` let through must never be merged with nobody reading it (#700).
    /^\.github\//i.test(path) ||
    /(^|\/)CODEOWNERS$/.test(path) ||
    named.has(path)
  );
}

// The repository's setting that allows each merge method (GET /repos/{repo}).
const ALLOWS = {
  squash: "allow_squash_merge",
  merge: "allow_merge_commit",
  rebase: "allow_rebase_merge",
};

// The GitHub Actions runs on commit `sha` → { ok, status, runs }: not ok when GitHub refuses
// to list them (403, 404).
export async function actionsRuns(github, repo, sha) {
  const res = await github(
    repo,
    "GET",
    `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
    null,
    [403, 404],
  );
  if (!res.ok) return { ok: false, status: res.status, runs: [] };
  return { ok: true, status: res.status, runs: (await res.json()).workflow_runs ?? [] };
}

// How many commits branch `base` has that commit `sha` doesn't, or null when GitHub can't
// compare them (a branch gone, a commit unknown).
async function behindBy(github, repo, base, sha) {
  const found = await getJson(
    github,
    repo,
    `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(sha)}?per_page=1`,
    [404, 422],
  );
  return Number.isInteger(found?.behind_by) ? found.behind_by : null;
}

// The `mergeable_state`s that checks still going can explain: `unstable` (a check or status
// pending or failing), `blocked` (branch protection waiting for required checks), `unknown`
// (still computed after MERGEABLE_TRIES). Any other one but `clean` refuses at once.
const AWAITABLE = new Set(["clean", "unstable", "blocked", "unknown"]);

// GitHub computes `mergeable_state` after the first ask: asked again this often, this many
// times, while it says "unknown".
const MERGEABLE_TRIES = 4;
const MERGEABLE_WAIT_MS = 3000;

// Why pull request `number` must not be merged now, or null with what the merge needs: { pr,
// method }. Each gate is asked of GitHub now, not from the webhook or the config alone: the
// pull request Deckhand's own, on a branch of the repo and linked to its issue, open, not a
// draft, nothing waiting for the maintainer, still at the reviewed head `sha`, the repository
// private (or granted `public`), the merge method allowed, no file Deckhand trusts changed,
// `mergeable_state` clean, its GitHub Actions runs finished and none failed; last, the
// operator's and the repo's policies (`deny_merge`, policies.mjs), which only add refusals.
// `pending`: only Actions runs still going stand in the way, so the caller may wait for them;
// `closed`: the pull request was closed or merged meanwhile.
// `busy(task)`: a run going or queued on the issue; `policies`: createPolicies(), none without;
// `review`, `fixes`: the review deciding the merge and how many fix runs came before it, for
// the policies' input; `gates`: what the caller checked before ([{ name, passed }]), kept with
// the policies' decision before the gates passed here. `externalOf(repo, number)`: the login whose
// machine pushed it (pulls.mjs), for the input's `pr.external`.
export async function mergeRefusal(
  {
    github,
    config,
    busy = () => false,
    sleep,
    policies = null,
    externalOf = () => null,
    now = Date.now,
  },
  { repo, number, sha, settings, grant, review = null, fixes = 0, gates = [] },
) {
  let pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
  if (!pr) return { why: "the pull request can't be read" };
  const own = !!config.bot && pr.user?.login?.toLowerCase() === config.bot.toLowerCase();
  const issue = own && headInRepo(pr, repo) ? linkedIssue(pr, repo, config.bot) : null;
  if (!issue) {
    return {
      why: "it isn't Deckhand's own pull request, on a branch of the repository and linked to its issue",
    };
  }
  if (pr.state !== "open" || pr.merged) return { why: "it isn't open", closed: true };
  if (pr.draft) return { why: "it is a draft" };
  if (await waitsForInput(github, config, repo, pr, issue)) {
    return { why: `it or #${issue} waits for the maintainer's input (${config.needsInputLabel})` };
  }
  // `rebase`: a refusal a conflict run may have caused (a run going, its push), which its end
  // lifts (createReviews() rebased()).
  if (busy(taskKey(repo, String(issue)))) {
    return { why: `#${issue} has a run going or queued`, rebase: true };
  }
  if (!sha || pr.head?.sha !== sha) {
    return {
      why: `a commit was pushed after the review (reviewed ${short(sha)}, now ${short(pr.head?.sha)})`,
      rebase: true,
    };
  }
  const info = await getJson(github, repo, `/repos/${repo}`);
  if (info.private !== true && grant?.allowAutoMerge !== "public") {
    return {
      why: "the repository is public, and the operator's policies grant it `auto_merge`, not `auto_merge_public`",
    };
  }
  const method = settings.review?.mergeMethod ?? "squash";
  if (info[ALLOWS[method]] === false) {
    return {
      why: `the repository doesn't allow the \`${method}\` merge method (\`review.merge_method\`)`,
    };
  }
  const files = await paginate(
    (path) => github(repo, "GET", path),
    `/repos/${repo}/pulls/${number}/files`,
  );
  const trusted = [
    ...new Set(
      files
        .flatMap((f) => [f.filename, f.previous_filename])
        .filter((path) => path && trustedFile(settings, path)),
    ),
  ];
  if (trusted.length) {
    const list = trusted.slice(0, 10).map((path) => `\`${path}\``);
    // A workflow's secrets would reach the default branch with no person reviewing it.
    const workflows = trusted.some((path) => /^\.github\/workflows\//i.test(path))
      ? " (a workflow on the default branch runs with the repository's secrets: a person reviews it first)"
      : "";
    return { why: `it changes files Deckhand trusts: ${list.join(", ")}${workflows}` };
  }
  // GitHub lists 3000 files at most, without saying so: a trusted one may be past the end.
  if (!(files.length >= pr.changed_files)) {
    return {
      why: `GitHub lists ${files.length} of its ${pr.changed_files ?? "?"} changed files, so the files Deckhand trusts can't all be checked`,
    };
  }
  for (let i = 1; pr.mergeable_state === "unknown" || pr.mergeable_state == null; i++) {
    if (i >= MERGEABLE_TRIES) break;
    await sleep(MERGEABLE_WAIT_MS);
    pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`);
  }
  if (pr.head?.sha !== sha) return { why: "a commit was pushed after the review", rebase: true };
  const state = pr.mergeable_state ?? "unknown";
  const notClean = {
    why: `GitHub doesn't call it cleanly mergeable (\`mergeable_state: ${state}\`)`,
    // A conflict with its base: the conflict watcher's run rebases it.
    ...(state === "dirty" && { rebase: true }),
  };
  // A conflict or a branch behind its base: no check finishing changes that.
  if (!AWAITABLE.has(state)) return notClean;
  // Behind its base: its checks ran without the base's latest commits, which may break it once
  // merged (#714, #778). GitHub says `behind` only when branch protection requires branches up to
  // date, and private repositories on the Free plan have none: asked of the base's branch now.
  const base = pr.base?.ref || info.default_branch;
  const behind = await behindBy(github, repo, base, sha);
  if (behind == null) return { why: `it can't be compared with \`${base}\`` };
  if (behind > 0) {
    return {
      why: `its branch is ${behind} commit${behind > 1 ? "s" : ""} behind \`${base}\`, which its checks didn't run with: update the branch`,
    };
  }
  const read = await actionsRuns(github, repo, sha);
  if (!read.ok) return { why: `its GitHub Actions runs can't be read (${read.status})` };
  const { runs } = read;
  // A failed run refuses at once, even while others go on.
  const { state: ci, failed, going } = ciState(runs);
  if (ci === "failed") {
    const names = failed.slice(0, 5).map((r) => `${r.name ?? "a run"} (${r.conclusion})`);
    return { why: `GitHub Actions runs on ${short(sha)} failed: ${names.join(", ")}` };
  }
  // Not yet rather than no: the caller waits for them (autoMerge()).
  if (ci === "running") {
    return {
      why: `${going.length} GitHub Actions run${going.length > 1 ? "s" : ""} on ${short(sha)} ha${going.length > 1 ? "ve" : "s"}n't finished`,
      pending: true,
    };
  }
  // Every Actions run passed: what GitHub still counts is a check or status the App can't read.
  if (state === "unstable") {
    return {
      why: `a check or commit status on ${short(sha)} that isn't a GitHub Actions run is pending or failing (\`mergeable_state: unstable\`, every Actions run on it passed)`,
    };
  }
  if (state !== "clean") return notClean;
  if (policies) {
    const input = async () => {
      const found = await getJson(github, repo, `/repos/${repo}/issues/${issue}`, [404, 410]);
      return mergeInput({
        info,
        pr,
        bot: config.bot,
        external: externalOf(repo, number),
        files,
        issue: found ?? { number: issue },
        review,
        fixes,
        runs,
        now,
      });
    };
    // Every gate above passed, or it would have returned: what the task's page shows next to
    // the policies' answer.
    const checked = [
      ...gates,
      passed("Deckhand's own pull request"),
      passed("Open, not a draft"),
      passed("Nobody's input awaited"),
      passed("No run going"),
      passed("Repository visibility"),
      passed(`Merge method ${method} allowed`),
      passed("No trusted file changed"),
      passed("Cleanly mergeable"),
      passed(`Up to date with ${base}`),
      passed("Checks green"),
    ];
    const ref = info.default_branch || "main";
    const denied = await policies.deny("deny_merge", repo, ref, input, { gates: checked });
    if (denied.length) return { why: policyWhy("deny_merge", denied) };
  }
  return { why: null, pr, method };
}

// The input of `deny_merge` (docs/repo-config/policy-inputs.md#the-merge-input), from what mergeRefusal()
// read: names as GitHub's API spells them where they are its own, the review as parsed.
export function mergeInput({
  info,
  pr,
  files,
  issue,
  review,
  fixes = 0,
  runs,
  bot = null,
  external = null,
  now = Date.now,
}) {
  return {
    ...pullInput({ decision: "merge", info, pr, files, issue, review, bot, external, now }),
    ...fixInput(fixes),
    checks: checksOf(runs),
  };
}

// Actions runs as the policies' inputs have them (`checks[]`): those the gate counts
// (countedRuns()), so a policy never refuses for a run the gate let go.
export const checksOf = (runs) =>
  countedRuns(runs).map((r) => ({
    name: r.name ?? null,
    status: r.status ?? null,
    conclusion: r.conclusion ?? null,
  }));

// How many fix runs the pull request had (`review.fix`): `fixed`, whether any, as rules from
// before the rounds read it.
export const fixInput = (fixes) => ({ fixed: fixes > 0, fixes });

// The input of `deny_review` and `deny_fix` (docs/repo-config/policy-inputs.md#the-review-and-fix-input),
// read from GitHub now: only called when a policy applies (policies.mjs deny()), so a repo
// without any pays no extra call. `issue`: the number of the issue the pull request closes,
// or null; `extra`: the fix runs so far (fixInput()), and the fix's round and `reason`
// (`review`, `ci`, `conflict`: conflicts.mjs); `bot`: the App's login; `external`: the login
// whose machine pushed it (pulls.mjs externalOf()).
export async function readPullInput(
  github,
  { decision, repo, pr, issue, review = null, bot = null, external = null, now },
  extra,
) {
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
  return {
    ...pullInput({ decision, info, pr, files, issue: found, review, bot, external, now }),
    ...extra,
  };
}
