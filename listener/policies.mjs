// Rules as code (issues #292, #494, #488): Rego policies that allow and refuse what the listener asks
// them, after its built-in gates, evaluated by the pinned `opa` binary (listener/Dockerfile).
// Each decision has two rules of package `deckhand`: `allow_<decision>`, true when it allows, and
// `deny_<decision>`, a set of strings, the reasons shown to the maintainer (or the run, for
// `deny_github`). Decisions: `run` for a run a person starts (run-policy.mjs), `merge`,
// `review`, `fix`, `link_branch` for the branch the listener
// links to a work run's issue (linked-branch.mjs), `request_review` for the reviewers it
// requests (reviewers.mjs), and `github` for a run's GitHub writes (github-writes.mjs). A
// decision is allowed when an allow rule matches and no deny rule does: a deny always wins.
//
// Two layers, evaluated by one `opa` process, each in a namespace of its own so that neither's
// files can define or break the other's rules (namespaced()): the operator's, Deckhand's own defaults (BUILT_IN_DIR, in the
// image: issue #448) under GRANTS_DIR/policy/*.rego, read again at each decision like the grants,
// a file with the same name replacing a default; then a repo's, .deckhand/policy/*.rego on its
// default branch, like its .deckhand.yaml. The operator's allow rules are the ceiling. The repo's
// deny rules apply to every run; its allow rules count only for its own modes (`custom_mode`),
// which need the operator's allow and its own.
//
// Isolation: the policies are code a repo's maintainers write, and the listener holds the
// Docker socket and the App's key. `opa` runs with an empty environment, under a timeout, and
// with a capabilities file without the builtins that read the environment, the network or
// files (opa.runtime, http.send, net.*, the JSON schema ones) or trace. Fail closed: a policy that doesn't compile, times
// out or gives a rule anything but its type refuses, with that reason, and so does a decision
// no allow rule matches. Format: ../docs/repo-config.md#policies; trust:
// ../docs/security.md#policies.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getJson } from "./github.mjs";
import { redact } from "../lib/redact.mjs";

// Where a repo's policies are, on its default branch, and the operator's, in GRANTS_DIR.
export const POLICY_DIR = ".deckhand/policy";
const OPERATOR_DIR = "policy";
// Deckhand's own defaults (../policy/, copied into the image at the same relative path):
// allow.rego, which allows each decision, one file per `gh` feature (gh-<feature>.rego) and
// github.rego, which narrow the modes' ceilings to what the prompts ask for. Without the
// operator's setup: they hold unless replaced.
export const BUILT_IN_DIR = fileURLToPath(new URL("../policy/", import.meta.url));

// The decisions the listener asks the policies about, each with its two rules.
export const DECISIONS = [
  "run",
  "merge",
  "review",
  "fix",
  "link_branch",
  "request_review",
  "github",
];

// The rules the listener evaluates: another `allow_*` or `deny_*` rule is a mistake the config
// check says.
export const RULES = DECISIONS.flatMap((d) => [`allow_${d}`, `deny_${d}`]);

// The decisions only about built-in modes' runs (a review, its fix run, the merge): a repo's
// allow rule for them would count for no run, and is a config check error.
export const BUILT_IN_ONLY = new Set(["merge", "review", "fix"]);

// `deny_merge`, `allow_merge` or `merge` → "merge".
export const decisionOf = (rule) => rule.replace(/^(?:allow|deny)_/, "");

// Deckhand's default for the reviews that start by themselves, which skips other bots' pull
// requests: replacing it without a word about them gets a warning (botsReviewed()).
const BOT_REVIEWS = "review.rego";

// What the input looks like (docs/repo-config.md#the-merge-input): a policy can check it.
export const INPUT_VERSION = 1;

