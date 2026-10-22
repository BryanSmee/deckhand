// The checks a dashboard action makes on a repo before acting as the signed-in user would by
// comment (work.mjs, discussions.mjs, analysis.mjs): the App installed, the repo's config
// without errors, the user in both the operator's and the repo's users. Failures throw
// Refused (web.mjs), which the API answers with their status.
import { getJson } from "./github.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { Refused, refuse } from "./web.mjs";

// `github(repo, method, path, body, expected)`: the App's calls. `repoSettings(repo, base)`:
// the default branch's config.
export function createRepoCheck({ config, github, repoSettings }) {
  // Lowercase name → GitHub's spelling of it, as each read of the repo says.
  const names = new Map();

  // The repo as GitHub describes it, or a 404 when the App can't read it.
  async function infoOf(repo) {
    const info = await getJson(github, repo, `/repos/${repo}`, [404]);
    if (!info) refuse(404, `The App is not installed on ${repo}.`);
    names.set(repo.toLowerCase(), info.full_name ?? repo);
    return info;
  }

  // The repo as GitHub spells it, which webhooks give too: a dashboard address typed in
  // lowercase would key its tasks apart from theirs, and busy() would miss their runs. Read
  // once, then as each check reads the repo. One the App can't read keeps its name: its checks
  // refuse it.
  async function nameOf(repo) {
    const known = names.get(repo.toLowerCase());
    if (known) return known;
    try {
      await infoOf(repo);
      return names.get(repo.toLowerCase());
    } catch (error) {
      if (error instanceof Refused) return repo;
      throw error;
    }
  }

  // The repo's default branch, or a 404 when the App can't read it.
  async function baseOf(repo) {
    return (await infoOf(repo)).default_branch || "main";
  }

  // { settings, base, isPrivate } for `user` on `repo`; throws Refused. `isPrivate` only when
  // GitHub says so.
  async function checkedRepo(repo, user) {
    const login = user.toLowerCase();
    if (!config.users.includes(login)) refuse(403, `${user} is not in ALLOWED_USERS.`);
    const info = await infoOf(repo);
    const base = info.default_branch || "main";
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length) {
      refuse(
        409,
        `${CONFIG_FILE} of ${repo} has errors: no run starts there until they are fixed.`,
      );
    }
    if (!settings.users.includes(login)) refuse(403, `${user} is not among ${repo}'s users.`);
    return { settings, base, isPrivate: info.private === true };
  }

  return { baseOf, checkedRepo, nameOf };
}
