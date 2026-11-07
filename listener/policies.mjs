// Rules as code (issues #292, #494, #488): Rego policies that allow and refuse what the listener asks
// them, after its built-in gates, evaluated by the policy service (#501,
// ../policy-service/service.mjs): the listener starts no `opa`. Each decision has two rules of
// package `deckhand`: `allow_<decision>`, true when it allows, and `deny_<decision>`, a set of
// strings, the reasons shown to the maintainer (or the run, for `deny_github`). Decisions: `run`
// for a run a person starts (run-policy.mjs), `merge`, `review`, `fix`, `link_branch` for the branch the listener links to a work run's issue
// (linked-branch.mjs), `request_review` for the reviewers it requests (reviewers.mjs), `github`
// for a run's GitHub writes and some of its reads (github-writes.mjs), `push` for each branch
// a run pushes (git-gateway.mjs), and `grant` for each of a repository's yes-or-no grants
// (grants.mjs GRANTS: grants() below, the operator's alone). A decision is allowed when an allow rule
// matches and no deny rule does: a deny always wins. What a run gets as it starts has rules of
// its own, sets of names (capabilityRules(), capabilities.mjs), which the service evaluates for
// every mode at once and says the file that decided each of; and so has who may do what on a
// repository or server-wide (`access`, #730: access() below, the operator's allow alone).
//
// Two layers, each in a namespace of its own so that neither's files can define or break the
// other's rules: the operator's, Deckhand's own defaults under GRANTS_DIR/policy/*.rego, which
// the policy service reads itself (its image, a read-only mount) and gives the listener to show
// and attribute; then a repo's, .deckhand/policy/*.rego on its default branch, like its
// .deckhand.yaml, which the listener reads from GitHub and sends with each decision (the service
// has no network). The operator's allow rules are the ceiling. The repo's deny rules apply to
// every run; its allow rules count only for its own modes (`custom_mode`), which need the
// operator's allow and its own.
//
// What a decision means stays here: its input, which layers are asked, what a refusal says (cut,
// redacted with the operator's secrets, which the service never holds). Fail closed: a policy
// that doesn't compile, times out or gives a rule anything but its type refuses, with that
// reason, and so do a decision no allow rule matches and a policy service that can't be reached.
// Format: ../docs/repo-config/policies.md#policies; trust: ../docs/security/policies.md#policies.
import { createHash } from "node:crypto";
import { getJson, rateLimited } from "./github.mjs";
import {
  ACCESS_RULES,
  CAPABILITY_RULES,
  FILE,
  layerDigest,
  MAX_CAPABILITY_INPUTS,
  operatorPolicies,
  rulesOf,
  SET_FAMILIES,
} from "../lib/policy-files.mjs";
import { keepLast } from "../lib/capped.mjs";
import { redact } from "../lib/redact.mjs";
import { BUILT_IN } from "./modes.mjs";
import { validRepo } from "./repo-config.mjs";
import { ANY_REPO, GRANTS, ownerProbe, REPO_ONLY } from "./grants.mjs";

// Where a repo's policies are, on its default branch.
export const POLICY_DIR = ".deckhand/policy";

// The decisions the listener asks the policies about, each with its two rules.
export const DECISIONS = [
  "run",
  "merge",
  "review",
  "fix",
  "link_branch",
  "request_review",
  "github",
  "push",
  "grant",
];

// The rules the listener evaluates: another `allow_*` or `deny_*` rule is a mistake the config
// check says.
export const RULES = [
  ...DECISIONS.flatMap((d) => [`allow_${d}`, `deny_${d}`]),
  ...CAPABILITY_RULES,
  ...ACCESS_RULES,
];

// The inputs one call of the policy service's capabilities takes (lib/policy-files.mjs, its
// engine's MAX_INPUTS too): more go in several (a repository's modes, for its config page).
export const CAPABILITY_INPUTS_MAX = MAX_CAPABILITY_INPUTS;

// Where they are now (lib/policy-files.mjs, which the policy service shares): the listener's
// modules and tests import them from here.
export { ACCESS_RULES, CAPABILITY_RULES, rulesOf };

// The decisions only about built-in modes' runs (a review, its fix run, the merge): a repo's
// allow rule for them would count for no run, and is a config check error.
export const BUILT_IN_ONLY = new Set(["merge", "review", "fix"]);

// The decisions only the operator's layer makes (#498): a repo's rules for them, allow or deny,
// are a config check error, and not asked. What a repository gets beyond any run is the
// operator's to say; it narrows what its runs do with its other rules.
export const OPERATOR_ONLY = new Set(["grant"]);

// The decisions only the operator's layer allows: a repo's allow rule for them is a config check
// error, evaluated (one of the wrong shape fails closed) but not counted; its deny rules
// narrow. Who may do what on a repository is the operator's to say (#730), and a repository's
// maintainers may only take some of it away.
export const OPERATOR_ALLOWS = new Set(["access"]);

// The actions access() gives (#730): on a repository, and server-wide (asked with no repository).
// A rule may give a prefix ending in `*` (`runs:start:*`, `server:*`, `*`: all of them), and a
// deny may name one too. `runs:start:<mode>`: any mode, a repository's own too.
export const REPO_ACTIONS = [
  "tasks:read",
  "logs:read",
  "runs:start:*",
  "runs:manage",
  "repo:config:read",
];
export const SERVER_ACTIONS = ["server:read", "server:sync"];
// The server-wide actions' prefix: they count only asked with no repository, the others only on
// one, whatever a rule's prefix gives.
const SERVER = "server:";

// Whether `pattern` (an action, or a prefix ending in `*`) covers `action`. A pattern's `*`
// covers a pattern's (`runs:*` covers `runs:start:*`): what it gives, it gives all of.
export function actionMatches(pattern, action) {
  if (typeof pattern !== "string" || typeof action !== "string") return false;
  if (!pattern.endsWith("*")) return pattern === action;
  return action.startsWith(pattern.slice(0, -1));
}

// Whether access()'s `answer` gives `action` (on a repository when `repo`, else server-wide):
// an allowed pattern covers it, and no deny does. A deny always wins; an error gives nothing.
// A deny that covers the action asked refuses it (`*` refuses everything, server-wide too). A
// pattern asked (`runs:start:*`) is all of what it covers: a deny of any of it, in its scope
// (`runs:start:work`), refuses it; one of the other scope's actions (`server:sync` on a
// repository) doesn't.
export function allows(answer, action, repo = true) {
  if (!answer || answer.error || typeof action !== "string") return false;
  // `*` asked is all of its scope's: server-wide, every server action.
  if (action === "*" && !repo) action = `${SERVER}*`;
  if (action.startsWith(SERVER) === !!repo) return false;
  const inScope = (a) => typeof a === "string" && a.startsWith(SERVER) !== !!repo;
  return (
    answer.actions.some((p) => actionMatches(p, action)) &&
    !answer.denied.some(
      (d) =>
        actionMatches(d.action, action) || (inScope(d.action) && actionMatches(action, d.action)),
    )
  );
}

// Whether `action` (a rule's action, or a prefix ending in `*`) is one Deckhand has: it is, or
// covers, or is covered by one of REPO_ACTIONS or SERVER_ACTIONS (`runs:start:work`, `runs:*`,
// `*`). A misspelled one (`run:start:work`) gives nothing, and a deny of it takes nothing away.
export function knownAction(action) {
  if (typeof action !== "string") return false;
  return [...REPO_ACTIONS, ...SERVER_ACTIONS].some(
    (a) => actionMatches(a, action) || actionMatches(action, a),
  );
}

// Whether a `runs:start:` action (or a prefix of one ending in `*`) names a mode `modes` (a
// repository's own, by name) or Deckhand's have: `runs:start:wrok` is known (runs:start:*
// covers it) but starts nothing, and a deny of it takes nothing away (#837). Any other action,
// and every one without `modes`, is true: knownAction() says those.
export function knownMode(action, modes) {
  const START = "runs:start:";
  if (!modes || typeof action !== "string" || !action.startsWith(START)) return true;
  if (action === `${START}*`) return true;
  return [...BUILT_IN, ...modes].some((mode) => actionMatches(action, `${START}${mode}`));
}

// How many of ALLOWED_USERS' logins the access rules' check asks about at most (each costs three
// inputs: server-wide, a repository private and public).
export const MAX_CHECKED_LOGINS = 100;

// What the config checks say of an action no rule should name (knownAction()).
const unknownAction = (rule, action, layer) =>
  `\`${rule}\` of the ${layer === "repo" ? "repository's" : "operator's"} policies names \`${action}\`, which isn't an action Deckhand knows (${[...REPO_ACTIONS, ...SERVER_ACTIONS].map((a) => `\`${a}\``).join(", ")}, or a prefix of them ending in \`*\`): it ${rule.startsWith("deny_") ? "takes nothing away" : "gives nothing"}`;

// What the config checks say of a `runs:start:` action no mode of the repository has
// (knownMode()).
const unknownMode = (action, modes) =>
  `\`deny_access\` of the repository's policies names \`${action}\`, which starts no mode it has (${[...BUILT_IN, ...modes].map((m) => `\`${m}\``).join(", ")}): it takes nothing away`;

// What Deckhand's access-roles.rego gives the config checks' own input (`check: "roles"`) for each
// binding whose role it doesn't define (#836), the role after it: never an action.
const UNKNOWN_ROLE = "deckhand:unknown-role:";

// What the config checks say of such a role.
const unknownRole = (role) =>
  `\`bindings\` of the operator's policies give the role \`${role}\`, which \`access_roles\` doesn't define: its bindings give nothing but their own \`actions\``;

