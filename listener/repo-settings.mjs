// Each repo's settings as the listener last read them: from its default branch for a run or a
// comment (repoSettings()), or for the dashboard's repository list (repos.mjs). The dashboard
// shows a repo's tasks and logs to its `users` only (http.mjs), and its forms read its
// `wait_for_answers` and inboxes.
import { loadRepoSettings } from "./repo-config.mjs";

// `github`: the App's calls (github.mjs); `repoList`: the dashboard's repository list
// (repos.mjs createRepoList()), with `usersOf(repo)` and `known()`.
export function createRepoSettings({ github, config, repoList }) {
  // "org/repo" (lower case) → { repo, users, waitForAnswers, inbox, at }: the last read for a
  // run or a comment.
  const reads = new Map();

  // A repo's settings from its default branch; errors in its config file stop its runs.
  async function repoSettings(repo, base) {
    const read = await loadRepoSettings(github, config, repo, base || "main");
    if (!read.errors.length) {
      const { users, waitForAnswers, inbox } = read.settings;
      reads.set(repo.toLowerCase(), { repo, users, waitForAnswers, inbox, at: Date.now() });
    }
    return read;
  }

  // The latest read of a repo's settings, here or for the repository list, or null.
  function latestRead(repo) {
    const known = [reads.get(repo.toLowerCase()), repoList.usersOf(repo)].filter(Boolean);
    return known.sort((a, b) => b.at - a.at)[0] ?? null;
  }

  // Each repo read so far, its inbox issues and discussions category ({ ideas, bugs,
  // discussions }): the dashboard's Feedback form.
  function inboxes() {
    const names = new Map(
      [...[...reads.values()].map((r) => r.repo), ...repoList.known()].map((n) => [
        n.toLowerCase(),
        n,
      ]),
    );
    return [...names.values()].map((repo) => {
      const { ideas = null, bugs = null, discussions = null } = latestRead(repo)?.inbox ?? {};
      return [repo, { ideas, bugs, discussions }];
    });
  }

  return {
    repoSettings,
    // The latest read; null when not known yet: ALLOWED_USERS alone then.
    usersOf: (repo) => latestRead(repo)?.users ?? null,
    // Unknown: the default, on.
    waitsForAnswers: (repo) => latestRead(repo)?.waitForAnswers ?? true,
    inboxes,
  };
}
