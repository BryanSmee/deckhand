// Rules as code (issue #292): Rego policies that can only add refusals after the listener's
// built-in gates, evaluated by the pinned `opa` binary (listener/Dockerfile), one process per
// decision. The operator's defaults are GRANTS_DIR/policy/*.rego, read again at each decision
// like the grants; a repo's are .deckhand/policy/*.rego on its default branch, like its
// .deckhand.yaml. A repo file with the same name as an operator file replaces it, any other
// name adds rules. Each decision is a set rule of package `deckhand` (`deny_merge`), whose
// strings are the reasons shown to the maintainer.
//
// Isolation: the policies are code a repo's maintainers write, and the listener holds the
// Docker socket and the App's key. `opa` runs with an empty environment, under a timeout, and
// with a capabilities file without the builtins that read the environment, the network or
// files (opa.runtime, http.send, net.*, the JSON schema ones) or trace. Fail closed: a policy that doesn't compile, times
// out or returns anything but a set of strings denies, with that reason. Format:
// ../docs/repo-config.md#policies; trust: ../docs/security.md#policies.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { getJson } from "./github.mjs";
import { redact } from "./redact.mjs";

// Where a repo's policies are, on its default branch, and the operator's, in GRANTS_DIR.
export const POLICY_DIR = ".deckhand/policy";
const OPERATOR_DIR = "policy";

// The rules the listener evaluates: another `deny_*` rule is a mistake the config check says.
export const RULES = ["deny_merge"];

// What the input looks like (docs/repo-config.md#the-merge-input): a policy can check it.
export const INPUT_VERSION = 1;

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

// The `deny_*` rules a file defines at the start of a line, in package `deckhand`: what the
// config check compares with RULES. A rule written otherwise is only missed by the check.
export function deniesOf(text) {
  if (!/^\s*package\s+deckhand\s*$/m.test(text)) return [];
  return [...new Set([...text.matchAll(/^(deny_\w*)\b/gm)].map((m) => m[1]))];
}

