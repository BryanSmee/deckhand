// The policy service's engine (#501): evaluates the decisions and checks the policies the callers
// ask about (service.mjs), with long-lived `opa` servers (opa.mjs) in place of a process per
// decision. What a decision means, its input and what is said of it stay the callers'
// (../listener/policies.mjs); this holds the policies and asks opa.
//
// Two layers, each in a namespace of its own so that neither's files can define or break the
// other's rules (namespaced()): the operator's, Deckhand's own defaults (BUILT_IN_DIR, in the
// image) under GRANTS_DIR/policy/*.rego (mounted read-only, read again at each decision), a file
// with the same name replacing a default; and a repository's, which the caller sends with each
// request (this service has no network to read GitHub).
//
// Each policy set (the operator's layer, with or without one repository's) is loaded whole into
// a server of its own at its start, so a set never changes under a decision and one
// repository's files never sit beside another's. The servers are kept while used, MAX_SERVERS at
// most (the least recently used one stops first): a repository without policies shares the
// operator's alone, and an edit of the operator's starts a new one.
//
// Isolation: the policies are code a repository's maintainers write. `opa run` takes no
// capabilities file, so a set is first compiled with `opa check` and a capabilities file without
// the builtins that read the environment, the network or files (opa.runtime, http.send, net.*,
// the JSON schema ones) or trace, and only a set that passes is served: a policy that uses one
// is refused at load. The service holds no secret, has no network but its callers', and opa
// runs with an empty environment. Fail closed: a set that doesn't compile, a decision over
// TIMEOUT_MS or a rule of the wrong type gives an error, which the caller refuses with.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BY_FILE_NAME,
  byFile,
  FILE,
  layerDigest,
  operatorPolicies,
  UNION_DIR,
  UNION_FILE,
} from "../lib/policy-files.mjs";
import { opaBinary } from "./opa.mjs";

// Where they were first: the tests import them from here.
export { FILE, layerDigest, operatorPolicies };

// Where the operator's policies are in GRANTS_DIR, and where a set's layers are staged.
const OPERATOR_DIR = "policy";
// Deckhand's own defaults (../policy/, copied into the image at the same relative path).
export const BUILT_IN_DIR = fileURLToPath(new URL("../policy/", import.meta.url));

// One decision's evaluation, once its set is loaded: long enough for any reasonable policy, short
// enough that a loop in one doesn't hold a merge decision for long. The query is cut then, which
// cancels it in opa.
export const TIMEOUT_MS = 2000;

// The inputs one capabilities() call evaluates: a run's one, or a config page's modes.
export const MAX_INPUTS = 64;

// The servers kept at once: each is one policy set, about 40 MB.
export const MAX_SERVERS = 8;
// The sets whose compile check is remembered (a broken one isn't checked again at each decision).
const MAX_CHECKED = 500;

// A decision's name, as it goes into the query: `merge`, `link_branch`.
const DECISION = /^[a-z][a-z_]*$/;

// The builtins a policy can't call: the environment (opa.runtime), the network (http.send,
// net.lookup_ip_addr and the rest of net.*, pure as most are: one rule, easy to read), the
// service's files (json.match_schema and json.verify_schema follow a schema's `$ref` to a
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

// Deckhand's allow rules (policy/allow.rego): every decision allowed unless a deny rule says
// otherwise. Its name, and its file alone, which tests build on.
export const ALLOW = "allow.rego";
export const allowOnly = (dir = BUILT_IN_DIR) =>
  new Map([[ALLOW, readFileSync(join(dir, ALLOW), "utf8")]]);

// Deckhand's own policies: `dir`'s *.rego, name → text, read once by createEngine(). No
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

// Where a repository's packages go in a set: under this, which no package of the operator's or
// Deckhand's is.
export const REPO_NS = "deckhand_repository";

