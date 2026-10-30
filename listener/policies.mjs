// Rules as code (issue #292): Rego policies that can only add refusals after the listener's
// built-in gates, evaluated by the pinned `opa` binary (listener/Dockerfile), one process per
// decision. Three layers, by file name: Deckhand's own defaults (BUILT_IN_DIR, in the image:
// issue #448), the operator's, GRANTS_DIR/policy/*.rego, read again at each decision like the
// grants, and a repo's, .deckhand/policy/*.rego on its default branch, like its .deckhand.yaml.
// A file with the same name as one of a layer below replaces it, any other name adds rules. Each decision is a set rule of package `deckhand` (`deny_merge`,
// `deny_review`, `deny_fix`, and `deny_github` for a run's GitHub writes: github-writes.mjs),
// whose strings are the reasons shown to the maintainer (or the run, for `deny_github`).
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
import { fileURLToPath } from "node:url";
import { getJson } from "./github.mjs";
import { redact } from "./redact.mjs";

// Where a repo's policies are, on its default branch, and the operator's, in GRANTS_DIR.
export const POLICY_DIR = ".deckhand/policy";
const OPERATOR_DIR = "policy";
// Deckhand's own defaults (../policy/, copied into the image at the same relative path): one
// file per `gh` feature (gh-<feature>.rego) and github.rego, which narrow the modes' ceilings to
// what the prompts ask for. Without the operator's setup: they hold unless replaced.
export const BUILT_IN_DIR = fileURLToPath(new URL("../policy/", import.meta.url));

// The rules the listener evaluates: another `deny_*` rule is a mistake the config check says.
export const RULES = ["deny_merge", "deny_review", "deny_fix", "deny_github"];

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

