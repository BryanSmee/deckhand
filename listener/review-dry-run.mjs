// A policy dry run on a pull request (`/mode policy`, reviews.mjs dryRun()): the reply listing
// each decision (dryRunText()), and the inputs it evaluates (githubSamples(), pushSample(),
// runSamples()).
import { prId } from "./events.mjs";
import { pushInput } from "./git-gateway.mjs";
import { readOf, runInput } from "./run-policy.mjs";
import { quote, short } from "./review-texts.mjs";

// A policy file's source (policies.mjs describe()), as the dry run names it, and whose file
// it replaces.
const SOURCES = { deckhand: "Deckhand's default", operator: "operator", repo: "repo" };
const OWNERS = { deckhand: "Deckhand's", operator: "the operator's" };

// The reply to `/mode policy` (reviews' dryRun()): which files apply, each decision's result
// and what each layer said, and the input in a collapsed block. Messages are quoted as code, as
// policyWhy()'s. `files`: none, no policy applies here.
// `results[]`: { decision, messages, layers, sample, input, nobody }: `layers`, policies.mjs
// evaluated()'s; `sample` names the sample write a `github` result is about (or the branch a
// `link_branch` one is), `input` its input, shown apart from the merge's (`input`); `nobody`,
// why `request_review` would request nobody whatever the policies say.
export function dryRunText({ number, sha = null, files, errors = [], results = [], input = null }) {
  const head = `**Policy dry run** on #${number}${sha ? ` at ${short(sha)}` : ""}: nothing was reviewed, fixed or merged.`;
  if (!files.length) {
    return `${head}\n\nNo policy applies here: neither \`.deckhand/policy/\` on the default branch, the operator's policies nor Deckhand's defaults have a file.`;
  }
  const source = (f) =>
    `${SOURCES[f.source]}${f.replaces ? `, replaces ${OWNERS[f.replaces]}` : ""}`;
  const parts = [
    head,
    `Policies: ${files.map((f) => `\`${f.name}\` (${source(f)})`).join(", ")}.`,
    "A decision is allowed when an `allow_*` rule of the operator's matches (and, for the repository's own modes, one of the repository's), and no `deny_*` rule does.",
  ];
  if (errors.length) {
    parts.push(`The config check has errors:\n\n${errors.map((e) => `- ${quote(e)}`).join("\n")}`);
  }
  const result = ({ decision, messages, layers = [], sample, nobody }) => {
    const name = `\`${decision}\`${sample ? ` (sample: ${sample})` : ""}`;
    const said = messages.length
      ? `- ${name}: **refused**: ${messages.map(quote).join(", ")}`
      : // request_review where the listener wouldn't ask (reviews' dryRun()).
        `- ${name}: allowed${nobody ? `, but nobody would be requested: ${nobody}` : ""}`;
    return [said, ...layers.map((l) => layerLine(decision, l))].join("\n");
  };
  parts.push(results.map(result).join("\n"));
  const samples = results.filter((r) => r.sample);
  if (samples.length) {
    parts.push(
      "The sample lines (`run`'s comments, `github`'s writes and read, `link_branch`'s branch, `push`'s branch) are not decisions on this pull request: they aren't counted as denials.",
    );
  }
  parts.push(
    details(
      "The input (`merge`'s: review and fix get the same without `checks`, fix with its `round` and `rounds`, request_review its own: `reviewers`, `when` and the mode of the run that opened it; no review here)",
      input,
    ),
  );
  if (samples.length) {
    const inputs = samples.map((r) => ({ sample: r.sample, input: r.input }));
    parts.push(details("The samples' inputs", inputs));
  }
  return parts.join("\n\n");
}

// What a layer said of `decision` (policies.mjs evaluated()), as a line under its result: its
// allow and deny rules, and the files that define each.
function layerLine(decision, l) {
  const name = l.layer === "repo" ? "repository" : "operator";
  if (l.error) return `  - ${name}: ${quote(l.error)}`;
  const from = (list) =>
    list.length ? ` (${list.map((f) => `\`${f}\``).join(", ")})` : " (no file defines it)";
  const allow =
    l.allow === null
      ? `\`allow_${decision}\` not asked (not one of its modes)`
      : `\`allow_${decision}\` ${l.allow ? "allows" : "allows nothing"}${from(l.allowFiles)}`;
  const deny = `\`deny_${decision}\` ${l.denies.length ? `denies (${l.denies.length})` : "denies nothing"}${from(l.denyFiles)}`;
  return `  - ${name}: ${allow}; ${deny}`;
}

// `value` as JSON in a collapsed block under `summary`, cut at DRY_RUN_INPUT, fenced longer
// than any backticks it holds.
function details(summary, value) {
  let json = JSON.stringify(value, null, 2);
  if (json.length > DRY_RUN_INPUT) json = `${json.slice(0, DRY_RUN_INPUT)}\n… (cut)`;
  const longest = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `<details><summary>${summary}</summary>\n\n${fence}json\n${json}\n${fence}\n\n</details>`;
}