// A repo file's `text` with its package moved under REPO_NS, so that it can neither define nor
// replace a rule of the operator's packages, whatever it declares: Rego's first statement is
// the package (after comments), and every rule a module defines is in it. Its `data.`
// references go there too, so that a repo's libraries still resolve: `data` as a term only, never
// in a string, a raw string or a comment, nor after a dot or a word (`"db/data.sql"`,
// `input.x.data.id` stay as they are). One written otherwise (`data["lib"]`) only reads the
// operator's, which widens nothing: its set holds no other repository's. null, refused rather
// than guessed (namespaceRefusal() says why): no package where the parser reads it (a `package`
// keyword on a line of its own, a byte-order mark), or a template string (`$"…{expr}…"`), whose
// expressions this doesn't read.
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

// How many of `opa`'s errors are kept: its own default for `check` (--max-errors).
const MAX_ERRORS = 10;

// `opa`'s errors (its JSON output: `check`'s on stderr, a server's answer) → { text, one line
// with each file's own name, list: each error's { file, layer, row, message }, file and row null
// when opa gives none, cancelled: whether the evaluation was cancelled, parsed: whether opa said
// them as JSON (else its output's first line, opa failing rather than the policies) }.
export function opaErrors(stdout, stderr = "") {
  for (const out of [stdout, stderr]) {
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      continue;
    }
    // A server's answer: its errors, else its one message (an evaluation's error).
    const errors = parsed?.errors?.length
      ? parsed.errors
      : typeof parsed?.message === "string"
        ? [{ code: parsed.code, message: parsed.message }]
        : null;
    if (Array.isArray(errors) && errors.length) {
      const list = errors.slice(0, MAX_ERRORS).map((e) => {
        const path = e.location?.file ?? "";
        // The union byFile() wrote (stage()) only reads the files' rules: an error there is one
        // of theirs that isn't a set.
        const union = new RegExp(
          `(?:^|/)${OPERATOR_DIR}/(operator|repo)/${UNION_DIR}/${UNION_FILE.replace(".", "\\.")}$`,
        );
        const inUnion = union.exec(path);
        if (inUnion) {
          return {
            file: null,
            // Its folder, not anything else of the path: the temp folder may hold `/repo/`.
            layer: inUnion[1],
            row: null,
            message: "`allow_capabilities` and `deny_capabilities` must be sets (`contains` rules)",
          };
        }
        return {
          file: path.replace(/^.*\//, "") || null,
          // The layer whose folder the file was staged in (stage()), when opa placed it.
          layer: /(?:^|\/)repo\/[^/]+$/.test(path)
            ? "repo"
            : /(?:^|\/)operator\/[^/]+$/.test(path)
              ? "operator"
              : null,
          row: Number.isInteger(e.location?.row) ? e.location.row : null,
          // A repo's packages and the capabilities' rules as its files name them, not
          // namespaced() or byFile().
          message: String(e.message ?? e.code ?? "error")
            .replaceAll(`${REPO_NS}.`, "")
            .replace(BY_FILE_NAME, "$1"),
        };
      });
      const text = list.slice(0, 3).map(located).join("; ");
      return {
        text,
        list,
        cancelled: errors.some((e) => e.code === "eval_cancel_error"),
        parsed: true,
      };
    }
  }
  const text = (stderr || stdout || "opa failed").trim().split("\n")[0];
  return {
    text,
    list: [{ file: null, layer: null, row: null, message: text }],
    cancelled: false,
    parsed: false,
  };
}

// An error of opaErrors()'s list as one line: `file:row: message`.
export const located = ({ file, row, message }) =>
  `${file ? `${file}:${row ?? "?"}: ` : ""}${message}`;

// `entries` ([[name, text]], as a request sends them) → name → text; a name that isn't a policy
// file's throws.
function filesOf(entries, what) {
  if (!Array.isArray(entries)) throw new Error(`${what}: expected [[name, text]]`);
  const files = new Map();
  for (const entry of entries) {
    const [name, text] = Array.isArray(entry) ? entry : [];
    if (typeof name !== "string" || !FILE.test(name) || typeof text !== "string") {
      throw new Error(`${what}: ${JSON.stringify(name)} isn't a policy file`);
    }
    files.set(name, text);
  }
  return files;
}