// Deckhand's policy/access.rego's one rule: every action, for every login (access()'s shortcut),
// or an operator's copy of it that kept it (bindingsCancelled()). With a condition (the
// operator's own logins, say), it doesn't match: that `*` is the operator's choice.
const EVERY_ACTION =
  /^allow_access\s+contains\s+"\*"\s*(?:if\s+true|if\s*\{\s*true\s*\})?\s*(?:#.*)?$/m;

// access()'s answer, read-only: kept and given to every caller for ACCESS_MS.
const frozen = ({ actions, denied, files, error }) =>
  Object.freeze({
    actions: Object.freeze([...actions]),
    denied: Object.freeze(denied.map((d) => Object.freeze({ ...d }))),
    files: Object.freeze(
      Object.fromEntries(Object.entries(files).map(([a, f]) => [a, Object.freeze([...f])])),
    ),
    error,
  });

// How long access()'s answers are kept for the same layers, login and repository (as grants()'s:
// GRANTS_MS bounds a rule reading the time), and for how many at most.
export const ACCESS_MS = 60_000;
export const MAX_ACCESS = 5000;
// How many names forget() is given while one GitHub read is in flight are kept for it (#892):
// past them, the read's answer isn't kept at all (fail closed), so a burst of deliveries can't
// grow it.
export const MAX_LATER = 100;

// `deny_merge`, `allow_merge` or `merge` → "merge".
export const decisionOf = (rule) => rule.replace(/^(?:allow|deny)_/, "");

// Deckhand's default for the reviews that start by themselves, which skips other bots' pull
// requests: replacing it without a word about them gets a warning (botsReviewed()).
const BOT_REVIEWS = "review.rego";

// Deckhand's default access, which gives every login every action: an operator's `bindings`
// narrow nothing while it is in effect (bindingsCancelled()).
const ACCESS = "access.rego";

// A `bindings` defined at the start of a line, out of a comment (what access-roles.rego reads).
const BINDINGS = /^bindings\b\s*(?::=|=|\[|contains\b|if\b|\{)/m;

// What the input looks like (docs/repo-config/policy-inputs.md#the-merge-input): a policy can check it.
export const INPUT_VERSION = 1;

// What every decision's input has about a pull request (docs/repo-config/policy-inputs.md#the-merge-input),
// reviews.mjs's and reviewers.mjs's: the repo (`info`, GET /repos/{repo}), the pull request
// and its `files`, its linked `issue`, and the `review` when there is one. `bot`: the App's
// login (config.bot), for `pr.deckhand`; `external`: the login whose machine pushed it
// (pulls.mjs externalOf(), #598), for `pr.external`.
export function pullInput({
  decision,
  info,
  pr,
  files,
  issue,
  review = null,
  bot = null,
  external = null,
  now = Date.now,
}) {
  const names = (labels) => (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
  return {
    decision,
    time: new Date(now()).toISOString(),
    repo: {
      name: info.full_name ?? null,
      private: info.private === true,
      default_branch: info.default_branch ?? null,
    },
    pr: {
      number: pr.number,
      author: pr.user?.login ?? null,
      // GitHub's account type ("User", "Bot"): policy/review.rego skips other bots' pull
      // requests, Deckhand's own (`deckhand`) excepted.
      author_type: pr.user?.type ?? null,
      deckhand: !!bot && pr.user?.login?.toLowerCase() === bot.toLowerCase(),
      // Opened by the App from the branch a user's machine pushed (#598): its commits never went
      // through the git gateway's checks. policy/machines.rego refuses to auto-merge it.
      external: external ?? null,
      title: pr.title ?? "",
      labels: names(pr.labels),
      base: pr.base?.ref ?? null,
      head: pr.head?.ref ?? null,
      head_sha: pr.head?.sha ?? null,
      draft: !!pr.draft,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changed_files: pr.changed_files ?? files.length,
      files: files.map((f) => ({
        path: f.filename,
        previous_path: f.previous_filename ?? null,
        status: f.status ?? null,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      })),
    },
    issue: issue
      ? { number: issue.number ?? null, title: issue.title ?? "", labels: names(issue.labels) }
      : null,
    review: review
      ? {
          verdict: review.verdict,
          rating: review.rating,
          allowed: review.allowed ?? "low",
          findings: review.findings.map(({ severity, path, line, text }) => ({
            severity,
            path,
            line,
            text,
          })),
        }
      : null,
  };
}

// A built-in gate that passed, as a decision lists it (decisions.mjs).
export const passed = (name) => ({ name, passed: true });

// `rule` asked of `policies` (createPolicies()) about pull request `pr` ({ number }: an
// issue's, for deny_link_branch) → { messages, unread }, as decide()'s. When a policy applied, the
// decision is kept for the task's page: `keep(entry)` (decisions.mjs record()) with the
// built-in `gates` that passed before ([{ name, passed }]), what each layer said and the input
// the rules saw;
// without `keepUnread`, not when GitHub couldn't be read: a caller that asks again at its next
// check (conflicts.mjs) shows no refusal that holds nothing.
// reviews.mjs, conflicts.mjs and linked-branch.mjs share it, so their entries stay alike.
export async function denyKept(
  policies,
  rule,
  repo,
  ref,
  input,
  { pr, gates = [], keep, log, keepUnread = true },
) {
  const {
    applied,
    messages,
    input: saw,
    unread,
    layers,
  } = await policies.decide(rule, repo, ref, input);
  if (applied && (keepUnread || !unread)) {
    const entry = {
      decision: decisionOf(rule),
      rule,
      denied: messages.length > 0,
      messages,
      pr: pr.number,
      gates,
      ...(layers?.length && { layers }),
      ...(saw && { input: saw }),
    };
    try {
      keep(entry);
    } catch (error) {
      log(`${repo}#${pr.number}: keeping its ${rule} decision: ${error.message ?? error}`);
    }
  }
  return { messages, unread: !!unread };
}

// A failure's message (failure() below: GitHub couldn't give the input, a policy that didn't
// compile or timed out), not a rule's: asked again later rather than held.
export const isPolicyError = (message) => /^policy error/i.test(message);

// What a refusal quotes of a policy: its first messages, each cut.
export const MAX_MESSAGES = 5;
export const MAX_MESSAGE_LENGTH = 200;

// How long Deckhand's policies, as the policy service gave them, are taken for its own without
// asking again: a decision only Deckhand's files allow is skipped on them (merge, fix), with no
// call that would see a service of another version, so they are asked again after this.
export const DEFAULTS_MS = 30_000;

// A run's writes or pushes allowed whatever the input (`allow_github := true`, as an operator's
// allow.rego had before the modes' ceilings became allow rules): every mode would write all
// that the built-in checks don't refuse, an inbox entry's or a review's included. The config
// check warns of it.
const UNCONDITIONAL =
  /^allow_(github|push)\s*(?:(?::=|=)\s*true|if\s+true|if\s*\{\s*true\s*\})?\s*(?:#.*)?$/gm;

// `input.light`, out of a comment: what a policy written before #498 reads of a run.
const GONE_INPUT = /^[^#\n]*\binput\.light\b/m;

// The line of `text` (1-based) where `rule` is first defined, null when none starts one.
function lineOf(text, rule) {
  const at = text.split("\n").findIndex((l) => new RegExp(`^${rule}\\b`).test(l));
  return at < 0 ? null : at + 1;
}

// Why a layer allows nothing: no allow rule of its matched the input `doc`, said from what it
// is about (`layer`: "operator" or "repo", whose rules are named).
export function unallowed(decision, doc, layer) {
  const rules = layer === "repo" ? `rule of ${POLICY_DIR}/` : "rule";
  const run = (mode) => (mode ? `a \`${mode}\` run` : "a run Deckhand no longer knows");
  switch (decision) {
    case "github": {
      const on = doc.target?.kind ? ` on \`${doc.target.kind}\`` : "";
      return `no ${rules} allows \`${doc.action}\`${on} for ${run(doc.mode)}`;
    }
    case "run": {
      const on = { issue: "an issue", pr: "a pull request", discussion: "a discussion" };
      const where = on[doc.target?.kind] ? ` on ${on[doc.target.kind]}` : "";
      return `no ${rules} allows ${run(doc.mode)}${where}`;
    }
    case "link_branch":
      return `no ${rules} allows linking a branch for ${run(doc.mode)}`;
    case "push": {
      const to = doc.branch ? ` to \`${doc.branch}\`` : "";
      return `no ${rules} allows ${run(doc.mode)}'s push${to}`;
    }
    case "request_review":
      return `no ${rules} allows requesting reviewers for ${run(doc.mode)}'s pull request`;
    case "fix":
      return `no ${rules} allows a fix run${doc.reason ? ` (\`${doc.reason}\`)` : ""}`;
    case "grant":
      return `no ${rules} grants \`${doc.grant}\` to ${doc.repo?.name ?? "the repository"}`;
    default:
      return `no ${rules} allows the ${decision}`;
  }
}

// How long a repository's grants (grants()) are kept for the same operator policies, and for how
// many repositories at most.
export const GRANTS_MS = 60_000;
export const MAX_GRANTS = 1000;

// How much of a policy file's text the dashboard gets: its source view, not a download.
export const MAX_TEXT = 20 * 1024;

// How long a repo's listing of POLICY_DIR is kept: a push to its default branch forgets it
// sooner (forget()), so this only bounds a push whose webhook never came.
const LISTING_MS = 10 * 60_000;
// How old a listing listing()'s `stale` may still give when GitHub can't list again: past it,
// fail closed as every other decision does.
export const STALE_LISTING_MS = 6 * LISTING_MS;

// Deckhand's policy/run.rego as shipped with this listener: its sha256. The listener no longer has
// Deckhand's files (the policy service does), and run-policy.mjs defaultRun() says what this one
// would without opa, so the service's run.rego must be this one for that (deckhandOnly());
// test/run-policy.test.mjs checks it is policy/run.rego's.
export const SHIPPED_RUN_SHA256 =
  "eab827793e7cea52752045d0c2cc8c09e9ca512d1c5c16d5f22065bea2a41a3c";
// Its name.
const RUN = "run.rego";

// `github`: the App's calls; `service`: the policy service (policy-client.mjs policyClient(), or
// its engine in the tests: ../policy-service/engine.mjs createEngine()); `secrets()`: what
// redaction hides of the messages (secrets.mjs); `now`: the clock, for listings.
export function createPolicies({
  config,
  github,
  service,
  secrets = () => [],
  log = () => {},
  now = Date.now,
  readOperator = config?.grantsDir ? () => operatorPolicies(config.grantsDir) : null,
}) {
  // A file's text by its blob sha: the same policy is fetched once.
  const blobs = new Map();
  const MAX_BLOBS = 500;
  // "org/repo" (lower case) → its default branch → { at, listed }: its POLICY_DIR there, as last
  // listed (null: none), so a repo without policies costs no call per decision. By branch: a
  // default branch just moved is asked on both for a while (the dashboard's filters on the
  // repos as last listed, #783), and neither should drop the other's. MAX_ACCESS repos at most,
  // the one listed longest ago dropped first: a repo never asked again would stay for good.
  const listings = new Map();
  // The reads of GitHub in flight (listing(), repoOf()), by the repo's name in lower case → a Set
  // of { forgotten }: forget() marks them, so that an answer read before it is neither kept after
  // it nor replaced by what was kept before it (#875). Each read removes itself when done (a
  // `finally`), so it holds the reads in flight alone: no MAX_ACCESS bound needed. `later`: the
  // names forget() was given while it was in flight, whatever their repo: a renamed repository's
  // first read only learns its current name from GitHub's answer, after a forget() of that name
  // could have marked it (#892). Past MAX_LATER of them, it is marked forgotten instead.
  const reading = new Map();
  function started(key) {
    const read = { forgotten: false, later: new Set() };
    reading.set(key, (reading.get(key) ?? new Set()).add(read));
    return read;
  }
  function done(key, read) {
    const reads = reading.get(key);
    reads?.delete(read);
    if (reads?.size === 0) reading.delete(key);
  }
  // Deckhand's own policies as the service last gave them (name → text): what
  // onlyBuiltInAllowing() knows them by, and the defaults of each decision's operator layer.
  // Asked again when the service says its layer isn't the one expected (another version), and
  // when DEFAULTS_MS has passed since (`knownAt`).
  let knownOwn = null;
  let knownAt = -Infinity;
  const fresh = () => knownOwn && now() - knownAt < DEFAULTS_MS;

  // The operator's layer as the policy service reads it now → { deckhand, operator, errors }:
  // Deckhand's files and the operator's, each name → text (null when it can't be read, `errors`
  // saying why). A service that can't be reached throws. The operator's are the listener's own
  // (`readOperator()`, GRANTS_DIR/policy/), when it reads them: the service's being others (a
  // grants folder it doesn't see the same, or not at all) refuses them, so that its evaluating
  // without the operator's rules can't go unseen.
  async function served() {
    const said = await service.policies();
    const map = (entries) => (Array.isArray(entries) ? new Map(entries) : null);
    const layers = {
      deckhand: map(said?.deckhand),
      operator: map(said?.operator),
      errors: {
        deckhand: said?.errors?.deckhand ?? null,
        operator: said?.errors?.operator ?? null,
      },
    };
    if (!layers.deckhand && !layers.errors.deckhand) layers.errors.deckhand = "not sent";
    if (!layers.operator && !layers.errors.operator) layers.errors.operator = "not sent";
    if (layers.deckhand) knownOwn = layers.deckhand;
    if (readOperator && layers.operator) {
      let mine = null;
      try {
        mine = readOperator();
      } catch (error) {
        layers.errors.operator = error.message ?? String(error);
      }
      if (mine && layerDigest(mine) !== layerDigest(layers.operator)) {
        layers.errors.operator = `the policy service reads other operator policies (${names(layers.operator)}) than the listener (${names(mine)}): give both the same grants folder, the listener's ${config.grantsDir}`;
      }
      layers.operator = layers.errors.operator ? null : mine;
    }
    // Fresh only when the service's operator layer is the listener's, and nothing failed: a
    // mismatch, or files that can't be read, has the next decision ask again (and be refused
    // again), never skipped or built from the cache meanwhile.
    knownAt =
      layers.deckhand && !layers.errors.deckhand && !layers.errors.operator ? now() : -Infinity;
    return layers;
  }

  // A layer's file names, for a message.
  const names = (files) => [...files.keys()].join(", ") || "none";

  // The defaults under the operator's: name → text. Either can't be read: throws. Once
  // Deckhand's are known (DEFAULTS_MS), the listener reads the operator's alone (no call): the
  // service checks the decision's digest of them against its own (evaluateLayers()).
  async function defaults() {
    if (fresh() && readOperator) return new Map([...knownOwn, ...readOperator()]);
    const { deckhand, operator, errors } = await served();
    const error = errors.deckhand ?? errors.operator;
    if (error) throw new Error(error);
    return new Map([...deckhand, ...operator]);
  }

  // `stale`: when GitHub can't list it for a hiccup (transient()), the last listing of `ref` up to
  // STALE_LISTING_MS old (a push forgot it: forget()), rather than a failure; run-policy.mjs's
  // and access()'s, so that a GitHub hiccup doesn't refuse the comments of a repo that had no
  // policy. Any other failure (a 403: the App's access gone; the github service's own refusal)
  // fails closed, and forgets the repo's listings, as repoOf() does (#856).
  async function listing(repo, ref, cached, stale = false) {
    const key = repo.toLowerCase();
    const kept = listings.get(key)?.get(ref);
    if (cached && kept && now() - kept.at < LISTING_MS) return kept.listed;
    const path = `/repos/${repo}/contents/${POLICY_DIR}?ref=${encodeURIComponent(ref)}`;
    let res;
    let listed = null;
    const read = started(key);
    try {
      try {
        res = await github(repo, "GET", path, undefined, [404]);
        if (res.ok) listed = await res.json();
      } catch (error) {
        res = { error };
      }
      if (!res.ok && res.status !== 404) {
        const why = res.error
          ? String(res.error?.message ?? res.error)
          : `GitHub GET ${path}: ${res.status}${await said(res)}`;
        const hiccup = await transient(res);
        await res.body?.cancel().catch(() => {});
        if (!hiccup) listings.delete(key);
        if (!stale || !hiccup || !kept || read.forgotten || now() - kept.at > STALE_LISTING_MS) {
          throw res.error ?? new Error(why);
        }
        log(`${repo}: listing its policies: ${why}; the last listing kept`);
        return kept.listed;
      }
      // Forgotten meanwhile (a push, a privatization): this answer may be older than what forget()
      // dropped, so it is given to this caller alone, and the next one lists again.
      if (cached && !read.forgotten) {
        const refs = listings.get(key) ?? new Map();
        // The branches too old even for `stale` go first, so a repo keeps a few at most.
        for (const [r, entry] of refs) if (now() - entry.at > STALE_LISTING_MS) refs.delete(r);
        // Moved last, so that the oldest listing is first to go.
        keepLast(listings, key, refs.set(ref, { at: now(), listed }), MAX_ACCESS);
      }
      return listed;
    } finally {
      done(key, read);
    }
  }

  // A repo's policy files on `ref`, [{ name, url, text }]: its listing (`cached`: the default
  // branch's, kept until it moves), then the files not seen yet.
  async function repoFiles(repo, ref, cached, stale = false) {
    const files = [];
    const listed = await listing(repo, ref, cached, stale);
    if (!Array.isArray(listed)) return files;
    for (const entry of listed) {
      if (entry.type !== "file" || !FILE.test(entry.name)) continue;
      if (!blobs.has(entry.sha)) {
        const blob = await getJson(github, repo, `/repos/${repo}/git/blobs/${entry.sha}`);
        const text = Buffer.from(blob.content ?? "", blob.encoding ?? "base64").toString();
        keepLast(blobs, entry.sha, text, MAX_BLOBS);
      }
      files.push({ name: entry.name, url: entry.html_url ?? null, text: blobs.get(entry.sha) });
    }
    return files;
  }

  // A repo's policies on `ref`, name → text.
  async function repoPolicies(repo, ref, { cached = false, stale = false } = {}) {
    return new Map((await repoFiles(repo, ref, cached, stale)).map((f) => [f.name, f.text]));
  }

  // The layers a decision on `repo` evaluates, each name → text: `operator`, Deckhand's policies
  // and the operator's over them by file name, as the service has them; `repo`, the repo's on
  // `ref`. Empty: none.
  // `stale`: listing()'s.
  async function policiesFor(repo, ref, { stale = false } = {}) {
    return {
      operator: await defaults(),
      repo: await repoPolicies(repo, ref, { cached: true, stale }),
    };
  }

  // Whether the operator's layer `files` (name → text) is Deckhand's own policies as the policy
  // service gave them (and recently: DEFAULTS_MS), unchanged and with nothing added, its run.rego
  // the one this listener ships (SHIPPED_RUN_SHA256): then `run` needs no opa, run-policy.mjs
  // defaultRun() says what run.rego would. A service of another version's run.rego: asked.
  function deckhandOnly(files) {
    const own = fresh() ? knownOwn : null;
    if (!own || files.size !== own.size) return false;
    if ([...files].some(([name, text]) => own.get(name) !== text)) return false;
    const run = files.get(RUN);
    return (
      typeof run === "string" &&
      createHash("sha256").update(run).digest("hex") === SHIPPED_RUN_SHA256
    );
  }

  // Whether the operator's layer `files` is Deckhand's own policies only, none of them defining
  // `deny_<decision>` and one allowing it whatever the input: then it allows, and the service
  // isn't asked (no decision kept, without a repo's files). Deckhand's files are known: rulesOf()
  // reads them right.
  async function onlyBuiltInAllowing(decision, files) {
    const always = new RegExp(`^allow_${decision}\\s*:=\\s*true\\s*$`, "m");
    return !!(await builtInGiving(decision, files, always));
  }

  // The files of the operator's layer `files` whose rule `always` (a RegExp) allows `decision`
  // whatever the input, when that layer is Deckhand's own policies only, unchanged (DEFAULTS_MS),
  // none of them defining `deny_<decision>`: their names, else null.
  async function builtInGiving(decision, files, always) {
    if (!fresh()) await served().catch(() => null);
    const own = fresh() ? knownOwn : null;
    if (!own) return null;
    const all = [...files];
    if (
      all.some(
        ([name, text]) => own.get(name) !== text || rulesOf(text).includes(`deny_${decision}`),
      )
    ) {
      return null;
    }
    const giving = all.filter(([, text]) => always.test(text)).map(([name]) => name);
    return giving.length ? giving : null;
  }

  // The layers of `asking` ({ operator, repo }: name → text, either absent: not asked) on
  // `input`, by the policy service → { operator, repo, error, errorLayer }: each asked layer's
  // { allow, denies }: `allow`, whether its `allow_<decision>` is true (null when not asked: the
  // repo's, unless `repoAllow`); `denies`, its `deny_<decision>`'s strings, as the rule gave
  // them. `error`: why they couldn't be evaluated, as a failure() says it, then nothing else;
  // `errorLayer`, the layer opa placed it in, null when it didn't. The operator's files are the
  // service's own: `asking.operator` only says to ask them, and `operator` (the whole operator
  // layer the decision is attributed to) goes as its digest, which the service refuses
  // (`mismatch`) when its own layer is another.
  async function evaluateLayers(decision, asking, input, { repoAllow = false, operator } = {}) {
    let said;
    try {
      said = await service.evaluate({
        decision,
        input,
        operator: !!asking.operator,
        repo: asking.repo ? [...asking.repo] : null,
        repoAllow,
        operatorDigest: layerDigest(operator),
      });
    } catch (error) {
      return { error: error.message ?? String(error), errorLayer: null };
    }
    if (said?.error) {
      const errorLayer = ["operator", "repo"].includes(said.errorLayer) ? said.errorLayer : null;
      return { error: String(said.error), errorLayer, ...(said.mismatch && { mismatch: true }) };
    }
    // Fail closed: an answer without each asked layer's result refuses.
    for (const layer of Object.keys(asking)) {
      const got = said?.[layer];
      const allow = layer === "repo" && !repoAllow ? null : true;
      if (
        !got ||
        (allow === null ? got.allow !== null : typeof got.allow !== "boolean") ||
        !Array.isArray(got.denies) ||
        got.denies.some((m) => typeof m !== "string")
      ) {
        return { error: "the policy service's answer can't be read", errorLayer: null };
      }
    }
    return { ...said, error: null, errorLayer: null };
  }

  // At most MAX_MESSAGES, each shown().
  function messages(list) {
    const shown = list.slice(0, MAX_MESSAGES).map(line);
    if (list.length > MAX_MESSAGES) shown.push(`and ${list.length - MAX_MESSAGES} more`);
    return shown;
  }

  // A message as posted: on one line, cut, without the operator's secrets. Failures too: an
  // error of opa or GitHub may quote a policy's text or what it read.
  function line(text) {
    const one = redact(text, secrets()).replace(/\s+/g, " ").trim() || "(empty message)";
    return one.length > MAX_MESSAGE_LENGTH ? `${one.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : one;
  }

  // "policy error: …": the single refusal a failure gives.
  const failure = (what) => [line(`policy error: ${what}`)];

  // One layer's (or file's) two capabilities' rules as the service gave them (`said`: { allow,
  // deny }, each the rule's value in a list, empty when undefined) → { allow: names, deny: [{
  // capability, reason }] }, or a failure: a rule of the wrong shape refuses.
  // `family`: SET_FAMILIES's, whose deny objects name a `capability` or an `action` (`what`).
  function shapedRules(said, layer, family = "capabilities") {
    const what = SET_FAMILIES[family];
    const listed = (v) => Array.isArray(v) && v.length <= 1;
    if (!listed(said?.allow) || !listed(said?.deny)) {
      return { error: "the policy service's answer can't be read", errorLayer: null };
    }
    const [allow = []] = said.allow;
    const [deny = []] = said.deny;
    if (!Array.isArray(allow) || allow.some((n) => typeof n !== "string")) {
      return { error: `\`allow_${family}\` must be a set of strings`, errorLayer: layer };
    }
    const shaped = (d) => d && typeof d[what] === "string" && typeof d.reason === "string";
    if (!Array.isArray(deny) || !deny.every(shaped)) {
      return {
        error: `\`deny_${family}\` must be a set of {"${what}": …, "reason": …} objects`,
        errorLayer: layer,
      };
    }
    return { allow, deny: deny.map((d) => ({ [what]: d[what], reason: d.reason })) };
  }

  const denyKey = (d, what) => JSON.stringify([d[what], d.reason]);

  // The capabilities' rules (issue #495) of `layers` ({ operator, repo }: name → text, either
  // absent or empty: not asked) on each of `inputs` (key → input document, the version added), by
  // the policy service in one call → { results: key → { operator, repo }, each asked layer's {
  // allow: name → [files], deny: [{ capability, reason, file }] }, decided by the whole rules, a
  // file being one whose own rule gave it (byFile()), null when none did } or { error, errorLayer },
  // as evaluateLayers() says them. The operator's files are the service's own: they go as their
  // digest, as for a decision.
  const evaluateCapabilities = (layers, inputs) => evaluateSets("capabilities", layers, inputs);

  // evaluateCapabilities()'s work for the set rules of `family` (SET_FAMILIES), the policy
  // service's `evaluate<Family>`: each deny names its `capability`, or its `action`. Without
  // `operator`, the operator's layer isn't asked (its digest still goes: the service checks it).
  async function evaluateSets(family, layers, inputs, { operator = true } = {}) {
    const what = SET_FAMILIES[family];
    const method = family === "access" ? "evaluateAccess" : "evaluateCapabilities";
    const failed = (what, errorLayer = null) => ({ error: what, errorLayer });
    const asked = Object.keys(layers).filter(
      (layer) => layers[layer]?.size && (operator || layer !== "operator"),
    );
    const docs = Object.fromEntries(
      Object.entries(inputs).map(([k, doc]) => [k, { version: INPUT_VERSION, ...doc }]),
    );
    // In parts the service takes (its MAX_INPUTS): a repository may have many modes.
    const keys = Object.keys(docs);
    const said = { results: {} };
    for (let at = 0; at === 0 || at < keys.length; at += CAPABILITY_INPUTS_MAX) {
      const part = Object.fromEntries(
        keys.slice(at, at + CAPABILITY_INPUTS_MAX).map((k) => [k, docs[k]]),
      );
      let got;
      try {
        got = await service[method]({
          inputs: part,
          operator: asked.includes("operator"),
          repo: asked.includes("repo") ? [...layers.repo] : null,
          operatorDigest: layerDigest(layers.operator ?? new Map()),
        });
      } catch (error) {
        return failed(error.message ?? String(error));
      }
      if (got?.error) {
        const errorLayer = ["operator", "repo"].includes(got.errorLayer) ? got.errorLayer : null;
        return {
          ...failed(String(got.error), errorLayer),
          ...(got.mismatch && { mismatch: true }),
        };
      }
      if (asked.length && (!got?.results || typeof got.results !== "object")) {
        return failed("the policy service's answer can't be read");
      }
      Object.assign(said.results, got?.results ?? {});
    }
    const results = {};
    for (const key of Object.keys(inputs)) {
      results[key] = {};
      for (const layer of asked) {
        const got = said.results[key]?.[layer];
        const whole = shapedRules(got?.all, layer, family);
        if (whole.error) return whole;
        // Each name and deny of the whole rules with the files whose own rules gave it: none
        // when only a rule byFile() couldn't rename did (indented, or in a file whose package
        // line rulesOf() doesn't read), which counts all the same.
        const allowFiles = new Map();
        const denyFiles = new Map();
        for (const [file, rules] of Object.entries(got.files ?? {})) {
          const own = shapedRules(rules, layer, family);
          if (own.error) return own;
          for (const name of own.allow)
            allowFiles.set(name, [...(allowFiles.get(name) ?? []), file]);
          for (const d of own.deny) {
            const key = denyKey(d, what);
            denyFiles.set(key, [...(denyFiles.get(key) ?? []), file]);
          }
        }
        results[key][layer] = {
          allow: new Map(whole.allow.map((name) => [name, allowFiles.get(name) ?? [null]])),
          deny: whole.deny.flatMap((d) =>
            (denyFiles.get(denyKey(d, what)) ?? [null]).map((file) => ({
              [what]: d[what],
              reason: line(d.reason),
              file,
            })),
          ),
        };
      }
      // An operator's layer without files allows nothing: said as one.
      results[key].operator ??= { allow: new Map(), deny: [] };
    }
    return { results };
  }

  // The capabilities' rules of `repo`'s policies on `ref` (its default branch) on each of
  // `inputs` (key → input: a run's, or each mode's for the config page) → evaluateCapabilities()'s
  // answer, a failure being one "policy error: …" message (`error`).
  async function capabilityRules(repo, ref, inputs) {
    // As decide(): the service's operator layer not the one read here (its new version's
    // defaults, say), Deckhand's are asked again and the capabilities once more.
    for (let attempt = 0; ; attempt++) {
      let layers;
      try {
        layers = await policiesFor(repo, ref);
      } catch (error) {
        log(`${repo}: reading its policies: ${error.message ?? error}`);
        return { error: failure(`the policies can't be read (${error.message ?? error})`)[0] };
      }
      const said = await evaluateCapabilities(layers, inputs);
      if (said.mismatch && attempt === 0) {
        knownOwn = null;
        continue;
      }
      if (!said.error) return said;
      const [message] = failure(said.error);
      log(`${repo}: capabilities refused: ${message}`);
      return { error: message, errorLayer: said.errorLayer };
    }
  }

  // accessActionWarnings()'s answers, by both layers' digests, the inputs' repository and the
  // logins asked: the config panel asks on every load. ACCESS_MS, as access()'s.
  const actionsKept = new Map();

  // The actions the access rules of the layers `read()` gives ({ operator, repo }: policiesFor()'s)
  // name that Deckhand doesn't have (knownAction()), for the config checks (#765): a misspelled
  // deny takes nothing away, unseen otherwise. Only evaluating the rules says them: on each
  // allowed login (or one nobody has, with none), on `repo` (its name: private and public, both
  // layers) and server-wide (the operator's layer alone: a repository's rules count only on it,
  // access() never asks them there). A
  // repository's allow rules are ignored (compile() says so): not read. Without `operator`, its
  // rules aren't asked, only the repository's. Each name said once; the policies failing,
  // nothing (the compile check says why). The service's operator layer not the one read:
  // read again, once, as access() does. With `modes` (the repository's own, by name), its deny
  // of a `runs:start:` action no mode has is said too (knownMode()): the operator's rules may name
  // another repository's modes, not said. And the bindings' roles access-roles.rego doesn't
  // define (#836), with the operator's layer, from an input of their own (UNKNOWN_ROLE).
  async function accessActionWarnings(read, repo = null, { operator = true, modes = null } = {}) {
    const logins = [...new Set((config?.users ?? []).map((u) => String(u).toLowerCase()))].slice(
      0,
      MAX_CHECKED_LOGINS,
    );
    if (!logins.length) logins.push("deckhand-config-check");
    // Server-wide, the operator's layer alone, as access() asks it; on `repo`, both.
    const where = [
      ...(operator ? [null] : []),
      ...(repo ? [true, false].map((p) => ({ name: repo.toLowerCase(), private: p })) : []),
    ];
    const inputsAt = (server) => {
      const inputs = {};
      for (const login of logins) {
        for (const at of where.filter((w) => (w === null) === server)) {
          inputs[`${login}@${at ? `${at.name}:${at.private}` : "server"}`] = {
            decision: "access",
            user: { login },
            repo: at,
          };
        }
      }
      // And the bindings' roles, whoever they are for (access-roles.rego): server-wide, as only
      // the operator's layer names them. Its key no login has.
      if (server && operator) {
        inputs["@roles"] = {
          decision: "access",
          user: { login: logins[0] },
          repo: null,
          check: "roles",
        };
      }
      return inputs;
    };
    const groups = [
      { inputs: inputsAt(true), server: true },
      { inputs: inputsAt(false), server: false },
    ].filter((g) => Object.keys(g.inputs).length);
    if (!groups.length) return [];
    for (let attempt = 0; ; attempt++) {
      let layers;
      try {
        layers = await read();
      } catch {
        return [];
      }
      // Deckhand's every action alone: nothing to say, without a call.
      if (operator && (await everyAction({ repo: new Map(), ...layers }))) return [];
      const key = JSON.stringify([
        layerDigest(layers.operator ?? new Map()),
        layerDigest(layers.repo ?? new Map()),
        operator,
        where,
        logins,
        modes,
      ]);
      const kept = actionsKept.get(key);
      if (kept && now() - kept.at < ACCESS_MS) return [...kept.said];
      const results = [];
      let said = {};
      for (const { inputs, server } of groups) {
        const asked = server ? { ...layers, repo: new Map() } : layers;
        said = await evaluateSets("access", asked, inputs, { operator });
        if (said.error) break;
        results.push(...Object.values(said.results));
      }
      if (said.mismatch && attempt === 0) {
        knownOwn = null;
        continue;
      }
      if (said.error) return [];
      const warnings = new Set();
      for (const result of results) {
        for (const layer of ["operator", "repo"]) {
          const rules = result[layer];
          if (!rules) continue;
          if (layer === "operator") {
            for (const action of rules.allow.keys()) {
              if (action.startsWith(UNKNOWN_ROLE)) {
                warnings.add(unknownRole(action.slice(UNKNOWN_ROLE.length)));
              } else if (!knownAction(action)) {
                warnings.add(unknownAction("allow_access", action, layer));
              }
            }
          }
          for (const d of rules.deny) {
            if (!knownAction(d.action)) warnings.add(unknownAction("deny_access", d.action, layer));
            else if (layer === "repo" && !knownMode(d.action, modes)) {
              warnings.add(unknownMode(d.action, modes));
            }
          }
        }
      }
      // Moved last, as listings are, so that the answer given longest ago is first to go.
      keepLast(actionsKept, key, { at: now(), said: [...warnings] }, MAX_ACCESS);
      return [...warnings];
    }
  }

  // The actions `repo`'s policies on `ref` (its default branch) and the operator's name that
  // Deckhand doesn't have, on that repository and server-wide (accessActionWarnings()): what the
  // config panel says beside describe()'s warnings (repos.mjs policyView()). `modes`: its own, by
  // name (its settings'), for the `runs:start:` actions its rules name.
  const accessNameWarnings = (repo, ref, modes = null) =>
    accessActionWarnings(() => policiesFor(repo, ref), repo, { modes });

  // grants()'s answers, by the operator's layer (its digest) and the repository: the same files
  // give the same answer, so an edit is asked again at once. GRANTS_MS bounds a rule reading the
  // time; a failure isn't kept.
  const granted = new Map();

  // The yes-or-no grants (grants.mjs GRANTS) the operator's policies give `repo` (#498): each
  // asked of `allow_grant` and `deny_grant` with { grant, repo: { name } }, the operator's layer
  // alone (OPERATOR_ONLY) → { granted: Set of names, files, denied } or { error }: `files`, those
  // defining `allow_grant`; `denied`, why a grant an allow rule gives is refused anyway ({ grant,
  // reasons }): a deny rule, or a REPO_ONLY grant its rules give every repository (ANY_REPO) or
  // every repository of its owner (ownerProbe()). No
  // file defining `allow_grant`: nothing granted, without a call. Asked for every run, push and
  // row of the dashboard's repository list: kept (`granted`).
  async function grants(repo) {
    const name = String(repo).toLowerCase();
    for (let attempt = 0; ; attempt++) {
      let operator;
      try {
        operator = await defaults();
      } catch (error) {
        return { error: failure(`the policies can't be read (${error.message ?? error})`)[0] };
      }
      const files = [...operator]
        .filter(([, text]) => rulesOf(text).includes("allow_grant"))
        .map(([file]) => file);
      if (!files.length) return { granted: new Set(), files, denied: [] };
      const key = `${layerDigest(operator)} ${name}`;
      const kept = granted.get(key);
      if (kept && now() - kept.at < GRANTS_MS) return kept.said;
      const ask = (grant, repoName) =>
        evaluateLayers(
          "grant",
          { operator },
          { version: INPUT_VERSION, decision: "grant", grant, repo: { name: repoName } },
          { operator },
        );
      const names = Object.keys(GRANTS);
      const said = await Promise.all(names.map((grant) => ask(grant, name)));
      // Those every repository, or every one of its owner's, would get, for the grants given one
      // at a time only.
      const allowed = names.filter((_, i) => said[i].operator?.allow);
      const wide = allowed.filter((grant) => REPO_ONLY.has(grant));
      const probes = [ANY_REPO, ownerProbe(name)];
      const anyRepo = await Promise.all(
        wide.flatMap((grant) => probes.map((probe) => ask(grant, probe))),
      );
      const failed = [...said, ...anyRepo].find((r) => r.error);
      if (failed?.mismatch && attempt === 0) {
        knownOwn = null;
        continue;
      }
      if (failed) {
        const [message] = failure(failed.error);
        log(`${repo}: its grants refused: ${message}`);
        return { error: message };
      }
      const given = new Set();
      const denied = [];
      names.forEach((grant, i) => {
        const { allow, denies } = said[i].operator;
        if (!allow) return;
        const at = wide.indexOf(grant) * probes.length;
        const everyRepo = anyRepo
          .slice(at, at + probes.length)
          .some((r) => r.operator?.allow === true);
        const reasons = [
          ...messages(denies),
          ...(at >= 0 && everyRepo
            ? [
                `\`${grant}\` is granted one repository at a time: a rule that gives it to every repository, or to all of an owner's, gives it to none (name each input.repo.name)`,
              ]
            : []),
        ];
        if (reasons.length) denied.push({ grant, reasons });
        else given.add(grant);
      });
      for (const { grant, reasons } of denied) {
        log(`${repo}: the grant ${grant} refused: ${reasons.join("; ")}`);
      }
      const answer = { granted: given, files, denied };
      keepLast(granted, key, { at: now(), said: answer }, MAX_GRANTS);
      return answer;
    }
  }

  // access()'s answers, by the layers' digests, the login and the repository: the same files give
  // the same answer, so an edit of the operator's, or a push that changes the repo's (forget()),
  // is asked again at once. ACCESS_MS bounds a rule reading the time; a failure isn't kept.
  const accessKept = new Map();

  // What GitHub said of a repository access() was given by name (GET /repos/{repo}), by its name
  // in lower case → { at, info }: kept ACCESS_MS, as the answers are, and forgotten on its push
  // (forget()), so that a kept answer costs no call; a GitHub hiccup past it gives the last one
  // (repoOf()).
  const repoInfos = new Map();
  // A renamed or transferred repository's current name (lower case) → the names it was asked by
  // (repoOf()): its push's webhook says the current one, and forget() clears them too.
  const renamed = new Map();

  // A repository as access() takes it, its name or what GitHub says of it (its `full_name`,
  // `private`, `default_branch`) → { name, private, ref }. Without its default branch, read
  // (repoInfos), never guessed: another branch's listing would drop its deny rules. Not known to
  // be public: private (fail closed). GitHub can't say, and said nothing up to STALE_LISTING_MS
  // ago: throws.
  async function repoOf(repo) {
    let info = repo;
    if (typeof repo === "string" || !info?.default_branch) {
      const name = typeof repo === "string" ? repo : (info?.full_name ?? info?.name);
      if (!validRepo(name)) throw new Error("no repository's name");
      const key = name.toLowerCase();
      const kept = repoInfos.get(key);
      if (kept && now() - kept.at < ACCESS_MS) info = kept.info;
      else {
        let res;
        const read = started(key);
        try {
          try {
            res = await github(name, "GET", `/repos/${name}`);
          } catch (error) {
            res = { error };
          }
          if (!res.ok) {
            const why = res.error
              ? String(res.error?.message ?? res.error)
              : `GitHub GET /repos/${name}: ${res.status}${await said(res)}`;
            // A GitHub hiccup (transient()): what it last said, up to STALE_LISTING_MS old, as
            // listing()'s `stale` keeps the listing, so that it refuses nothing (#785). Its `at`
            // stays: a failed read never extends it. Not kept, forgotten by a push, or an answer
            // that isn't a hiccup (a 404: deleted, or out of the App's reach; the github service's
            // own refusal): fails closed, since its listing would then 404 too, read as no policy,
            // dropping its deny rules.
            const hiccup = await transient(res);
            await res.body?.cancel().catch(() => {});
            if (!hiccup) {
              // GitHub said something of it: what it said before, and its listing, go, so that a
              // later hiccup can't bring them back.
              repoInfos.delete(key);
              listings.delete(key);
            }
            if (!hiccup || !kept || read.forgotten || now() - kept.at > STALE_LISTING_MS) {
              throw res.error ?? new Error(why);
            }
            log(`${name}: reading the repository: ${why}; what GitHub last said kept`);
            return shape(kept.info);
          }
          info = await res.json();
          if (typeof info?.default_branch !== "string" || !info.default_branch) {
            throw new Error(`GitHub gave no default branch for ${name}`);
          }
          // A repository renamed or transferred answers with another name entirely: the name
          // asked for stays (as repo-check.mjs keeps it), so that the bindings, its listing and
          // forget() are all of the repository the caller asked about.
          const current = String(info.full_name).toLowerCase();
          if (current !== key) {
            // forget() ran under the current name while it was read (a privatization delivered
            // under it): it didn't know this name was that repository's yet.
            if (read.later.has(current)) read.forgotten = true;
            const names = new Set([...(renamed.get(current) ?? []), key]);
            // Moved last, as listing() moves its listings, so that the oldest is first to go.
            keepLast(renamed, current, names, MAX_ACCESS);
            info = { ...info, full_name: name };
          }
          // Forgotten while it was read (a privatization, a push): given to this caller alone, as
          // listing() does, so that a `private: false` read before it isn't kept ACCESS_MS after.
          // Otherwise moved last too, a fresh read.
          if (!read.forgotten) {
            keepLast(repoInfos, key, { at: now(), info }, MAX_ACCESS);
          }
        } finally {
          done(key, read);
        }
      }
    }
    return shape(info);
  }

  // Whether GitHub's answer `res` (or { error }, a call that threw) is a hiccup that may pass: no
  // answer (a call that threw without a status: the network), a 5xx, or a rate limit
  // (rateLimited()). A throw with any other status is the github service's own refusal (no App,
  // a repository it doesn't reach: ../github/client.mjs): it says something, as a 404 does.
  async function transient(res) {
    if (res.error) {
      const status = res.error?.status;
      return typeof status !== "number" || status >= 500 || status === 429;
    }
    return res.status >= 500 || (await rateLimited(res));
  }

  // The message of GitHub's failed answer `res`, for the log (": …"), or "".
  async function said(res) {
    const text = await (res.clone?.() ?? res).text().catch(() => "");
    try {
      const message = JSON.parse(text)?.message;
      return typeof message === "string" && message ? `: ${message.slice(0, 200)}` : "";
    } catch {
      return "";
    }
  }

  // GitHub's info about a repository → repoOf()'s answer.
  function shape(info) {
    const name = info?.full_name ?? info?.name;
    if (!validRepo(name)) throw new Error("no repository's name");
    return { name, private: info.private !== false, ref: info.default_branch };
  }

  // Deckhand's own policies alone (builtInGiving()), one giving every action to every login (its
  // access.rego), and no repo file: every action, without a call. `layers`: policiesFor()'s →
  // the files giving it, or null.
  async function everyAction(layers) {
    if (layers.repo.size) return null;
    return builtInGiving("access", layers.operator, EVERY_ACTION);
  }

  // Who may do what (#730): the actions `login` has on `repo` (its name, or GitHub's info about
  // it: repoOf()), or server-wide when `repo` is null, as the operator's `allow_access` gives them
  // and neither layer's `deny_access` takes them away, asked with { user: { login }, repo: { name,
  // private } | null }, both names in lower case → { actions, denied, files, error }: `actions`,
  // the patterns allowed (`runs:start:*`, `*`), sorted; `denied`, [{ action, reason, file, layer
  // }]; `files`, each action → the operator's files whose own rule gives it (Settings › Access);
  // `error`, why nothing is given (a policy error, policies or GitHub that can't be read, a policy
  // service away), null otherwise. allows() reads it: a deny wins. A repo's allow rules aren't
  // read (OPERATOR_ALLOWS): its listing is read first (forget() on its push), and its deny rules
  // apply. One evaluation per login and repository gives them all; kept (`accessKept`), frozen,
  // as every later caller gets the same answer. Pass a repository's name, or GitHub's current
  // info about it: a stale one (its old name, with its default branch) isn't read again, so its
  // push's forget(), under the current name, wouldn't clear what is kept under the old one.
  async function access(login, repo = null) {
    const nothing = (error) => ({ actions: [], denied: [], files: {}, error });
    const who = typeof login === "string" ? login.toLowerCase() : "";
    if (!who) return nothing("no login");
    for (let attempt = 0; ; attempt++) {
      let where = null;
      let layers;
      try {
        if (repo != null) where = await repoOf(repo);
        layers = {
          operator: await defaults(),
          // Its last listing when GitHub can't list it now, as run decisions take it (#785).
          repo: where
            ? await repoPolicies(where.name, where.ref, { cached: true, stale: true })
            : new Map(),
        };
      } catch (error) {
        const what =
          where?.name ?? (repo == null ? "server-wide" : (repo.full_name ?? repo.name ?? repo));
        log(`${what}: ${who}'s access: ${error.message ?? error}`);
        return nothing(failure(`the policies can't be read (${error.message ?? error})`)[0]);
      }
      const input = {
        version: INPUT_VERSION,
        decision: "access",
        user: { login: who },
        repo: where && { name: where.name.toLowerCase(), private: where.private },
      };
      const key = JSON.stringify([
        layerDigest(layers.operator),
        layerDigest(layers.repo),
        input.user,
        input.repo,
      ]);
      const kept = accessKept.get(key);
      if (kept && now() - kept.at < ACCESS_MS) return kept.said;
      let answer;
      const giving = await everyAction(layers);
      if (giving) answer = { actions: ["*"], denied: [], files: { "*": giving }, error: null };
      else {
        const said = await evaluateSets("access", layers, { access: input });
        if (said.mismatch && attempt === 0) {
          knownOwn = null;
          continue;
        }
        if (said.error) {
          const [message] = failure(said.error);
          log(`${where?.name ?? "server-wide"}: ${who}'s access refused: ${message}`);
          return nothing(message);
        }
        const { operator, repo: own } = said.results.access;
        const actions = [...operator.allow.keys()].sort();
        answer = {
          actions,
          denied: [
            ...operator.deny.map((d) => ({ ...d, layer: "operator" })),
            ...(own?.deny ?? []).map((d) => ({ ...d, layer: "repo" })),
          ],
          files: Object.fromEntries(
            actions.map((a) => [a, operator.allow.get(a).filter((f) => f !== null)]),
          ),
          error: null,
        };
      }
      answer = frozen(answer);
      // Moved last too: an expired entry asked again isn't the first to go.
      keepLast(accessKept, key, { at: now(), said: answer }, MAX_ACCESS);
      return answer;
    }
  }

  // Whether `login` may do `action` on `repo` (access()'s), or server-wide when `repo` is null.
  async function can(login, repo, action) {
    return allows(await access(login, repo), action, repo != null);
  }

  // Why `rule` (`deny_merge`, `merge`…: its decision) refuses on `repo` (its policies on `ref`,
  // its default branch): the messages, or [] when it is allowed. `input()` builds the input
  // (it may read GitHub): not for a decision only built-in modes make when Deckhand's files
  // alone allow it, otherwise always, as whether the run is in the repo's own mode is the
  // input's. Fail closed: an error reading the policies is a refusal too.
  async function deny(rule, repo, ref, input) {
    return (await decide(rule, repo, ref, input)).messages;
  }

  // deny()'s work → { applied, messages, input, unread, layers }: `applied`, whether any policy
  // was asked (Deckhand's allowing alone, and no repo file: false, and nothing for the task's
  // page to show); `input`, the document the rules saw, when it could be built (decisions.mjs
  // keeps it, redacted); `unread`, the refusal is the policies or the input that couldn't be read
  // (GitHub, most likely), not a rule's; `layers`, what each layer said (evaluated()).
  async function decide(rule, repo, ref, input) {
    // The service's operator layer isn't the one read here (its new version's defaults, say):
    // Deckhand's asked again, then once more, the operator's checked against the listener's own.
    for (let attempt = 0; ; attempt++) {
      let layers;
      try {
        layers = await policiesFor(repo, ref);
      } catch (error) {
        log(`${repo}: reading its policies: ${error.message ?? error}`);
        return {
          applied: true,
          unread: true,
          messages: failure(`the policies can't be read (${error.message ?? error})`),
        };
      }
      const decision = decisionOf(rule);
      // Only a repo's own mode would need its allow, which a built-in-only decision never is.
      if (
        !layers.repo.size &&
        BUILT_IN_ONLY.has(decision) &&
        (await onlyBuiltInAllowing(decision, layers.operator))
      ) {
        return { applied: false, messages: [] };
      }
      const { mismatch, ...result } = await evaluated(rule, repo, layers, input);
      if (mismatch && attempt === 0) {
        knownOwn = null;
        continue;
      }
      return { applied: result.asked, ...result };
    }
  }

  // `rule`'s decision on the layers `layers` ({ operator, repo }: name → text), on the input
  // `input()` builds, version added → { messages, input, layers, asked, unread }: `layers`, each
  // evaluated layer's { layer, allow, denies, allowFiles, denyFiles, error } (`allow` null when
  // its allow rules aren't asked: a repo's, on a built-in mode's decision; the files, those that
  // define each rule, which decided); `asked`, whether the policy service was asked or a rule
  // refused;
  // `input`, absent when it couldn't be built. The repo's layer is listed when it has files or
  // its allow is needed.
  async function evaluated(rule, repo, layers, input) {
    // One map: the operator's layer alone, as a test of its files gives it.
    if (layers instanceof Map) layers = { operator: layers, repo: new Map() };
    const decision = decisionOf(rule);
    let doc;
    try {
      doc = { version: INPUT_VERSION, ...(await input()) };
    } catch (error) {
      log(`${repo}: the ${decision} input: ${error.message ?? error}`);
      return {
        asked: true,
        unread: true,
        layers: [],
        messages: failure(`its input can't be built (${error.message ?? error})`),
      };
    }
    // A run in one of the repo's own modes: its repo's allow is needed too.
    const custom = !BUILT_IN_ONLY.has(decision) && doc.custom_mode === true;
    const defining = (files, name) =>
      [...files].filter(([, text]) => rulesOf(text).includes(name)).map(([n]) => n);
    // Deckhand's files alone, allowing whatever the input: no need to ask them. One call to the
    // policy service for the rest, both layers in it when both have files.
    const skip = await onlyBuiltInAllowing(decision, layers.operator);
    const asking = {
      ...(!skip && layers.operator.size && { operator: layers.operator }),
      ...(layers.repo.size && { repo: layers.repo }),
    };
    const got = Object.keys(asking).length
      ? await evaluateLayers(decision, asking, doc, {
          repoAllow: custom,
          operator: layers.operator,
        })
      : { error: null };
    // A layer as listed: what opa said of it, or what it says without opa (skipped: allowing;
    // no files: allowing nothing, its allow asked or not).
    const layer = (name, files, allow) => ({
      layer: name,
      ...(got.error
        ? {
            allow: allow ? false : null,
            denies: [],
            // The layer opa placed the error in, else every one it was asked about.
            error: (got.errorLayer ?? name) === name && asking[name] ? got.error : null,
          }
        : (got[name] ?? {
            allow: allow ? (name === "operator" && skip) || false : null,
            denies: [],
          })),
      ...(!got.error && { error: null }),
      allowFiles: allow ? defining(files, `allow_${decision}`) : [],
      denyFiles: defining(files, `deny_${decision}`),
    });
    const said = [
      layer("operator", layers.operator, true),
      ...(layers.repo.size || custom ? [layer("repo", layers.repo, custom)] : []),
    ];
    const asked = !skip || layers.repo.size > 0 || custom;
    if (got.error && !said.some((l) => l.error)) said[0].error = got.error;
    if (got.error) {
      const messages = failure(got.error);
      log(`${repo}: ${decision} refused: ${messages[0]}`);
      return {
        asked,
        messages,
        input: doc,
        layers: said.map(shownLayer),
        ...(got.mismatch && { mismatch: true }),
      };
    }
    // A deny says why; without one, the layers no allow rule matched do.
    const denies = said.flatMap((l) => l.denies);
    const reasons = denies.length
      ? denies
      : said.filter((l) => l.allow === false).map((l) => unallowed(decision, doc, l.layer));
    const shownMessages = messages(reasons);
    if (shownMessages.length) log(`${repo}: ${decision} refused: ${shownMessages.join(" | ")}`);
    return { asked, messages: shownMessages, input: doc, layers: said.map(shownLayer) };
  }

  // A layer's result as kept and shown: its messages capped and redacted, its error a line.
  const shownLayer = ({ denies, error, ...rest }) => ({
    ...rest,
    denies: messages(denies),
    error: error ? failure(error)[0] : null,
  });

  // `rule` on `layers` (describe()'s `policies`, or one map: the operator's layer alone), on the
  // input `input()` builds → its messages, logged: a dry run's (reviews.mjs).
  async function denied(rule, repo, layers, input) {
    return (await evaluated(rule, repo, layers, input)).messages;
  }

  // The config check of one layer's `files` (name → text): compile errors and rules nobody
  // evaluates, as { errors, warnings }. No files: nothing to say, and no call.
  async function check(files, layer = "operator") {
    const { errors, warnings } = await compile(files, layer);
    return { errors: errors.map((e) => e.text), warnings };
  }

  // check()'s work, each error as { layer, file, row, message, text }: file and row null when
  // opa doesn't give them (a timeout, a policy service away), `text` what check() says of it.
  // A repo's (`layer` "repo") allow rule for a built-in-only decision is an error: it would be
  // ignored.
  async function compile(files, layer = "operator") {
    const errors = [];
    const warnings = [];
    if (!files.size) return { errors, warnings };
    const placed = (file, row, message) => ({
      layer,
      file,
      row,
      message: line(message),
      text: line(`${file}:${row ?? "?"}: ${message}`),
    });
    for (const [name, text] of files) {
      if (layer === "operator") {
        for (const [, decision] of text.matchAll(UNCONDITIONAL)) {
          warnings.push(
            `${name}: \`allow_${decision}\` allows every ${decision === "push" ? "push" : "write to GitHub"} of every mode, whatever it reads: no built-in ceiling caps it any more (issue #496). Remove it, or narrow it to the modes it is for (Deckhand's mode-<mode>.rego allow each mode its own)`,
          );
        }
      }
      // Gone from every input (#498): a rule reading it now sees it undefined, without an
      // error: `deny_… if input.light` denies nothing, `not input.light` holds for every run.
      if (GONE_INPUT.test(text)) {
        warnings.push(
          `${name}: reads \`input.light\`, which no input has any more (issue #498): a rule on it now matches as if every run had none. Read what the run gets instead: its \`mode\`, or its capabilities in \`allow_capabilities\` (\`push\`)`,
        );
      }
      for (const rule of rulesOf(text)) {
        if (!RULES.includes(rule)) {
          warnings.push(
            `${name}: \`${rule}\` isn't a rule Deckhand evaluates (${RULES.map((r) => `\`${r}\``).join(", ")})`,
          );
        } else if (layer === "repo" && OPERATOR_ONLY.has(decisionOf(rule))) {
          errors.push({
            ...placed(
              name,
              lineOf(text, rule),
              `\`${rule}\` is ignored: only the operator's policies decide a repository's grants (#498)`,
            ),
            ignored: true,
          });
        } else if (layer === "repo" && OPERATOR_ALLOWS.has(decisionOf(rule))) {
          if (rule.startsWith("allow_")) {
            errors.push({
              ...placed(
                name,
                lineOf(text, rule),
                `\`${rule}\` is ignored: only the operator's policies give access; a repository's may only take some away (\`deny_access\`)`,
              ),
              ignored: true,
            });
          }
        } else if (layer === "repo" && rule.startsWith("allow_")) {
          const decision = decisionOf(rule);
          if (BUILT_IN_ONLY.has(decision)) {
            // Ignored, it refuses nothing: an error the onboarding check says, flagged for the
            // dashboard, which doesn't take it for a refusal.
            errors.push({
              ...placed(
                name,
                lineOf(text, rule),
                `\`${rule}\` is ignored: a repository's allow rules count only for its own modes, and only the operator's allow the ${decision}`,
              ),
              ignored: true,
            });
          }
        }
      }
    }
    // The policy service compiles them, with the capabilities decisions have: a repo file whose
    // package can't be moved under its namespace is said at its line, the others checked
    // without it. Its errors are said as they are, cut and redacted here.
    let said;
    try {
      said = await service.compile({ layer, files: [...files] });
    } catch (error) {
      const what = error.message ?? String(error);
      errors.push({ layer, file: null, row: null, message: line(what), text: failure(what)[0] });
      return { errors, warnings };
    }
    for (const e of Array.isArray(said?.errors) ? said.errors : []) {
      errors.push({
        layer,
        file: typeof e.file === "string" ? e.file : null,
        row: Number.isInteger(e.row) ? e.row : null,
        message: line(String(e.message ?? "error")),
        text: line(String(e.text ?? e.message ?? "error")),
      });
    }
    return { errors, warnings };
  }

  // A review.rego of the operator's that replaces Deckhand's and never names `author_type`:
  // other bots' pull requests, which the default skips, are reviewed now, at the operator's cost.
  // Said, as a file of that name written before the default (wip labels, docs only) drops it
  // unseen. A file that names it, a comment saying so will do, decided. `text`: the file's.
  // → the warning, or null.
  function botsReviewed(text) {
    // Deckhand's as the service last gave them; unknown, describe() says why.
    const own = knownOwn?.get(BOT_REVIEWS);
    if (text === undefined || !own || text === own || /\bauthor_type\b/.test(text)) return null;
    return `The grants folder's policy/${BOT_REVIEWS} replaces Deckhand's default without a rule on \`input.pr.author_type\`: other bots' ready pull requests (Dependabot's, GitHub Actions') are reviewed by themselves in every repository. To keep them skipped, copy the default's rule into it; to say they should be reviewed, name \`author_type\` in a comment there`;
  }

  // The operator's files (`operator`, name → text) that define `bindings` while Deckhand's
  // access.rego is still in effect, not replaced or replaced by a copy of it: its
  // `allow_access contains "*"` is in the union, so every login keeps every action whatever the
  // bindings say (#764). → the warning, or null.
  // Or, Deckhand's replaced, the operator's files that keep its `allow_access contains "*"`
  // (a copy of it, bindings added below its line): the same union, the same trap (#862).
  function bindingsCancelled(operator) {
    // Deckhand's as the service last gave them; unknown, describe() says why.
    const own = knownOwn?.get(ACCESS);
    if (!own) return null;
    const ours = [...operator].filter(([, text]) => /^\s*package\s+deckhand\s*$/m.test(text));
    const named = (test) => ours.filter(([, text]) => test.test(text)).map(([n]) => `policy/${n}`);
    const files = named(BINDINGS);
    if (!files.length) return null;
    const define = `The grants folder's ${files.join(", ")} define${files.length === 1 ? "s" : ""} \`bindings\``;
    const replaced = operator.get(ACCESS);
    if (replaced === undefined || replaced === own) {
      return `${define}, but Deckhand's ${ACCESS} still gives every action to every login (\`allow_access contains "*"\`): the bindings narrow nothing. Write them in the grants folder's policy/${ACCESS}, which replaces Deckhand's`;
    }
    const every = named(EVERY_ACTION);
    if (!every.length) return null;
    return `${define}, but ${every.join(", ")} still give${every.length === 1 ? "s" : ""} every action to every login (\`allow_access contains "*"\`, kept from Deckhand's ${ACCESS}): the bindings narrow nothing. Remove that rule, or give it a condition`;
  }

  // A repo's files named as one of the operator's layer (`under`, name → text): it no longer
  // replaces it (issue #494), a repo's files only add rules. → the warnings.
  function shadowing(own, under) {
    return [...own.keys()]
      .filter((name) => under.has(name))
      .map(
        (name) =>
          `${name} doesn't replace the operator's or Deckhand's file of that name: a repository's policies are evaluated on their own, their deny rules for every run and their allow rules for the repository's own modes only`,
      );
  }

  // The operator's policies over Deckhand's, as the policy service reads them, checked: errors
  // to say at start.
  async function checkOperator() {
    try {
      const { deckhand, operator, errors } = await served();
      const error = errors.deckhand ?? errors.operator;
      if (error) throw new Error(error);
      const files = new Map([...deckhand, ...operator]);
      const checked = await check(files);
      const said = [botsReviewed(operator.get(BOT_REVIEWS)), bindingsCancelled(operator)];
      const actions = checked.errors.length
        ? []
        : await accessActionWarnings(async () => ({ operator: await defaults(), repo: new Map() }));
      return {
        ...checked,
        warnings: [...checked.warnings, ...said.filter(Boolean), ...actions],
      };
    } catch (error) {
      return { errors: [error.message ?? String(error)], warnings: [] };
    }
  }

  // A repo's policies on `ref` (a branch), checked on their own, as they are evaluated: what
  // the onboarding pull request's reply says (onboarding.mjs branchConfigReport()). `modes`: the
  // repo's own on `ref`, by name (its config's there), for the `runs:start:` actions it names.
  async function checkRepo(repo, ref, { modes = null } = {}) {
    const own = await repoPolicies(repo, ref);
    if (!own.size) return { errors: [], warnings: [] };
    let under = new Map();
    try {
      under = await defaults();
    } catch {
      // Said at start: the repo's own are what this check is about.
    }
    const { errors, warnings } = await compile(own, "repo");
    // Its deny rules on their own, as they apply to every run (the operator's are said at start):
    // an ignored rule compiles all the same.
    const actions = errors.some((e) => !e.ignored)
      ? []
      : await accessActionWarnings(
          async () => ({ operator: await defaults().catch(() => under), repo: own }),
          repo,
          { operator: false, modes },
        );
    return {
      errors: errors.map((e) => e.text),
      warnings: [...warnings, ...shadowing(own, under), ...actions],
    };
  }

  // What applies on `repo` (its policies on `ref`, its default branch, read now), for the
  // dashboard's config panel and `/mode policy`: { files: [{ name, source, replaces, active,
  // rules, url, text, truncated }], errors, warnings, policies }, Deckhand's files first
  // ("deckhand"), then the operator's, then the repo's. In the operator's layer, a file
  // `replaces` Deckhand's of its name ("deckhand"; null for none), listed too, not `active`:
  // nothing evaluates it; a repo's file replaces nothing. `text`: the file's, redacted and cut at
  // MAX_TEXT (`truncated`). `errors`: compile()'s of each layer's active files, and why the
  // operator's can't be read (every decision refuses then). `policies`: { operator, repo }, each
  // name → text, what decide() would evaluate. No policy anywhere: no compile asked. The policy
  // service away: said, and the repo's files listed alone.
  async function describe(repo, ref) {
    const errors = [];
    const said = (text) =>
      errors.push({ layer: null, file: null, row: null, message: line(text), text: line(text) });
    let deckhand = [];
    let operator = [];
    try {
      const layers = await served();
      if (layers.deckhand) deckhand = entries("deckhand", layers.deckhand);
      else said(`Deckhand's policies can't be read: ${layers.errors.deckhand}`);
      if (layers.operator) operator = entries("operator", layers.operator);
      else said(`the operator's policies can't be read: ${layers.errors.operator}`);
    } catch (error) {
      said(error.message ?? String(error));
    }
    const own = (await repoFiles(repo, ref, false)).map((f) => ({ ...f, source: "repo" }));
    const has = (layer, name) => layer.some((f) => f.name === name);
    const files = [
      ...deckhand.map((f) => ({ ...f, replaces: null, active: !has(operator, f.name) })),
      ...operator.map((f) => ({
        ...f,
        replaces: has(deckhand, f.name) ? "deckhand" : null,
        active: true,
      })),
      ...own.map((f) => ({ ...f, replaces: null, active: true })),
    ];
    const texts = (list) => new Map(list.filter((f) => f.active).map((f) => [f.name, f.text]));
    const policies = {
      operator: texts(files.filter((f) => f.source !== "repo")),
      repo: texts(files.filter((f) => f.source === "repo")),
    };
    const [up, down] = await Promise.all([
      compile(policies.operator, "operator"),
      compile(policies.repo, "repo"),
    ]);
    const review = operator.find((f) => f.name === BOT_REVIEWS);
    const bots = review && botsReviewed(review.text);
    const bindings = bindingsCancelled(new Map(operator.map((f) => [f.name, f.text])));
    return {
      files: files.map(({ text, ...f }) => ({ ...f, rules: rulesOf(text), ...shown(text) })),
      errors: [...errors, ...up.errors, ...down.errors],
      warnings: [
        ...up.warnings,
        ...down.warnings,
        ...shadowing(policies.repo, policies.operator),
        ...(bots ? [bots] : []),
        ...(bindings ? [bindings] : []),
      ],
      policies,
    };
  }

  // A layer's files (name → text) as describe() lists them.
  const entries = (source, files) =>
    [...files].map(([name, text]) => ({ name, source, text, url: null }));

  // A file's text as the dashboard shows it: without the operator's secrets, cut at MAX_TEXT
  // (after the redaction, so a cut never leaves part of a secret).
  function shown(text) {
    const clean = redact(text, secrets());
    if (clean.length <= MAX_TEXT) return { text: clean, truncated: false };
    return { text: clean.slice(0, MAX_TEXT), truncated: true };
  }

  // `repo`'s default branch moved (a push, a merge: repos.mjs refreshFor()), or it left the App's
  // reach, was deleted, transferred or made private (repos.mjs forgottenFor()): its policies are
  // listed again at the next decision, and what GitHub says of it read again (access()).
  function forget(repo) {
    const key = repo.toLowerCase();
    for (const name of [key, ...(renamed.get(key) ?? [])]) {
      listings.delete(name);
      repoInfos.delete(name);
      for (const read of reading.get(name) ?? []) read.forgotten = true;
    }
    for (const reads of reading.values()) {
      for (const read of reads) {
        if (read.later.size < MAX_LATER) read.later.add(key);
        else read.forgotten = true;
      }
    }
  }

  return {
    deny,
    decide,
    capabilityRules,
    accessNameWarnings,
    evaluateCapabilities,
    grants,
    access,
    can,
    denied,
    evaluated,
    describe,
    check,
    checkOperator,
    checkRepo,
    repoPolicies,
    policiesFor,
    deckhandOnly,
    forget,
  };
}