// What every decision's input has about a pull request (docs/repo-config.md#the-merge-input),
// reviews.mjs's and reviewers.mjs's: the repo (`info`, GET /repos/{repo}), the pull request
// and its `files`, its linked `issue`, and the `review` when there is one. `bot`: the App's
// login (config.bot), for `pr.deckhand`.
export function pullInput({
  decision,
  info,
  pr,
  files,
  issue,
  review = null,
  bot = null,
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

// One decision's evaluation, compile included. Long enough for `opa` to start and load a few
// files, short enough that a loop in a policy doesn't hold a merge decision for long.
export const TIMEOUT_MS = 2000;
// Over TIMEOUT_MS, for `opa` to start and say it timed out itself: then the process is killed.
const KILL_GRACE_MS = 3000;

// What a refusal quotes of a policy: its first messages, each cut.
export const MAX_MESSAGES = 5;
export const MAX_MESSAGE_LENGTH = 200;

// A policy file's name: no folders, nothing hidden.
const FILE = /^[\w][\w.-]*\.rego$/;

// The builtins a policy can't call: the environment (opa.runtime), the network (http.send,
// net.lookup_ip_addr and the rest of net.*, pure as most are: one rule, easy to read), the
// listener's files (json.match_schema and json.verify_schema follow a schema's `$ref` to a
// `file://` path, allow_net or not) and trace (output nobody reads).
const REMOVED =
  /^(?:opa\.runtime|http\.send|net\..*|json\.match_schema|json\.verify_schema|trace)$/;

// `opa capabilities --current`'s JSON → the same without REMOVED and with no host allowed
// (allow_net: remote schemas, http.send and net.lookup_ip_addr).
export function restrictedCapabilities(current) {
  const caps = typeof current === "string" ? JSON.parse(current) : current;
  if (!Array.isArray(caps?.builtins)) throw new Error("opa's capabilities have no builtins");
  return {
    ...caps,
    builtins: caps.builtins.filter((b) => !REMOVED.test(b.name)),
    allow_net: [],
  };
}

// `name` on the listener's PATH, as a full path: the process runs without a PATH of its own.
function onPath(name) {
  if (name.includes("/")) return name;
  const { PATH = "" } = process.env;
  for (const dir of PATH.split(":").filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not there.
    }
  }
  return name;
}

// Runs the `opa` binary: `args`, `input` on stdin, an empty environment, killed after
// `timeoutMs`. → { code, stdout, stderr, timedOut }. `bin`: the binary (a fake in the tests).
export function opaRunner(bin = "opa") {
  let path = null;
  return (args, { input = "", timeoutMs = TIMEOUT_MS + KILL_GRACE_MS, cwd } = {}) =>
    new Promise((resolve) => {
      path ??= onPath(bin);
      const child = execFile(
        path,
        args,
        { env: {}, cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 << 20 },
        (error, stdout, stderr) => {
          // Killed at the timeout; not for too much output (maxBuffer), said as a failure.
          const timedOut = !!error?.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          // Not started at all (ENOENT): said as a failure of its own.
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          resolve({ code, stdout, stderr: stderr || (code === -1 ? error.message : ""), timedOut });
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
}

// The operator's policies: GRANTS_DIR/policy/*.rego, read now, name → text. A symlink is
// followed only when it stays in the grants folder (a mounted ConfigMap's files are links).
// No folder: none. A file that can't be read throws: no decision without the operator's rules.
export function operatorPolicies(config, read = (path) => readFileSync(path, "utf8")) {
  const files = new Map();
  if (!config.grantsDir) return files;
  const dir = join(config.grantsDir, OPERATOR_DIR);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return files;
    throw new Error(`${OPERATOR_DIR}/ in the grants folder can't be read (${error.code})`);
  }
  let top;
  try {
    top = realpathSync(config.grantsDir);
  } catch {
    top = config.grantsDir;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!FILE.test(entry.name)) continue;
    let path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let resolved;
      try {
        resolved = realpathSync(path);
      } catch {
        throw new Error(`${OPERATOR_DIR}/${entry.name} is a broken symlink`);
      }
      const rel = relative(top, resolved);
      if (rel.startsWith("..") || isAbsolute(rel) || !statSync(resolved).isFile()) {
        throw new Error(`${OPERATOR_DIR}/${entry.name} leads outside the grants folder`);
      }
      path = resolved;
    } else if (!entry.isFile()) continue;
    try {
      files.set(entry.name, read(path));
    } catch (error) {
      throw new Error(
        `${OPERATOR_DIR}/${entry.name} can't be read (${error.code ?? error.message})`,
      );
    }
  }
  return files;
}

// Deckhand's allow rules (policy/allow.rego): every decision allowed unless a deny rule says
// otherwise, as before allow rules; all but `run`, which policy/run.rego allows where each mode
// makes sense. Its name, and the map createPolicies() gets by default.
export const ALLOW = "allow.rego";
// Deckhand's allow rules for the runs people start (policy/run.rego).
const RUN = "run.rego";
export const allowOnly = (dir = BUILT_IN_DIR) =>
  new Map([[ALLOW, readFileSync(join(dir, ALLOW), "utf8")]]);

// Deckhand's own policies: `dir`'s *.rego, name → text, read once by createPolicies(). No
// folder: none. A file that can't be read throws, as the operator's.
export function builtInPolicies(dir = BUILT_IN_DIR, read = (path) => readFileSync(path, "utf8")) {
  const files = new Map();
  let names;
  try {
    names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw new Error(`Deckhand's policies can't be read (${error.code})`);
  }
  for (const name of names) if (FILE.test(name)) files.set(name, read(join(dir, name)));
  return files;
}

// The `allow_*` and `deny_*` rules a file defines at the start of a line, in package
// `deckhand`: what the config check compares with RULES, and the files the dashboard says
// decided. A rule written otherwise is only missed by them.
export function rulesOf(text) {
  if (!/^\s*package\s+deckhand\s*$/m.test(text)) return [];
  return [...new Set([...text.matchAll(/^((?:allow|deny)_\w*)\b/gm)].map((m) => m[1]))];
}

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
    case "request_review":
      return `no ${rules} allows requesting reviewers for ${run(doc.mode)}'s pull request`;
    case "fix":
      return `no ${rules} allows a fix run${doc.reason ? ` (\`${doc.reason}\`)` : ""}`;
    default:
      return `no ${rules} allows the ${decision}`;
  }
}

// How many of `opa`'s errors are kept: its own default for `check` (--max-errors).
const MAX_ERRORS = 10;

// `opa`'s errors (its JSON output, on stdout for `eval` and stderr for `check`) → { text, one
// line with each file's own name, list: each error's { file, row, message }, file and row null
// when opa gives none, cancelled: whether `eval` stopped at its --timeout }.
function opaErrors(stdout, stderr) {
  for (const out of [stdout, stderr]) {
    let errors;
    try {
      ({ errors } = JSON.parse(out));
    } catch {
      continue;
    }
    if (Array.isArray(errors) && errors.length) {
      const list = errors.slice(0, MAX_ERRORS).map((e) => ({
        file: e.location?.file?.replace(/^.*\//, "") || null,
        // The layer whose folder the file was staged in (staged()), when opa placed it.
        layer: /(?:^|\/)repo\/[^/]+$/.test(e.location?.file ?? "")
          ? "repo"
          : /(?:^|\/)operator\/[^/]+$/.test(e.location?.file ?? "")
            ? "operator"
            : null,
        row: Number.isInteger(e.location?.row) ? e.location.row : null,
        // A repo's packages as its files name them, not namespaced().
        message: String(e.message ?? e.code ?? "error").replaceAll(`${REPO_NS}.`, ""),
      }));
      const text = list.slice(0, 3).map(located).join("; ");
      return { text, list, cancelled: errors.some((e) => e.code === "eval_cancel_error") };
    }
  }
  const text = (stderr || stdout || "opa failed").trim().split("\n")[0];
  return { text, list: [{ file: null, layer: null, row: null, message: text }], cancelled: false };
}

// Where a repo's packages go in the one `opa` both layers share: under this, which no package
// of the operator's or Deckhand's is.
export const REPO_NS = "deckhand_repository";

// A repo file's `text` with its package moved under REPO_NS, so that it can neither define nor
// replace a rule of the operator's packages, whatever it declares: Rego's first statement is
// the package (after comments), and every rule a module defines is in it. Its `data.`
// references go there too, so that a repo's libraries still resolve: `data` as a term only, never
// in a string, a raw string or a comment, nor after a dot or a word (`"db/data.sql"`,
// `input.x.data.id` stay as they are). One written otherwise (`data["lib"]`) only reads the
// operator's, which widens nothing. null, refused rather than guessed (namespaceRefusal() says
// why): no package where the parser reads it (a `package` keyword on a line of its own, a
// byte-order mark), or a template string (`$"…{expr}…"`), whose expressions this doesn't read.
export function namespaced(text) {
  const head = /^((?:[ \t\r\n]|#[^\n]*(?:\n|$))*)package([ \t]+)(?=[A-Za-z_])/.exec(text);
  if (!head || templated(text.slice(head[0].length))) return null;
  const rest = text
    .slice(head[0].length)
    .replace(DATA_TERMS, (m) => (m === "data." ? `data.${REPO_NS}.` : m));
  return `${head[1]}package${head[2]}${REPO_NS}.${rest}`;
}

// What namespaced() skips (strings with their escapes, raw strings, comments) or rewrites (a
// `data.` that no dot or word character comes before), in the order Rego's lexer reads them; a
// template string's start (`$"`, `` $` ``) stops it, as templated() says.
const DATA_TERMS = /"(?:[^"\\\n]|\\.)*"|`[^`]*`|#[^\n]*|\$["`]|(?<![\w.])data\./g;

// Whether `text` (a repo file's, after its package) has a template string outside strings and
// comments: the first one ends the scan, so a string inside its `{…}` can't put it out of step.
function templated(text) {
  return templateAt(text) !== null;
}

// Where `text`'s first template string starts, outside strings and comments: its index, or null.
function templateAt(text) {
  for (const m of text.matchAll(DATA_TERMS)) if (m[0] === '$"' || m[0] === "$`") return m.index;
  return null;
}