// What a dry run asks `deny_github` about, on pull request `pr` (GitHub's): a comment by a work
// run whose pull request it is, by a brainstorm on another issue, and by a run in the repo's
// first own mode (`modes`: its settings' `modes:`), if it has one; then the work run reading
// CI's checks (`read_checks`, no target), which a rule written for writes may refuse unawares.
// → [{ what, input }] (docs/repo-config/policy-inputs.md#the-github-input).
export function githubSamples(repo, pr, modes = {}) {
  const target = (kind) => ({
    kind,
    number: pr.number,
    labels: (pr.labels ?? []).map((l) => l.name),
    author: pr.user?.login ?? null,
  });
  const change = { fields: ["body"], labels_added: [], labels_removed: [] };
  const sample = (what, mode, kind, issue, { custom_mode = false } = {}) => ({
    what,
    input: {
      repo: repo.toLowerCase(),
      mode,
      custom_mode,
      reason: null,
      issue,
      action: "comment",
      actions: ["comment"],
      target: target(kind),
      change,
    },
  });
  const samples = [
    sample("a work run's comment on its pull request", "work", "own_pr", pr.number),
    sample("a brainstorm's comment on it", "brainstorm", "pr", null),
  ];
  // The repo's first mode: what its own policies allow it, beside Deckhand's.
  const [own] = Object.keys(modes ?? {});
  if (own) {
    const what = `a comment on it in the repository's mode ${own}`;
    samples.push(sample(what, own, "own_pr", pr.number, { custom_mode: true }));
  }
  const { target: _, change: __, ...work } = samples[0].input;
  samples.push({
    what: "a work run's read of CI's checks",
    input: { ...work, action: "read_checks", actions: ["read_checks"] },
  });
  return samples;
}

// The branch a dry run asks `deny_link_branch` about: the pull request's head, as the work run
// on `issue` (GitHub's, the one it closes, else the pull request itself) would have had it
// linked, at its base's head (docs/repo-config/policy-inputs.md#the-linked-branch-input). → { what, input }
export function linkSample(repo, pr, issue = null) {
  const number = issue?.number ?? pr.number;
  return {
    what: `a work run's branch linked to #${number}`,
    input: {
      repo: repo.toLowerCase(),
      mode: "work",
      custom_mode: false,
      reason: null,
      issue: number,
      labels: (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
      branch: pr.head?.ref ?? null,
      base: pr.base?.ref ?? null,
      oid: pr.base?.sha ?? null,
    },
  };
}

// The push a dry run asks `deny_push` about: the pull request's head, as the work run on `issue`
// (GitHub's, the one it closes, else the pull request itself) would push it, the repo's default
// branch being `base` (docs/repo-config/policy-inputs.md#the-push-input: git-gateway.mjs pushInput()).
// → { what, input }
export function pushSample(repo, pr, issue = null, base = null) {
  const branch = pr.head?.ref ?? null;
  // An update of a branch that is there (neither created nor deleted): any oid but zeros.
  const at = pr.head?.sha || "1".repeat(40);
  const run = { repo: repo.toLowerCase(), mode: "work", push: true, reason: null };
  const input = pushInput(
    { ...run, issue: issue?.number ?? pr.number },
    { ref: branch === null ? "" : `refs/heads/${branch}`, old: at, new: at },
    base,
  );
  return {
    what: `a work run's push to ${branch ?? "its branch"}`,
    input: { ...input, ref: branch === null ? null : input.ref },
  };
}

// What a dry run asks `deny_run` about, on pull request `pr` (GitHub's), whose task is `issue`'s
// (the one it closes, GitHub's) or its own: a trigger comment on it, from `sender` (who asked
// for the dry run), starting a work run, and one asking for a brainstorm there, which Deckhand's
// policy/run.rego refuses. Each input as run-policy.mjs runInput() builds the real decision's,
// from the comment's item (`settings`: the repo's, for its modes' traits). → [{ what, input }]
export function runSamples(repo, pr, issue = null, sender = null, now = Date.now, settings = null) {
  const sample = (what, mode) => {
    const item = {
      repo,
      ...(issue
        ? { id: String(issue.number), kind: "issue", number: issue.number }
        : { id: prId(pr.number), kind: "pr", number: pr.number }),
      replyTo: pr.number,
      trigger: "work",
      modeLine: mode === "work" ? null : mode,
      author: sender,
      settings,
    };
    return { what, input: runInput(item, mode, readOf(pr, "pr"), now) };
  };
  return [
    sample("a trigger comment on it starting a work run", "work"),
    sample("`/mode brainstorm` on it", "brainstorm"),
  ];
}

// How much of the input a dry run's reply shows: GitHub takes 65536 characters a comment.
const DRY_RUN_INPUT = 50_000;