// `opa`'s errors (its JSON output, on stdout for `eval` and stderr for `check`) → { text, one
// line with each file's own name, cancelled: whether `eval` stopped at its --timeout }.
function opaErrors(stdout, stderr) {
  for (const out of [stdout, stderr]) {
    let errors;
    try {
      ({ errors } = JSON.parse(out));
    } catch {
      continue;
    }
    if (Array.isArray(errors) && errors.length) {
      const text = errors
        .slice(0, 3)
        .map((e) => {
          const file = e.location?.file?.replace(/^.*\//, "");
          const at = file ? `${file}:${e.location.row ?? "?"}: ` : "";
          return `${at}${e.message ?? e.code ?? "error"}`;
        })
        .join("; ");
      return { text, cancelled: errors.some((e) => e.code === "eval_cancel_error") };
    }
  }
  return { text: (stderr || stdout || "opa failed").trim().split("\n")[0], cancelled: false };
}

// How long a repo's listing of POLICY_DIR is kept: a push to its default branch forgets it
// sooner (forget()), so this only bounds a push whose webhook never came.
const LISTING_MS = 10 * 60_000;

// `github`: the App's calls; `run(args, { input, cwd })`: opaRunner()'s; `secrets()`: what
// redaction hides of the messages (secrets.mjs); `readOperator()`: the operator's policies
// (operatorPolicies()); `tmp`: where each decision's files go; `now`: the clock, for listings.
export function createPolicies({
  config,
  github,
  run = opaRunner(),
  secrets = () => [],
  readOperator = () => operatorPolicies(config),
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

  async function listing(repo, ref, cached) {
    const key = repo.toLowerCase();
    const kept = listings.get(key);
    if (cached && kept?.ref === ref && now() - kept.at < LISTING_MS) return kept.listed;
    const listed = await getJson(
      github,
      repo,
      `/repos/${repo}/contents/${POLICY_DIR}?ref=${encodeURIComponent(ref)}`,
      [404],
    );
    if (cached) listings.set(key, { ref, at: now(), listed });
    return listed;
  }

  // A repo's policies on `ref`, name → text: its listing (`cached`: the default branch's, kept
  // until it moves), then the files not seen yet.
  async function repoPolicies(repo, ref, { cached = false } = {}) {
    const files = new Map();
    const listed = await listing(repo, ref, cached);
    if (!Array.isArray(listed)) return files;
    for (const entry of listed) {
      if (entry.type !== "file" || !FILE.test(entry.name)) continue;
      if (!blobs.has(entry.sha)) {
        const blob = await getJson(github, repo, `/repos/${repo}/git/blobs/${entry.sha}`);
        if (blobs.size >= MAX_BLOBS) blobs.delete(blobs.keys().next().value);
        blobs.set(entry.sha, Buffer.from(blob.content ?? "", blob.encoding ?? "base64").toString());
      }
      files.set(entry.name, blobs.get(entry.sha));
    }
    return files;
  }

  // The operator's policies with the repo's over them, by file name. Empty: nothing applies.
  async function policiesFor(repo, ref) {
    return new Map([...readOperator(), ...(await repoPolicies(repo, ref, { cached: true }))]);
  }

  async function capabilitiesFile() {
    if (capabilities) return capabilities;
    const res = await run(["capabilities", "--current"], {});
    if (res.code !== 0)
      throw new Error(`opa capabilities: ${opaErrors(res.stdout, res.stderr).text}`);
    capabilities = JSON.stringify(restrictedCapabilities(res.stdout));
    return capabilities;
  }

  // `files` and the capabilities in a temp dir for `use(dir)`, removed after.
  async function staged(files, use) {
    const dir = await mkdtemp(join(tmp, "deckhand-policy-"));
    try {
      await mkdir(join(dir, OPERATOR_DIR));
      for (const [name, text] of files) await writeFile(join(dir, OPERATOR_DIR, name), text);
      await writeFile(join(dir, "capabilities.json"), await capabilitiesFile());
      return await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // `rule` of `files` on `input` → its messages, capped and redacted; a failure is one
  // "policy error: …" message.
  async function evaluate(rule, files, input) {
    let res;
    try {
      res = await staged(files, (cwd) =>
        run(
          [
            "eval",
            "--format=json",
            "--stdin-input",
            "--capabilities=capabilities.json",
            `--timeout=${TIMEOUT_MS}ms`,
            `--data=${OPERATOR_DIR}`,
            `data.deckhand.${rule}`,
          ],
          { input: JSON.stringify(input), cwd },
        ),
      );
    } catch (error) {
      return failure(error.message ?? String(error));
    }
    const late = `\`${rule}\` took more than ${TIMEOUT_MS / 1000} s`;
    if (res.timedOut) return failure(late);
    if (res.code !== 0) {
      const { text, cancelled } = opaErrors(res.stdout, res.stderr);
      return failure(cancelled ? late : text);
    }
    let value;
    try {
      const out = JSON.parse(res.stdout);
      // Undefined: no file defines the rule, nothing denies.
      if (!out.result?.length) return [];
      value = out.result[0].expressions?.[0]?.value;
    } catch {
      return failure("opa's answer can't be read");
    }
    if (!Array.isArray(value) || value.some((m) => typeof m !== "string")) {
      return failure(`\`${rule}\` must be a set of strings`);
    }
    return messages(value);
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

  // Why `rule` refuses on `repo` (its policies on `ref`, its default branch): the messages, or
  // [] when nothing denies. `input()` builds the input, called only when a policy applies (it may
  // read GitHub). Fail closed: an error reading the policies is a denial too.
  async function deny(rule, repo, ref, input) {
    let files;
    try {
      files = await policiesFor(repo, ref);
    } catch (error) {
      log(`${repo}: reading its policies: ${error.message ?? error}`);
      return failure(`the policies can't be read (${error.message ?? error})`);
    }
    if (!files.size) return [];
    let doc;
    try {
      doc = { version: INPUT_VERSION, ...(await input()) };
    } catch (error) {
      log(`${repo}: the ${rule} input: ${error.message ?? error}`);
      return failure(`its input can't be built (${error.message ?? error})`);
    }
    const denied = await evaluate(rule, files, doc);
    if (denied.length) log(`${repo}: ${rule} denies: ${denied.join(" | ")}`);
    return denied;
  }

  // The config check of `files` (name → text): compile errors and rules nobody evaluates, as
  // { errors, warnings }. No files: nothing to say, and no `opa` call.
  async function check(files) {
    const errors = [];
    const warnings = [];
    if (!files.size) return { errors, warnings };
    for (const [name, text] of files) {
      for (const rule of deniesOf(text)) {
        if (!RULES.includes(rule)) {
          warnings.push(
            `${name}: \`${rule}\` isn't a rule Deckhand evaluates (${RULES.map((r) => `\`${r}\``).join(", ")})`,
          );
        }
      }
    }
    try {
      const res = await staged(files, (cwd) =>
        run(["check", "--format=json", "--capabilities=capabilities.json", OPERATOR_DIR], { cwd }),
      );
      if (res.timedOut) errors.push(`the policies' check took too long`);
      else if (res.code !== 0) errors.push(...failure(opaErrors(res.stdout, res.stderr).text));
    } catch (error) {
      errors.push(...failure(error.message ?? error));
    }
    return { errors, warnings };
  }

  // The operator's policies, checked: errors to say at start. None: no `opa` call.
  async function checkOperator() {
    try {
      return await check(readOperator());
    } catch (error) {
      return { errors: [error.message ?? String(error)], warnings: [] };
    }
  }

  // A repo's policies on `ref` (a branch), checked, operator's included: what the onboarding
  // pull request's reply says (onboarding.mjs branchConfigReport()).
  async function checkRepo(repo, ref) {
    const own = await repoPolicies(repo, ref);
    if (!own.size) return { errors: [], warnings: [] };
    let operator = new Map();
    try {
      operator = readOperator();
    } catch {
      // Said at start: the repo's own are what this check is about.
    }
    return check(new Map([...operator, ...own]));
  }

  // `repo`'s default branch moved (a push, a merge: repos.mjs refreshFor()): its policies are
  // listed again at the next decision.
  function forget(repo) {
    listings.delete(repo.toLowerCase());
  }

  return { deny, evaluate, check, checkOperator, checkRepo, repoPolicies, policiesFor, forget };
}