// Why namespaced() refuses repo file `name` (`text`): what its config check and its decisions
// say. null when it doesn't.
// `row`: the line it is about (the template string's, else the first).
export function namespaceRefusal(name, text) {
  if (namespaced(text) !== null) return null;
  const head = /^((?:[ \t\r\n]|#[^\n]*(?:\n|$))*)package([ \t]+)(?=[A-Za-z_])/.exec(text);
  if (!head) {
    return {
      row: 1,
      message: `${name} must start with \`package …\` (after comments only), on one line`,
    };
  }
  const at = head[0].length + templateAt(text.slice(head[0].length));
  return {
    row: text.slice(0, at).split("\n").length,
    message: `${name}: a repository's policies can't use template strings (\`$"…{…}"\`): use sprintf()`,
  };
}

// An error of opaErrors()'s list as one line: `file:row: message`.
const located = ({ file, row, message }) => `${file ? `${file}:${row ?? "?"}: ` : ""}${message}`;

// How much of a policy file's text the dashboard gets: its source view, not a download.
export const MAX_TEXT = 20 * 1024;

// How long a repo's listing of POLICY_DIR is kept: a push to its default branch forgets it
// sooner (forget()), so this only bounds a push whose webhook never came.
const LISTING_MS = 10 * 60_000;

// `github`: the App's calls; `run(args, { input, cwd })`: opaRunner()'s; `secrets()`: what
// redaction hides of the messages (secrets.mjs); `readOperator()`: the operator's policies
// (operatorPolicies()); `readBuiltIn()`: Deckhand's own (builtInPolicies(); by default its
// allow.rego alone, which the tests' rules build on: server.mjs passes them all); `tmp`: where
// each decision's files go; `now`: the clock, for listings.
export function createPolicies({
  config,
  github,
  run = opaRunner(),
  secrets = () => [],
  readOperator = () => operatorPolicies(config),
  readBuiltIn = () => allowOnly(),
  tmp = tmpdir(),
  log = () => {},
  now = Date.now,
}) {
  // A file's text by its blob sha: the same policy is fetched once.
  const blobs = new Map();
  const MAX_BLOBS = 500;
  // "org/repo" (lower case) → { ref, at, listed }: its default branch's POLICY_DIR, as last
  // listed (null: none), so a repo without policies costs no call per decision.
  const listings = new Map();
  // restrictedCapabilities() of the binary, once it answered.
  let capabilities = null;
  // Deckhand's own policies, read once: they are part of the image.
  let builtIn = null;
  // Deckhand's policy/run.rego as shipped, read once (deckhandOnly()).
  let shippedRun = null;
  const ownDefaults = () => (builtIn ??= readBuiltIn());
  // The defaults under the operator's: name → text.
  const defaults = () => new Map([...ownDefaults(), ...readOperator()]);

  // `stale`: when GitHub can't list it, the last listing of `ref`, however old (a push forgot
  // it: forget()), rather than a failure; run-policy.mjs's, so that a GitHub hiccup doesn't
  // refuse the comments of a repo that had no policy.
  async function listing(repo, ref, cached, stale = false) {
    const key = repo.toLowerCase();
    const kept = listings.get(key);
    if (cached && kept?.ref === ref && now() - kept.at < LISTING_MS) return kept.listed;
    let listed;
    try {
      listed = await getJson(
        github,
        repo,
        `/repos/${repo}/contents/${POLICY_DIR}?ref=${encodeURIComponent(ref)}`,
        [404],
      );
    } catch (error) {
      if (!stale || kept?.ref !== ref) throw error;
      log(`${repo}: listing its policies: ${error.message ?? error}; the last listing kept`);
      return kept.listed;
    }
    if (cached) listings.set(key, { ref, at: now(), listed });
    return listed;
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
        if (blobs.size >= MAX_BLOBS) blobs.delete(blobs.keys().next().value);
        blobs.set(entry.sha, Buffer.from(blob.content ?? "", blob.encoding ?? "base64").toString());
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
  // and the operator's over them by file name; `repo`, the repo's on `ref`. Empty: none.
  // `stale`: listing()'s.
  async function policiesFor(repo, ref, { stale = false } = {}) {
    return { operator: defaults(), repo: await repoPolicies(repo, ref, { cached: true, stale }) };
  }

  // Whether the operator's layer `files` is Deckhand's own policies only, none of them defining
  // `deny_<decision>` and one allowing it whatever the input: then it allows, and no `opa` is
  // asked (no decision kept, without a repo's files). Deckhand's files are known: rulesOf()
  // reads them right.
  function onlyBuiltInAllowing(decision, files) {
    const own = ownDefaults();
    const always = new RegExp(`^allow_${decision}\\s*:=\\s*true\\s*$`, "m");
    return (
      [...files].every(
        ([name, text]) => own.get(name) === text && !rulesOf(text).includes(`deny_${decision}`),
      ) && [...files.values()].some((text) => always.test(text))
    );
  }

  // Whether the operator's layer `files` (name → text) is Deckhand's own policies, unchanged and
  // with nothing added, its run.rego the one shipped (BUILT_IN_DIR): then `run` needs no opa,
  // run-policy.mjs defaultRun() says what run.rego would.
  function deckhandOnly(files) {
    const own = ownDefaults();
    if (files.size !== own.size || [...files].some(([name, text]) => own.get(name) !== text)) {
      return false;
    }
    shippedRun ??= readFileSync(join(BUILT_IN_DIR, RUN), "utf8");
    return files.get(RUN) === shippedRun;
  }

  async function capabilitiesFile() {
    if (capabilities) return capabilities;
    const res = await run(["capabilities", "--current"], {});
    if (res.code !== 0)
      throw new Error(`opa capabilities: ${opaErrors(res.stdout, res.stderr).text}`);
    capabilities = JSON.stringify(restrictedCapabilities(res.stdout));
    return capabilities;
  }

  // `layers` ({ operator, repo }, each name → text, either absent) and the capabilities in a
  // temp dir for `use(dir)`, removed after: each layer in a folder of its own under
  // OPERATOR_DIR (opa's errors say which: opaErrors()), the repo's namespaced(). A repo file
  // that can't be throws, as a policy that doesn't compile.
  async function staged(layers, use) {
    const dir = await mkdtemp(join(tmp, "deckhand-policy-"));
    try {
      for (const [layer, files] of Object.entries(layers)) {
        if (!files) continue;
        await mkdir(join(dir, OPERATOR_DIR, layer), { recursive: true });
        for (const [name, text] of files) {
          const staged = layer === "repo" ? namespaced(text) : text;
          if (staged === null) {
            const { message } = namespaceRefusal(name, text);
            throw Object.assign(new Error(message), { layer: "repo" });
          }
          await writeFile(join(dir, OPERATOR_DIR, layer, name), staged);
        }
      }
      await writeFile(join(dir, "capabilities.json"), await capabilitiesFile());
      return await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // `layers` ({ operator, repo }: name → text, either absent: not asked) on `input`, by one
  // `opa` → { operator, repo, error, errorLayer }: each asked layer's { allow, denies }:
  // `allow`, whether its `allow_<decision>` is true (null when not asked: the repo's, unless
  // `repoAllow`); `denies`, its `deny_<decision>`'s strings, as the rule gave them. `error`: why
  // they couldn't be evaluated, as a failure() says it, then nothing else; `errorLayer`, the
  // layer opa placed it in, null when it didn't.
  async function evaluateLayers(decision, layers, input, { repoAllow = false } = {}) {
    const rule = (pkg, name) => `[x | x := data.${pkg}.${name}_${decision}]`;
    const asks = {
      ...(layers.operator && { operator: { pkg: "deckhand", allow: true } }),
      ...(layers.repo && { repo: { pkg: `${REPO_NS}.deckhand`, allow: repoAllow } }),
    };
    const query = `{${Object.entries(asks)
      .map(
        ([layer, { pkg, allow }]) =>
          `"${layer}": {${allow ? `"allow": ${rule(pkg, "allow")}, ` : ""}"deny": ${rule(pkg, "deny")}}`,
      )
      .join(", ")}}`;
    const failed = (what, errorLayer = null) => ({ error: what, errorLayer });
    let res;
    try {
      res = await staged(layers, (cwd) =>
        run(
          [
            "eval",
            "--format=json",
            "--stdin-input",
            "--capabilities=capabilities.json",
            `--timeout=${TIMEOUT_MS}ms`,
            `--data=${OPERATOR_DIR}`,
            query,
          ],
          { input: JSON.stringify(input), cwd },
        ),
      );
    } catch (error) {
      // A repo file refused by namespaced() is the repo's; anything else (opa missing, its
      // capabilities, a temp folder) is no layer's.
      return failed(error.message ?? String(error), error.layer ?? null);
    }
    const late = `the \`${decision}\` rules took more than ${TIMEOUT_MS / 1000} s`;
    if (res.timedOut) return failed(late);
    if (res.code !== 0) {
      const { text, list, cancelled } = opaErrors(res.stdout, res.stderr);
      return failed(cancelled ? late : text, cancelled ? null : list[0].layer);
    }
    let value;
    try {
      value = JSON.parse(res.stdout).result?.[0]?.expressions?.[0]?.value;
    } catch {
      // Said below.
    }
    const said = { error: null, errorLayer: null };
    for (const [layer, { allow }] of Object.entries(asks)) {
      const got = value?.[layer];
      // Each rule's value, in a list: empty when no file defines it, or it is undefined.
      const listed = (v) => Array.isArray(v) && v.length <= 1;
      if (!listed(got?.deny) || (allow && !listed(got.allow))) {
        return failed("opa's answer can't be read");
      }
      const [allowed = false] = got.allow ?? [];
      const [denies = []] = got.deny;
      if (allow && typeof allowed !== "boolean") {
        return failed(`\`allow_${decision}\` must be true or false`, layer);
      }
      if (!Array.isArray(denies) || denies.some((m) => typeof m !== "string")) {
        return failed(`\`deny_${decision}\` must be a set of strings`, layer);
      }
      said[layer] = { allow: allow ? allowed : null, denies };
    }
    return said;
  }

  // The deny messages of the operator's layer `files` on `input` (allow_* left out), capped and
  // redacted; a failure is one "policy error: …" message. For the tests of a policy's text.
  async function evaluate(rule, files, input) {
    const said = await evaluateLayers(decisionOf(rule), { operator: files }, input);
    return said.error ? failure(said.error) : messages(said.operator.denies);
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
      onlyBuiltInAllowing(decision, layers.operator)
    ) {
      return { applied: false, messages: [] };
    }
    const result = await evaluated(rule, repo, layers, input);
    return { applied: result.asked, ...result };
  }

  // `rule`'s decision on the layers `layers` ({ operator, repo }: name → text), on the input
  // `input()` builds, version added → { messages, input, layers, asked, unread }: `layers`, each
  // evaluated layer's { layer, allow, denies, allowFiles, denyFiles, error } (`allow` null when
  // its allow rules aren't asked: a repo's, on a built-in mode's decision; the files, those that
  // define each rule, which decided); `asked`, whether an `opa` was asked or a rule refused;
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
    // Deckhand's files alone, allowing whatever the input: no need to ask them. One `opa` for
    // the rest, both layers in it when both have files.
    const skip = onlyBuiltInAllowing(decision, layers.operator);
    const asking = {
      ...(!skip && layers.operator.size && { operator: layers.operator }),
      ...(layers.repo.size && { repo: layers.repo }),
    };
    const got = Object.keys(asking).length
      ? await evaluateLayers(decision, asking, doc, { repoAllow: custom })
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
      return { asked, messages, input: doc, layers: said.map(shownLayer) };
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
  // evaluates, as { errors, warnings }. No files: nothing to say, and no `opa` call.
  async function check(files, layer = "operator") {
    const { errors, warnings } = await compile(files, layer);
    return { errors: errors.map((e) => e.text), warnings };
  }

  // check()'s work, each error as { layer, file, row, message, text }: file and row null when
  // opa doesn't give them (a timeout, a folder it can't stage), `text` what check() says of it.
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
      for (const rule of rulesOf(text)) {
        if (!RULES.includes(rule)) {
          warnings.push(
            `${name}: \`${rule}\` isn't a rule Deckhand evaluates (${RULES.map((r) => `\`${r}\``).join(", ")})`,
          );
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
    // A repo file namespaced() refuses: said at its line, the others checked without it.
    const staging = new Map(files);
    if (layer === "repo") {
      for (const [name, text] of files) {
        const why = namespaceRefusal(name, text);
        if (!why) continue;
        errors.push({ ...placed(name, why.row, why.message), text: failure(why.message)[0] });
        staging.delete(name);
      }
    }
    const unplaced = (text, message = text) => ({ layer, file: null, row: null, message, text });
    try {
      const res = await staged({ [layer]: staging }, (cwd) =>
        run(["check", "--format=json", "--capabilities=capabilities.json", OPERATOR_DIR], { cwd }),
      );
      if (res.timedOut) errors.push(unplaced(`the policies' check took too long`));
      else if (res.code !== 0) {
        for (const e of opaErrors(res.stdout, res.stderr).list) {
          errors.push({ ...e, layer, message: line(e.message), text: failure(located(e))[0] });
        }
      }
    } catch (error) {
      const what = error.message ?? String(error);
      errors.push(unplaced(failure(what)[0], line(what)));
    }
    return { errors, warnings };
  }

  // A review.rego of the operator's that replaces Deckhand's and never names `author_type`:
  // other bots' pull requests, which the default skips, are reviewed now, at the operator's cost.
  // Said, as a file of that name written before the default (wip labels, docs only) drops it
  // unseen. A file that names it, a comment saying so will do, decided. `text`: the file's.
  // → the warning, or null.
  function botsReviewed(text) {
    let own = null;
    try {
      own = ownDefaults().get(BOT_REVIEWS);
    } catch {
      // Deckhand's can't be read: describe() says so.
    }
    if (text === undefined || !own || text === own || /\bauthor_type\b/.test(text)) return null;
    return `The grants folder's policy/${BOT_REVIEWS} replaces Deckhand's default without a rule on \`input.pr.author_type\`: other bots' ready pull requests (Dependabot's, GitHub Actions') are reviewed by themselves in every repository. To keep them skipped, copy the default's rule into it; to say they should be reviewed, name \`author_type\` in a comment there`;
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

  // The operator's policies over Deckhand's, checked: errors to say at start. None: no `opa`
  // call.
  async function checkOperator() {
    try {
      const operator = readOperator();
      const checked = await check(defaults());
      const bots = botsReviewed(operator.get(BOT_REVIEWS));
      return bots ? { ...checked, warnings: [...checked.warnings, bots] } : checked;
    } catch (error) {
      return { errors: [error.message ?? String(error)], warnings: [] };
    }
  }

  // A repo's policies on `ref` (a branch), checked on their own, as they are evaluated: what
  // the onboarding pull request's reply says (onboarding.mjs branchConfigReport()).
  async function checkRepo(repo, ref) {
    const own = await repoPolicies(repo, ref);
    if (!own.size) return { errors: [], warnings: [] };
    let under = new Map();
    try {
      under = defaults();
    } catch {
      // Said at start: the repo's own are what this check is about.
    }
    const checked = await check(own, "repo");
    return { ...checked, warnings: [...checked.warnings, ...shadowing(own, under)] };
  }

  // What applies on `repo` (its policies on `ref`, its default branch, read now), for the
  // dashboard's config panel and `/mode policy`: { files: [{ name, source, replaces, active,
  // rules, url, text, truncated }], errors, warnings, policies }, Deckhand's files first
  // ("deckhand"), then the operator's, then the repo's. In the operator's layer, a file
  // `replaces` Deckhand's of its name ("deckhand"; null for none), listed too, not `active`:
  // nothing evaluates it; a repo's file replaces nothing. `text`: the file's, redacted and cut at
  // MAX_TEXT (`truncated`). `errors`: compile()'s of each layer's active files, and why the
  // operator's can't be read (every decision refuses then). `policies`: { operator, repo }, each
  // name → text, what decide() would evaluate. No policy anywhere: no `opa` call.
  async function describe(repo, ref) {
    const errors = [];
    const said = (text) => errors.push({ layer: null, file: null, row: null, message: text, text });
    let deckhand = [];
    let operator = [];
    try {
      deckhand = entries("deckhand", ownDefaults());
    } catch (error) {
      said(`Deckhand's policies can't be read: ${error.message ?? error}`);
    }
    try {
      operator = entries("operator", readOperator());
    } catch (error) {
      said(`the operator's policies can't be read: ${error.message ?? error}`);
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
    return {
      files: files.map(({ text, ...f }) => ({ ...f, rules: rulesOf(text), ...shown(text) })),
      errors: [...errors, ...up.errors, ...down.errors],
      warnings: [
        ...up.warnings,
        ...down.warnings,
        ...shadowing(policies.repo, policies.operator),
        ...(bots ? [bots] : []),
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

  // `repo`'s default branch moved (a push, a merge: repos.mjs refreshFor()): its policies are
  // listed again at the next decision.
  function forget(repo) {
    listings.delete(repo.toLowerCase());
  }

  return {
    deny,
    decide,
    denied,
    evaluated,
    describe,
    evaluate,
    check,
    checkOperator,
    checkRepo,
    repoPolicies,
    policiesFor,
    deckhandOnly,
    forget,
  };
}