// `opa`: the binary's two uses (opa.mjs opaBinary(), a fake in the tests); `grantsDir`: the
// operator's folder (GRANTS_DIR); `readOperator()`: its policies (operatorPolicies());
// `readBuiltIn()`: Deckhand's own (builtInPolicies()), read once; `tmp`: where each set is staged
// while its server runs; `maxServers`: the servers kept.
export function createEngine({
  opa = opaBinary(),
  grantsDir = null,
  readOperator = () => operatorPolicies(grantsDir),
  readBuiltIn = () => builtInPolicies(),
  tmp = tmpdir(),
  maxServers = MAX_SERVERS,
  timeoutMs = TIMEOUT_MS,
  log = () => {},
}) {
  // restrictedCapabilities() of the binary, once it answered.
  let capabilities = null;
  // Deckhand's own policies, read once: they are part of the image.
  let builtIn = null;
  const ownDefaults = () => (builtIn ??= readBuiltIn());
  // The operator's layer: Deckhand's, the operator's over them by file name.
  const operatorLayer = () => new Map([...ownDefaults(), ...readOperator()]);
  // digest → { ready: Promise<server | { error, errorLayer }>, users, used }, in use order.
  const servers = new Map();
  // digest → a failed check's { error, errorLayer }, so a broken set isn't checked again.
  const failedChecks = new Map();
  let stopped = false;

  async function capabilitiesFile() {
    if (capabilities) return capabilities;
    const res = await opa.run(["capabilities", "--current"], {});
    if (res.code !== 0)
      throw new Error(`opa capabilities: ${opaErrors(res.stdout, res.stderr).text}`);
    capabilities = JSON.stringify(restrictedCapabilities(res.stdout));
    return capabilities;
  }

  // `layers` ({ operator, repo }, each name → text, either absent) and the capabilities in a new
  // temp folder → its path: each layer in a folder of its own under OPERATOR_DIR (opa's errors
  // say which: opaErrors()), the repo's namespaced(), each file's capabilities' rules renamed
  // apart with their union beside them (byFile(): evaluateCapabilities() says which file gave
  // what, every
  // other rule sees them whole). A repo file that can't be throws, its `layer` "repo", and
  // nothing is left.
  async function stage(layers) {
    const dir = await mkdtemp(join(tmp, "deckhand-policy-"));
    try {
      for (const [layer, files] of Object.entries(layers)) {
        if (!files) continue;
        await mkdir(join(dir, OPERATOR_DIR, layer), { recursive: true });
        const { texts, union } = byFile(files);
        for (const [name, text] of texts) {
          const staged = layer === "repo" ? namespaced(text) : text;
          if (staged === null) {
            const { message } = namespaceRefusal(name, files.get(name));
            throw Object.assign(new Error(message), { layer: "repo" });
          }
          await writeFile(join(dir, OPERATOR_DIR, layer, name), staged);
        }
        if (union) {
          await mkdir(join(dir, OPERATOR_DIR, layer, UNION_DIR));
          const text = layer === "repo" ? namespaced(union) : union;
          await writeFile(join(dir, OPERATOR_DIR, layer, UNION_DIR, UNION_FILE), text);
        }
      }
      await writeFile(join(dir, "capabilities.json"), await capabilitiesFile());
      return dir;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  // `opa check` of the staged folder `dir` with the restricted capabilities → {}, { errors }
  // (opaErrors()'s), { timedOut } or { failed }.
  async function checked(dir) {
    const res = await opa.run(
      ["check", "--format=json", "--capabilities=capabilities.json", OPERATOR_DIR],
      { cwd: dir },
    );
    if (res.timedOut) return { timedOut: true };
    if (res.code === 0) return {};
    // Compile errors: opa exited on its own, saying them as JSON. Anything else (killed by a
    // signal, not started, a flag it doesn't know) is opa failing, not the files: never
    // remembered as theirs.
    const errors = opaErrors(res.stdout, res.stderr);
    if (res.code > 0 && errors.parsed) return { errors };
    return { failed: new Error(errors.text) };
  }

  // A set's identity: its layers' staged files, whatever their order.
  const digestOf = (layers) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(layers).map(([layer, files]) => [
            layer,
            [...files].sort(([a], [b]) => a.localeCompare(b)),
          ]),
        ),
      )
      .digest("hex");

  // The server of `layers` (`digest`), started when there is none: checked first, then served.
  // → the server, or { error, errorLayer } when the set doesn't compile or opa doesn't start.
  async function start(digest, layers, entry) {
    const known = failedChecks.get(digest);
    if (known) return known;
    let dir;
    try {
      dir = await stage(layers);
    } catch (error) {
      return { error: error.message ?? String(error), errorLayer: error.layer ?? null };
    }
    const remove = () => rm(dir, { recursive: true, force: true });
    const check = await checked(dir).catch((error) => ({ failed: error }));
    if (check.timedOut || check.errors || check.failed) {
      await remove();
      if (check.failed) {
        return { error: check.failed.message ?? String(check.failed), errorLayer: null };
      }
      if (check.timedOut) return { error: "the policies' check took too long", errorLayer: null };
      // A compile error stays one until the files change: remembered.
      const failed = { error: check.errors.text, errorLayer: check.errors.list[0].layer };
      if (failedChecks.size >= MAX_CHECKED) failedChecks.delete(failedChecks.keys().next().value);
      failedChecks.set(digest, failed);
      return failed;
    }
    try {
      const server = await opa.serve(dir, join(dir, OPERATOR_DIR));
      // Its folder goes with it; gone (stopped, or opa died), the next decision starts it again.
      const removed = server.exited.then(() => {
        if (servers.get(digest) === entry) servers.delete(digest);
        return remove();
      });
      return { ...server, stop: () => server.stop().then(() => removed) };
    } catch (error) {
      await remove();
      log(`opa didn't start: ${error.message ?? error}`);
      return { error: `opa didn't start (${error.message ?? error})`, errorLayer: null };
    }
  }

  // The running server of `layers`, held for one decision: `release()` once answered.
  async function acquire(layers) {
    if (stopped) return { failed: { error: "the policy service is stopping", errorLayer: null } };
    const digest = digestOf(layers);
    let entry = servers.get(digest);
    if (!entry) {
      entry = { users: 0, server: null };
      entry.ready = start(digest, layers, entry).then((got) => {
        if (got.query) entry.server = got;
        // A set that didn't start isn't kept: asked again, it is checked (a broken one, from
        // memory) or started again.
        else if (servers.get(digest) === entry) servers.delete(digest);
        return got;
      });
      servers.set(digest, entry);
    } else {
      // Most recently used last: the first idle one is the one to stop.
      servers.delete(digest);
      servers.set(digest, entry);
    }
    entry.users++;
    const got = await entry.ready;
    const release = () => {
      entry.users--;
      trim();
    };
    if (!got.query) {
      release();
      return { failed: got };
    }
    return { server: got, release };
  }

  // Past maxServers, the least recently used idle servers stop.
  function trim() {
    for (const [digest, entry] of servers) {
      if (servers.size <= maxServers) return;
      if (entry.users > 0 || !entry.server) continue;
      servers.delete(digest);
      entry.server.stop();
    }
  }

  // The operator's layer, or { error } when it can't be read.
  function operatorFiles() {
    try {
      return { files: operatorLayer() };
    } catch (error) {
      return { error: `the policies can't be read (${error.message ?? error})` };
    }
  }

  // What a decision's set is made of: the repository's files (`repo`, [[name, text]], null: none)
  // and the operator's layer, which has to be the one the caller expects (`operatorDigest`,
  // layerDigest() of the files it attributes the decision to) → { repoFiles, own } or { failed }.
  function setOf({ repo, operatorDigest }) {
    const failed = (error, errorLayer = null) => ({ failed: { error, errorLayer } });
    let repoFiles;
    try {
      repoFiles = repo ? filesOf(repo, "repo") : new Map();
    } catch (error) {
      return failed(error.message, "repo");
    }
    const own = operatorFiles();
    if (own.error) return failed(own.error);
    if (typeof operatorDigest !== "string") {
      return failed("no operatorDigest: the operator's policies the caller expects are required");
    }
    if (operatorDigest !== layerDigest(own.files)) {
      const { failed: why } = failed(
        `the policy service's operator policies (Deckhand's under ${grantsDir ?? "its grants folder"}/policy/) aren't the ones the listener read`,
      );
      return { failed: { ...why, mismatch: true } };
    }
    return { repoFiles, own };
  }

  // `decision`'s rules on `input`: the operator's layer (`operator`: whether to ask its rules;
  // its files are loaded anyway) and the repository's `repo` ([[name, text]], null: none; its
  // allow rule asked with `repoAllow`) → { operator, repo, error, errorLayer }: each asked
  // layer's { allow, denies }: `allow`, whether its `allow_<decision>` is true (null when not
  // asked); `denies`, its `deny_<decision>`'s strings, as the rule gave them. `error`: why they
  // couldn't be evaluated, then nothing else; `errorLayer`, the layer opa placed it in, null when
  // it didn't. `operatorDigest`: the operator's layer the caller expects (layerDigest(), of the
  // files it attributes the decision to), required: none is refused, and another one than here
  // too, `mismatch` set, rather than evaluated (a copy of another version, a grants folder the
  // caller and the service don't share). So no caller gets a decision on operator rules it
  // didn't expect, whether it remembers to ask or not.
  async function evaluate({
    decision,
    input,
    repo = null,
    repoAllow = false,
    operator = true,
    operatorDigest,
  }) {
    const failed = (error, errorLayer = null) => ({ error, errorLayer });
    if (typeof decision !== "string" || !DECISION.test(decision)) {
      return failed(`no decision ${JSON.stringify(decision)}`);
    }
    const sets = setOf({ repo, operatorDigest });
    if (sets.failed) return sets.failed;
    const { repoFiles, own } = sets;
    const asks = {
      ...(operator && { operator: { pkg: "deckhand", allow: true } }),
      ...(repoFiles.size && { repo: { pkg: `${REPO_NS}.deckhand`, allow: !!repoAllow } }),
    };
    if (!Object.keys(asks).length) return failed("nothing to ask");
    const rule = (pkg, name) => `[x | x := data.${pkg}.${name}_${decision}]`;
    const query = `result := {${Object.entries(asks)
      .map(
        ([layer, { pkg, allow }]) =>
          `"${layer}": {${allow ? `"allow": ${rule(pkg, "allow")}, ` : ""}"deny": ${rule(pkg, "deny")}}`,
      )
      .join(", ")}}`;
    const got = await acquire({
      operator: own.files,
      ...(repoFiles.size && { repo: repoFiles }),
    });
    if (got.failed) return got.failed;
    let res;
    try {
      res = await got.server.query(query, input, { timeoutMs });
    } catch (error) {
      return failed(`opa didn't answer (${error.message ?? error})`);
    } finally {
      got.release();
    }
    const late = `the \`${decision}\` rules took more than ${timeoutMs / 1000} s`;
    if (res.timedOut) return failed(late);
    if (res.status !== 200) {
      const { text, list, cancelled } = opaErrors(res.body);
      return failed(cancelled ? late : text, cancelled ? null : list[0].layer);
    }
    let value;
    try {
      value = JSON.parse(res.body).result?.[0]?.result;
    } catch {
      // Said below.
    }
    const said = { error: null, errorLayer: null };
    for (const [layer, { allow }] of Object.entries(asks)) {
      const answer = value?.[layer];
      // Each rule's value, in a list: empty when no file defines it, or it is undefined.
      const listed = (v) => Array.isArray(v) && v.length <= 1;
      if (!listed(answer?.deny) || (allow && !listed(answer.allow))) {
        return failed("opa's answer can't be read");
      }
      const [allowed = false] = answer.allow ?? [];
      const [denies = []] = answer.deny;
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

  // The capabilities' rules (issue #495) on each of `inputs` (key → input document, MAX_INPUTS
  // at most), in one query: the operator's layer (`operator`: whether to ask it) and the
  // repository's `repo` ([[name, text]], null: none), `operatorDigest` as evaluate() takes it →
  // { results: key → each asked layer's { all, files }: `all`, the whole rules' { allow, deny },
  // each the rule's value in a list (empty when no file defines it); `files`, file name → the same
  // of that file's own rules (byFile(), the files defining one) } or { error, errorLayer }. What
  // the values mean, and their shape, are the caller's to check (listener/policies.mjs).
  async function evaluateCapabilities({ inputs, repo = null, operator = true, operatorDigest }) {
    const failed = (error, errorLayer = null) => ({ error, errorLayer });
    if (
      !inputs ||
      typeof inputs !== "object" ||
      Array.isArray(inputs) ||
      Object.keys(inputs).length > MAX_INPUTS ||
      Object.values(inputs).some((doc) => !doc || typeof doc !== "object" || Array.isArray(doc))
    ) {
      return failed(`inputs: expected an object of at most ${MAX_INPUTS} input documents`);
    }
    if (!Object.keys(inputs).length) return { results: {} };
    const sets = setOf({ repo, operatorDigest });
    if (sets.failed) return sets.failed;
    const { repoFiles, own } = sets;
    const asks = {
      ...(operator && { operator: { pkg: "deckhand", files: own.files } }),
      ...(repoFiles.size && { repo: { pkg: `${REPO_NS}.deckhand`, files: repoFiles } }),
    };
    if (!Object.keys(asks).length) return failed("nothing to ask");
    // Each layer's files as stage() numbered them.
    const names = Object.fromEntries(
      Object.entries(asks).map(([layer, { files }]) => [layer, byFile(files).names]),
    );
    const rule = (pkg, name, i = null) =>
      `[x | x := data.${pkg}.${name}${i === null ? "" : `__${i}`}]`;
    const both = (pkg, i) =>
      `{"allow": ${rule(pkg, "allow_capabilities", i)}, "deny": ${rule(pkg, "deny_capabilities", i)}}`;
    // The whole rules decide; each file's say which file gave what.
    const value = `{${Object.entries(asks)
      .map(
        ([layer, { pkg }]) =>
          `"${layer}": {"all": ${both(pkg)}, "files": {${names[layer]
            .map((_, i) => `"${i}": ${both(pkg, i)}`)
            .join(", ")}}}`,
      )
      .join(", ")}}`;
    const query = `result := {k: v | some k, doc in input; v := ${value} with input as doc}`;
    const got = await acquire({
      operator: own.files,
      ...(repoFiles.size && { repo: repoFiles }),
    });
    if (got.failed) return got.failed;
    let res;
    try {
      res = await got.server.query(query, inputs, { timeoutMs });
    } catch (error) {
      return failed(`opa didn't answer (${error.message ?? error})`);
    } finally {
      got.release();
    }
    const late = `the capabilities' rules took more than ${timeoutMs / 1000} s`;
    if (res.timedOut) return failed(late);
    if (res.status !== 200) {
      const { text, list, cancelled } = opaErrors(res.body);
      return failed(cancelled ? late : text, cancelled ? null : list[0].layer);
    }
    let answer;
    try {
      answer = JSON.parse(res.body).result?.[0]?.result;
    } catch {
      // Said below.
    }
    if (!answer || typeof answer !== "object") return failed("opa's answer can't be read");
    const results = {};
    for (const key of Object.keys(inputs)) {
      results[key] = {};
      for (const layer of Object.keys(asks)) {
        const said = answer[key]?.[layer];
        if (!said || typeof said !== "object") return failed("opa's answer can't be read");
        results[key][layer] = {
          all: said.all,
          files: Object.fromEntries(names[layer].map((name, i) => [name, said.files?.[i]])),
        };
      }
    }
    return { results };
  }

  // The compile check of one layer: `layer` "operator" (its own files, or `files` when given:
  // the operator's checked apart, a test's) or "repo" (`files`, [[name, text]]) → { errors },
  // each { layer, file, row, message, text }: file and row null when opa doesn't give them (a
  // timeout, a folder it can't stage); `text`, the line a config check says. A repo file
  // namespaced() refuses is said at its line, the others checked without it. No files: nothing
  // to say, and no `opa` call.
  async function compile({ layer = "operator", files = null }) {
    const errors = [];
    const unplaced = (message, text = message) => ({ layer, file: null, row: null, message, text });
    let staging;
    try {
      if (layer !== "operator" && layer !== "repo") throw new Error(`no layer ${layer}`);
      if (files) staging = filesOf(files, layer);
      else if (layer === "operator") staging = operatorLayer();
      else throw new Error("a repository's files are sent");
    } catch (error) {
      const what = error.message ?? String(error);
      return { errors: [unplaced(what, `policy error: ${what}`)] };
    }
    if (!staging.size) return { errors };
    if (layer === "repo") {
      for (const [name, text] of staging) {
        const why = namespaceRefusal(name, text);
        if (!why) continue;
        errors.push({
          layer,
          file: name,
          row: why.row,
          message: why.message,
          text: `policy error: ${why.message}`,
        });
        staging.delete(name);
      }
    }
    let dir;
    try {
      dir = await stage({ [layer]: staging });
      const res = await checked(dir);
      if (res.timedOut) errors.push(unplaced(`the policies' check took too long`));
      if (res.failed)
        errors.push(unplaced(res.failed.message, `policy error: ${res.failed.message}`));
      for (const e of res.errors?.list ?? []) {
        errors.push({ ...e, layer, text: `policy error: ${located(e)}` });
      }
    } catch (error) {
      const what = error.message ?? String(error);
      errors.push(unplaced(what, `policy error: ${what}`));
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    return { errors };
  }

  // The operator's layer as read now, for the callers to show and attribute: { deckhand,
  // operator, errors, grantsDir }: Deckhand's files and the operator's, each [[name, text]] (null
  // when they can't be read, `errors` saying why), and the grants folder they were read from.
  function policies() {
    const errors = { deckhand: null, operator: null };
    let deckhand = null;
    let operator = null;
    try {
      deckhand = [...ownDefaults()];
    } catch (error) {
      errors.deckhand = error.message ?? String(error);
    }
    try {
      operator = [...readOperator()];
    } catch (error) {
      errors.operator = error.message ?? String(error);
    }
    return { deckhand, operator, errors, grantsDir };
  }

  // Every server stops: the service is.
  async function stop() {
    stopped = true;
    const all = [...servers.values()];
    servers.clear();
    await Promise.all(
      all.map(async (entry) => {
        const got = await entry.ready;
        if (got.stop) await got.stop();
      }),
    );
  }

  // The digest of the operator's layer as read now (what a caller sends as `operatorDigest`),
  // null when it can't be read.
  function operatorDigest() {
    const own = operatorFiles();
    return own.error ? null : layerDigest(own.files);
  }

  return {
    evaluate,
    evaluateCapabilities,
    compile,
    policies,
    operatorDigest,
    stop,
    servers: () => servers.size,
  };
}
