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
