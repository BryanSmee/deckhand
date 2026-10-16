// The checks a dashboard action makes on a repo before acting as the signed-in user would by
// comment (work.mjs, discussions.mjs, analysis.mjs): the App installed, the repo's config
// without errors, the user in both the operator's and the repo's users. Failures throw
// Refused (web.mjs), which the API answers with their status.
import { getJson } from "./github.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { refuse } from "./web.mjs";

// `github(repo, method, path, body, expected)`: the App's calls. `repoSettings(repo, base)`:
// the default branch's config.
export function createRepoCheck({ config, github, repoSettings }) {
  // The repo's default branch, or a 404 when the App can't read it.
  async function baseOf(repo) {
    const info = await getJson(github, repo, `/repos/${repo}`, [404]);
    if (!info) refuse(404, `The App is not installed on ${repo}.`);
    return info.default_branch || "main";
  }

  // { settings, base } for `user` on `repo`; throws Refused.
  async function checkedRepo(repo, user) {
    const login = user.toLowerCase();
    if (!config.users.includes(login)) refuse(403, `${user} is not in ALLOWED_USERS.`);
    const base = await baseOf(repo);
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length) {
      refuse(
        409,
        `${CONFIG_FILE} of ${repo} has errors: no run starts there until they are fixed.`,
      );
    }
    if (!settings.users.includes(login)) refuse(403, `${user} is not among ${repo}'s users.`);
    return { settings, base };
  }

  return { baseOf, checkedRepo };
}
