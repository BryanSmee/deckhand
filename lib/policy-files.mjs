// The operator's policy files as both sides read them (#501): the listener, to know what the
// policy service should be evaluating, and the policy service, which evaluates them. Each reads
// GRANTS_DIR/policy/ itself, and a digest of the operator's layer (Deckhand's files under the
// operator's) goes with each decision, so that the two never silently disagree.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

// A policy file's name: no folders, nothing hidden.
export const FILE = /^[\w][\w.-]*\.rego$/;

// Where the operator's policies are in the grants folder.
const OPERATOR_DIR = "policy";

// The operator's policies: `grantsDir`/policy/*.rego, read now, name → text. A symlink is
// followed only when it stays in the grants folder (a mounted ConfigMap's files are links).
// No folder: none. A file that can't be read throws: no decision without the operator's rules.
export function operatorPolicies(grantsDir, read = (path) => readFileSync(path, "utf8")) {
  const files = new Map();
  if (!grantsDir) return files;
  const dir = join(grantsDir, OPERATOR_DIR);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return files;
    throw new Error(`${OPERATOR_DIR}/ in the grants folder can't be read (${error.code})`);
  }
  let top;
  try {
    top = realpathSync(grantsDir);
  } catch {
    top = grantsDir;
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

// A layer's files (name → text, or [[name, text]]) → its digest, whatever their order: what the
// listener expects the policy service to evaluate, and what the service checks it against.
export function layerDigest(files) {
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

// The `allow_*` and `deny_*` rules a file defines at the start of a line, in package
// `deckhand`: what the config check compares with the rules the listener asks, the files the
// dashboard says decided, and the capabilities' rules byFile() renames. A rule written
// otherwise is only missed by them.
export function rulesOf(text) {
  if (!/^\s*package\s+deckhand\s*$/m.test(text)) return [];
  return [...new Set([...text.matchAll(/^((?:allow|deny)_\w*)\b/gm)].map((m) => m[1]))];
}

// The inputs one call of the policy service's capabilities takes (engine.mjs
// evaluateCapabilities()): the listener sends more in several (a repository's modes, for its
// config page). One number for both sides.
export const MAX_CAPABILITY_INPUTS = 64;

// The capabilities' rules (issue #495), sets rather than a yes or no: `allow_capabilities`, the
// names allowed, `deny_capabilities`, { capability, reason } objects.
export const CAPABILITY_RULES = ["allow_capabilities", "deny_capabilities"];

const HEADS = /^((?:allow|deny)_capabilities)\b/gm;
// A renamed rule in opa's messages, said back as the file wrote it.
export const BY_FILE_NAME = /\b((?:allow|deny)_capabilities)__\d+\b/g;
// Where a layer's union module goes as it is staged: in a folder of its own, so that no file of
// the layer has its name.
export const UNION_DIR = "capabilities";
export const UNION_FILE = "union.rego";

// The capabilities' rules of each file of a layer under a name of its own
// (`allow_capabilities__<i>`, the file's index), so that one query says which file allowed or
// denied what (the config page's deciding file), and a module that gives `allow_capabilities`
// and `deny_capabilities` as the union of them, so that a rule which reads them, and every
// decision, still sees the whole set. Only the heads rulesOf() reads (at the start of a line, in
// package `deckhand`) are renamed: one written otherwise counts, in the union, for no file.
// `files`: name → text → { texts, union, names }: the files renamed, the union's text (null when
// no file defines either rule), and each index's file name. By name, whatever the order of
// `files`: the policy service keeps one server for a set however it is sent (its digest).
export function byFile(files) {
  const texts = new Map();
  const names = [];
  const lines = [];
  for (const [name, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const defined = rulesOf(text).filter((r) => CAPABILITY_RULES.includes(r));
    if (!defined.length) {
      texts.set(name, text);
      continue;
    }
    const i = names.push(name) - 1;
    texts.set(name, text.replace(HEADS, `$1__${i}`));
    for (const rule of defined) {
      const x = rule === "allow_capabilities" ? "c" : "d";
      lines.push(`${rule} contains ${x} if some ${x} in ${rule}__${i}`);
    }
  }
  const union = lines.length ? `package deckhand\n\n${lines.join("\n")}\n` : null;
  return { texts, union, names };
}
