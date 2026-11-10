// Context repos at a run's start (#930): what GitHub says of each repository its config's
// `context_repos` names (context-repos.mjs), and what the run then reads. Looked up before its
// capabilities are decided, whose risky combinations need the repositories' visibility
// (capabilities.mjs RISKY); held against the run once they give it `read:context`
// (preparation.mjs): a repository it can't read, or a ref that doesn't exist, stops it with the
// reason, as a refused grant does. A run never goes on with part of its context.
//
// - the App installed on it (its owner's installation, whoever that is): its fetches get a token
//   for it alone (context-gateway.mjs);
// - not installed: read without a token, so only a public repository is: GitHub shows it to
//   the run's own repository's installation. A private one (or one that isn't there) stops the
//   run, saying to install the App on it.
import { getJson } from "./github.mjs";

// A commit's id, maybe abbreviated as git allows it: a ref spelled so is cloned at the commit
// GitHub resolves it to, when that commit's id starts with it.
const HEX = /^[0-9a-f]{7,64}$/i;

// GitHub's `/repos/<repo>` as the App installed there answers it, or null where it isn't (the
// github service's 404: no installation to ask with). Anything else throws.
async function asInstalled(github, repo) {
  try {
    return await getJson(github, repo, `/repos/${repo}`, [404]);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

// What GitHub says of `repo` for a run of `own` → { installed, private, as, problem }: `as`, the
// repository whose installation reads it (its own, or `own` for a public one), `problem` why the
// run can't read it, null when it can.
async function lookUp(github, own, repo) {
  const info = await asInstalled(github, repo);
  if (info) return { installed: true, private: info.private !== false, as: repo, problem: null };
  const shown = await getJson(github, own, `/repos/${repo}`, [404, 403]);
  if (shown?.private === false) return { installed: false, private: false, as: own, problem: null };
  return {
    installed: false,
    private: null,
    as: own,
    problem: `\`${repo}\`: the GitHub App isn't installed on it, and GitHub doesn't show it publicly (private, or not there). An owner of the account installs the App on it (or adds it to the installation's repositories), or the repository removes it from \`context_repos\``,
  };
}

// Each repository `settings.contextRepos` names, looked up on GitHub for a run of `own`
// ("owner/name"), and each entry's ref resolved → { repos: name → lookUp()'s, clones: [{ repo,
// ref, folder }] (`ref`: null for the default branch, a commit's whole id for a ref spelled as
// one, else the branch or tag), problems: [lines] }, or null when it names none. `github`:
// github.mjs's. Throws when GitHub fails (GitHubUnavailable: the run goes back in the queue).
export async function lookUpContext(github, own, settings) {
  const entries = settings?.contextRepos ?? [];
  if (!entries.length) return null;
  const repos = new Map();
  for (const { repo } of entries) {
    if (!repos.has(repo)) repos.set(repo, await lookUp(github, own, repo));
  }
  const problems = [...repos.values()].map((r) => r.problem).filter(Boolean);
  const clones = [];
  for (const { repo, ref, folder } of entries) {
    const found = repos.get(repo);
    if (found.problem || ref === null) {
      clones.push({ repo, ref: null, folder });
      continue;
    }
    const commit = await getJson(github, found.as, `/repos/${repo}/commits/${ref}`, [404, 422]);
    const sha = typeof commit?.sha === "string" ? commit.sha.toLowerCase() : null;
    if (!sha) {
      problems.push(`\`${repo}\`: no branch, tag or commit \`${ref}\` there`);
      continue;
    }
    const isCommit = HEX.test(ref) && sha.startsWith(ref.toLowerCase());
    clones.push({ repo, ref: isCommit ? sha : ref, folder });
  }
  return { repos, clones, problems };
}

// The visibility of each one (capabilities.mjs outcomeOf()'s `repo.context`: name → true, false
// or null, unknown), from lookUpContext()'s.
export const visibility = (found) =>
  Object.fromEntries([...(found?.repos ?? new Map())].map(([name, r]) => [name, r.private]));

// What the run reads → { repos: [{ repo, installed }], fenced, clones }, or null when it has
// nothing to do with context repos: `fenced`, what its git may not fetch (context-gateway.mjs):
// the names its config asks for and the operator's patterns (`grant.contextRepos`). Without
// `read:context` (`reads`), none of them; with it, every one, or it throws the reason
// (`problems`): the caller stops the run with it.
export function contextOf(found, settings, grant, reads) {
  const asked = [...new Set((settings?.contextRepos ?? []).map((c) => c.repo))];
  const fenced = [...new Set([...asked, ...(grant?.contextRepos ?? [])])];
  if (!fenced.length) return null;
  if (!reads || !found) return { repos: [], fenced, clones: [] };
  if (found.problems.length) throw new ContextError(found.problems);
  const repos = [...found.repos].map(([repo, r]) => ({ repo, installed: r.installed }));
  return { repos, fenced, clones: found.clones };
}

// The context repos the run can't read: one line each.
export class ContextError extends Error {
  constructor(problems) {
    super(problems.join("; "));
    this.problems = problems;
  }
}

// The sandbox's SANDBOX_CONTEXT (../sandbox/entrypoint.sh): a line per clone, `<repo> <ref>
// <folder>`, `-` for the default branch.
export const contextEnv = (clones = []) =>
  clones.map(({ repo, ref, folder }) => `${repo} ${ref ?? "-"} ${folder}`).join("\n");
