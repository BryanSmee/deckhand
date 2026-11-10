// Context repos (#928, #929): other repositories a run reads, read-only, each at a ref its
// .deckhand.yaml names (`context_repos`), in a folder of its own under CONTEXT_DIR. None unless
// the repository asks for them, the operator's grants list them (`context_repos` patterns in the
// grants folder: grants.mjs) and the policies give `read:context` (capabilities.mjs). Here: the
// config key, the grants' patterns and the start check. Format: ../docs/repo-config.md#context-repos.
import { isMap } from "../lib/yaml.mjs";

// Where the sandbox puts them: a mount or a cache can't take it over (repo-config.mjs RESERVED).
export const CONTEXT_DIR = "/context";

// GitHub's names: an owner of letters, digits and hyphens, a repository of those and ._
const OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const NAME = /^[\w.-]{1,100}$/;
// A grant's name may have `*`, which matches within the name only.
const NAME_PATTERN = /^[\w.*-]{1,100}$/;

// A branch, tag or commit as git names them (git check-ref-format, within these characters):
// it ends up in a folder's name.
const REF = /^[\w.\/-]{1,200}$/;
const badRef = (ref) =>
  !REF.test(ref) ||
  /^[-/.]|[/.]$|\.\.|\/\/|\/\.|\.lock$/.test(ref) ||
  ref.split("/").some((part) => part.endsWith(".lock"));

// "owner/name", lower case, or null when it isn't one.
function repoName(value) {
  if (typeof value !== "string") return null;
  const [owner, name, ...rest] = value.split("/");
  if (rest.length || !OWNER.test(owner ?? "") || !NAME.test(name ?? "")) return null;
  if (name === "." || name === "..") return null;
  return value.toLowerCase();
}

// Where a context repo goes in the sandbox: /context/<owner>/<name>, or with its ref
// /context/<owner>/<name>@<ref>, the ref's `/` made `-` so that it stays one folder.
export const contextFolder = (repo, ref = null) =>
  `${CONTEXT_DIR}/${repo}${ref ? `@${ref.replaceAll("/", "-")}` : ""}`;

// The repo config's `context_repos` (repo-config.mjs KEYS): a list of `owner/name` or
// { repo, ref }, exact names only. → settings.contextRepos: [{ repo, ref, folder }], `repo` in
// lower case, `ref` null for the default branch. Errors: a name that isn't one (a wildcard
// included), the run's own repository (`repo`, when the caller knows it), the same repo and ref
// twice, two entries in one folder (`release/1` and `release-1`). An entry with an error is left
// out.
export function parseContextRepos(value, { key, settings, fail, repo = null }) {
  if (!Array.isArray(value)) return fail(key, "expected a list of <owner>/<name> or { repo, ref }");
  const own = repo?.toLowerCase() ?? null;
  const folders = new Map(); // folder → the entry that has it
  value.forEach((entry, i) => {
    const at = `${key}.${i}`;
    const map = isMap(entry);
    if (!map && typeof entry !== "string") {
      return fail(at, "expected <owner>/<name> or { repo, ref }");
    }
    const unknown = map ? Object.keys(entry).filter((k) => !["repo", "ref"].includes(k)) : [];
    if (unknown.length) return fail(at, `${unknown.join(", ")}: unknown (expected repo, ref)`);
    const raw = map ? entry.repo : entry;
    const name = repoName(raw);
    if (!name) {
      const wildcard = typeof raw === "string" && raw.includes("*");
      const why = wildcard
        ? "no wildcards here: name each repository (the operator's grant may use them)"
        : "expected <owner>/<name>";
      return fail(at, `${JSON.stringify(raw ?? null)}: ${why}`);
    }
    if (name === own) return fail(at, `${name}: the run's own repository, already in /workspace`);
    const ref = map && entry.ref != null ? entry.ref : null;
    if (ref !== null && (typeof ref !== "string" || badRef(ref))) {
      return fail(at, `ref: ${JSON.stringify(ref)}: expected a branch, tag or commit name`);
    }
    const folder = contextFolder(name, ref);
    const label = ref ? `${name}@${ref}` : name;
    const twin = folders.get(folder);
    if (twin) {
      const why =
        twin.repo === name && twin.ref === ref
          ? "listed twice"
          : `the same folder as ${twin.ref ? `${twin.repo}@${twin.ref}` : twin.repo} (${folder})`;
      return fail(at, `${label}: ${why}`);
    }
    const kept = { repo: name, ref, folder };
    folders.set(folder, kept);
    settings.contextRepos.push(kept);
  });
}

// The repositories the config asks for (settings.contextRepos), each once whatever its refs:
// the run input's `context_repos` (capabilities.mjs).
export const contextNames = (settings) => [
  ...new Set((settings?.contextRepos ?? []).map((c) => c.repo)),
];

// A grants file's `context_repos` (grants.mjs parseGrant()): patterns of exact owners, `*`
// matching within the name only (`acme/*`, `acme/templates-*`), lower case, into `list`. An
// owner wildcard (`*/*`, `*/x`, `*`) is an error: every account's repositories, by accident.
export function parseContextPatterns(v, list, fail) {
  const key = "context_repos";
  if (!Array.isArray(v)) return fail(`${key}: expected a list of <owner>/<name> patterns`);
  for (const pattern of v) {
    const [owner, name, ...rest] = typeof pattern === "string" ? pattern.split("/") : [];
    const said = JSON.stringify(pattern);
    if (typeof pattern === "string" && (owner.includes("*") || pattern === "*")) {
      fail(`${key}: ${said}: no wildcard in the owner: name it (\`acme/*\`)`);
    } else if (rest.length || !OWNER.test(owner ?? "") || !NAME_PATTERN.test(name ?? "")) {
      fail(
        `${key}: ${said}: expected <owner>/<name>, \`*\` within the name (\`acme/templates-*\`)`,
      );
    } else if (!list.includes(pattern.toLowerCase())) list.push(pattern.toLowerCase());
  }
}

// Whether `pattern` (parseContextPatterns()'s) grants `repo`: the whole name, case-insensitive.
export function patternMatches(pattern, repo) {
  const [owner, name] = pattern.split("/");
  const [repoOwner, repoName] = repo.toLowerCase().split("/");
  if (owner !== repoOwner || repoName === undefined) return false;
  const glob = name.split("*").map(RegExp.escape).join("[\\w.-]*");
  return new RegExp(`^${glob}$`).test(repoName);
}

// The start check: the requested repos (settings.contextRepos) no pattern of the grant
// (grantFor()'s `contextRepos`) gives, one line each naming it and why, as grants.mjs
// grantCheck() returns them.
export function refusedContext(grant, settings) {
  const patterns = grant.contextRepos ?? [];
  return contextNames(settings)
    .filter((repo) => !patterns.some((p) => patternMatches(p, repo)))
    .map((repo) =>
      patterns.length
        ? `\`${repo}\`: no pattern of the operator's \`context_repos\` grants it (${patterns.map((p) => `\`${p}\``).join(", ")})`
        : `\`${repo}\`: the operator grants this repository no context repositories (\`context_repos\`)`,
    );
}

// Whether an item of the file's `context_repos` is the one parsed into { repo, ref }: where the
// dashboard finds its line (repo-config.mjs fileLines() itemLine()).
export const isEntry =
  ({ repo, ref }) =>
  (item) => {
    const entry = isMap(item) ? item : { repo: item };
    const name = typeof entry.repo === "string" ? entry.repo.toLowerCase() : null;
    return name === repo && (entry.ref ?? null) === ref;
  };