// The `deny_*` rules a file defines at the start of a line, in package `deckhand`: what the
// config check compares with RULES. A rule written otherwise is only missed by the check.
export function deniesOf(text) {
  if (!/^\s*package\s+deckhand\s*$/m.test(text)) return [];
  return [...new Set([...text.matchAll(/^(deny_\w*)\b/gm)].map((m) => m[1]))];
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
        row: Number.isInteger(e.location?.row) ? e.location.row : null,
        message: String(e.message ?? e.code ?? "error"),
      }));
      const text = list.slice(0, 3).map(located).join("; ");
      return { text, list, cancelled: errors.some((e) => e.code === "eval_cancel_error") };
    }
  }
  const text = (stderr || stdout || "opa failed").trim().split("\n")[0];
  return { text, list: [{ file: null, row: null, message: text }], cancelled: false };
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
// (operatorPolicies()); `readBuiltIn()`: Deckhand's own (builtInPolicies(), none by default:
// server.mjs passes them); `tmp`: where each decision's files go; `now`: the clock, for
// listings.
export function createPolicies({
  config,
  github,
  run = opaRunner(),
  secrets = () => [],
  readOperator = () => operatorPolicies(config),
  readBuiltIn = () => new Map(),
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
  const ownDefaults = () => (builtIn ??= readBuiltIn());
  // The defaults under the operator's: name → text.
  const defaults = () => new Map([...ownDefaults(), ...readOperator()]);

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

  // A repo's policy files on `ref`, [{ name, url, text }]: its listing (`cached`: the default
  // branch's, kept until it moves), then the files not seen yet.
  async function repoFiles(repo, ref, cached) {
    const files = [];
    const listed = await listing(repo, ref, cached);
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
  async function repoPolicies(repo, ref, { cached = false } = {}) {
    return new Map((await repoFiles(repo, ref, cached)).map((f) => [f.name, f.text]));
  }

  // Deckhand's policies, the operator's over them, then the repo's, by file name. Empty: nothing
  // applies.
  async function policiesFor(repo, ref) {
    return new Map([...defaults(), ...(await repoPolicies(repo, ref, { cached: true }))]);
  }

  // Whether `files` hold only Deckhand's own policies, none of them defining `rule`: then
  // nothing would deny it, and no policy is asked (no `opa` call, no decision kept), as when
  // there is none. Deckhand's files are known: deniesOf() reads them right.
  function onlyBuiltInWithout(rule, files) {
    const own = ownDefaults();
    return [...files].every(
      ([name, text]) => own.get(name) === text && !deniesOf(text).includes(rule),
    );
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
    return (await decide(rule, repo, ref, input)).messages;
  }

  // deny()'s work → { applied, messages, input }: `applied`, whether any policy was asked (none
  // anywhere: false, and nothing for the task's page to show); `input`, the document the rules
  // saw, when it could be built (decisions.mjs keeps it, redacted).
  async function decide(rule, repo, ref, input) {
    let files;
    try {
      files = await policiesFor(repo, ref);
    } catch (error) {
      log(`${repo}: reading its policies: ${error.message ?? error}`);
      return {
        applied: true,
        messages: failure(`the policies can't be read (${error.message ?? error})`),
      };
    }
    if (!files.size || onlyBuiltInWithout(rule, files)) return { applied: false, messages: [] };
    return { applied: true, ...(await evaluated(rule, repo, files, input)) };
  }

  // `rule` of `files` on the input `input()` builds, version added → its messages, logged.
  async function denied(rule, repo, files, input) {
    return (await evaluated(rule, repo, files, input)).messages;
  }

  // denied()'s work → { messages, input }: `input`, the document evaluated, absent when it
  // couldn't be built.
  async function evaluated(rule, repo, files, input) {
    let doc;
    try {
      doc = { version: INPUT_VERSION, ...(await input()) };
    } catch (error) {
      log(`${repo}: the ${rule} input: ${error.message ?? error}`);
      return { messages: failure(`its input can't be built (${error.message ?? error})`) };
    }
    const messages = await evaluate(rule, files, doc);
    if (messages.length) log(`${repo}: ${rule} denies: ${messages.join(" | ")}`);
    return { messages, input: doc };
  }

  // The config check of `files` (name → text): compile errors and rules nobody evaluates, as
  // { errors, warnings }. No files: nothing to say, and no `opa` call.
  async function check(files) {
    const { errors, warnings } = await compile(files);
    return { errors: errors.map((e) => e.text), warnings };
  }

  // check()'s work, each error as { file, row, message, text }: file and row null when opa
  // doesn't give them (a timeout, a folder it can't stage), `text` what check() says of it.
  async function compile(files) {
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
    const unplaced = (text, message = text) => ({ file: null, row: null, message, text });
    try {
      const res = await staged(files, (cwd) =>
        run(["check", "--format=json", "--capabilities=capabilities.json", OPERATOR_DIR], { cwd }),
      );
      if (res.timedOut) errors.push(unplaced(`the policies' check took too long`));
      else if (res.code !== 0) {
        for (const e of opaErrors(res.stdout, res.stderr).list) {
          errors.push({ ...e, message: line(e.message), text: failure(located(e))[0] });
        }
      }
    } catch (error) {
      const what = error.message ?? String(error);
      errors.push(unplaced(failure(what)[0], line(what)));
    }
    return { errors, warnings };
  }

  // The operator's policies over Deckhand's, checked: errors to say at start. None: no `opa`
  // call.
  async function checkOperator() {
    try {
      return await check(defaults());
    } catch (error) {
      return { errors: [error.message ?? String(error)], warnings: [] };
    }
  }

  // A repo's policies on `ref` (a branch), checked, the defaults included: what the onboarding
  // pull request's reply says (onboarding.mjs branchConfigReport()).
  async function checkRepo(repo, ref) {
    const own = await repoPolicies(repo, ref);
    if (!own.size) return { errors: [], warnings: [] };
    let under = new Map();
    try {
      under = defaults();
    } catch {
      // Said at start: the repo's own are what this check is about.
    }
    return check(new Map([...under, ...own]));
  }

  // What applies on `repo` (its policies on `ref`, its default branch, read now), for the
  // dashboard's config panel and `/mode policy`: { files: [{ name, source, replaces, active,
  // rules, url, text, truncated }], errors, warnings }, Deckhand's files first ("deckhand"),
  // then the operator's, then the repo's. A file `replaces` one of a layer below with its name
  // (that layer's source, the nearest; null for none), listed too, not `active`: deny() doesn't evaluate it. `text`: the file's, redacted and cut at
  // MAX_TEXT (`truncated`). `errors`: compile()'s of the active files, and why the operator's
  // can't be read (every decision refuses then). `policies`: name → text, what deny() would
  // evaluate. No policy anywhere: no `opa` call.
  async function describe(repo, ref) {
    const errors = [];
    const layers = [];
    const said = (text) => errors.push({ file: null, row: null, message: text, text });
    try {
      layers.push(entries("deckhand", ownDefaults()));
    } catch (error) {
      said(`Deckhand's policies can't be read: ${error.message ?? error}`);
    }
    try {
      layers.push(entries("operator", readOperator()));
    } catch (error) {
      said(`the operator's policies can't be read: ${error.message ?? error}`);
    }
    layers.push(
      await repoFiles(repo, ref, false).then((own) => own.map((f) => ({ ...f, source: "repo" }))),
    );
    const has = (layer, name) => layer.some((f) => f.name === name);
    const files = layers.flatMap((layer, i) =>
      layer.map((f) => ({
        ...f,
        replaces: layers.slice(0, i).findLast((below) => has(below, f.name))?.[0].source ?? null,
        active: !layers.slice(i + 1).some((above) => has(above, f.name)),
      })),
    );
    const policies = new Map(files.filter((f) => f.active).map((f) => [f.name, f.text]));
    const checked = await compile(policies);
    return {
      files: files.map(({ text, ...f }) => ({ ...f, rules: deniesOf(text), ...shown(text) })),
      errors: [...errors, ...checked.errors],
      warnings: checked.warnings,
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
    describe,
    evaluate,
    check,
    checkOperator,
    checkRepo,
    repoPolicies,
    policiesFor,
    forget,
  };
}
