// Onboarding: when the App is installed on a repo without a .deckhand.yaml, the listener
// opens an issue there and Claude proposes the file in an "onboarding" conversation, which
// the trigger line turns into a pull request (tasks.mjs, runs.mjs). The decisions and the issue are
// here, with GitHub injected, so they are tested on their own (../test/onboarding.test.mjs).
import { ensureLabel } from "./comments.mjs";
import { repoAllowed } from "./config.mjs";
import { issueItem, linkedIssue, headInRepo } from "./events.mjs";
import { POLICY_DIR } from "./policies.mjs";
import { CONFIG_FILE, parseRepoConfig, readRepoFile } from "./repo-config.mjs";
import { readJson, writeJsonAtomic } from "../lib/files.mjs";

export const ONBOARDING_LABEL = "deckhand-onboarding";
const ONBOARDING_TITLE = "Set up Deckhand for this repository";

// The repos an installation delivery onboards, each checked like a comment would be: the
// operator's ALLOWED_REPOS, and who installed the App against ALLOWED_USERS. Fail closed:
// anything else is skipped with its reason (`skip` logs it). Returns [] when there is none.
export function onboardingTargets(config, event, p, skip = () => null) {
  const added =
    event === "installation" && p.action === "created"
      ? p.repositories
      : event === "installation_repositories" && p.action === "added"
        ? p.repositories_added
        : null;
  if (!added) {
    skip(`${event} ${p.action ?? ""} by ${p.sender?.login ?? "?"}`);
    return [];
  }
  const repos = added.map((r) => r.full_name).filter(Boolean);
  if (!p.installation?.id) {
    skip(`${event}: not from an installation of the App`);
    return [];
  }
  if (!config.onboarding) {
    skip(`${event}: ONBOARDING=off, no onboarding issue for ${repos.join(", ")}`);
    return [];
  }
  const sender = p.sender?.login ?? "";
  if (!config.users.includes(sender.toLowerCase())) {
    skip(
      `${event}: ${sender || "?"} not in ALLOWED_USERS, no onboarding issue for ${repos.join(", ")} (\`/mode onboarding\` starts it later)`,
    );
    return [];
  }
  return repos.filter((repo) => {
    if (!repoAllowed(config, repo)) {
      return skip(`${event}: ${repo} not in ALLOWED_REPOS`) ?? false;
    }
    return true;
  });
}

// The issue that starts the conversation: who installed the App (or started it from the
// dashboard, `byHand`), and how it goes on.
export function onboardingBody(sender, trigger, byHand = false) {
  const who = byHand
    ? `@${sender} started Deckhand's setup for this repository from the dashboard.`
    : `@${sender} installed Deckhand on this repository.`;
  return `${who} It has no \`${CONFIG_FILE}\` yet, so its runs use the operator's settings and the bare sandbox image: no toolchain beyond Node, no setup command.

Deckhand is reading the repository and replies here with a proposed \`${CONFIG_FILE}\` (and a Dockerfile or instructions file when they help), each key with its reason.

- **Change it** by replying here: every comment goes on in the same conversation, no trigger line needed. Nothing is pushed meanwhile.
- **Confirm it** with a comment whose first line is \`${trigger}\`: Deckhand opens a pull request with only the agreed files.
- **Merge** that pull request: the next runs read the config from the default branch.`;
}

// The trigger as the maintainer types it: TRIGGER is compared loosely (normalize()).
export function triggerWord(trigger) {
  return trigger.charAt(0).toUpperCase() + trigger.slice(1);
}

// onboarding.json: repo → { issue, at }. A repo is recorded once its issue exists (or a
// "/mode onboarding" started one), so a reinstall or a restart opens no second issue.
export function createOnboardingStore(path) {
  const repos = readJson(path, {});
  const save = () => writeJsonAtomic(path, repos);
  return {
    get: (repo) => repos[repo.toLowerCase()] ?? null,
    // Whether `number` is the repo's onboarding issue.
    isIssue: (repo, number) => repos[repo.toLowerCase()]?.issue === number,
    record(repo, issue, at = Date.now()) {
      repos[repo.toLowerCase()] = { issue, at };
      save();
    },
  };
}

// Opens the repo's onboarding issue, unless it was onboarded already, has issues disabled
// or already has a config on its default branch, and starts its run (start()). `request`: the
// App's GitHub calls (github-app.mjs); `repoSettings(repo, base)`: the default branch's
// config; `accept(item)`: queues a run (tasks.mjs).
export function createOnboarding({
  request,
  store,
  config,
  repoSettings = null,
  accept = null,
  log = () => {},
}) {
  // Repos whose issue is being opened: two deliveries at once open one.
  const opening = new Set();

  // Resolves to { number, title, base } or null, with the reason logged. `byHand`: from the
  // dashboard (repos.mjs) rather than an installation delivery.
  async function open(repo, sender, byHand = false) {
    const key = repo.toLowerCase();
    const skip = (why) => (log(`  onboarding ${repo}: skipped, ${why}`), null);
    const known = store.get(repo);
    if (known) return skip(`already onboarded (#${known.issue})`);
    if (opening.has(key)) return skip("its issue is being opened");
    opening.add(key);
    try {
      const res = await request(repo, "GET", `/repos/${repo}`);
      if (!res.ok) return skip(`reading the repository: ${res.status}`);
      const info = await res.json();
      if (info.has_issues === false) return skip("issues are disabled");
      const base = info.default_branch || "main";
      if (await readRepoFile(request, repo, CONFIG_FILE, base)) {
        return skip(`${CONFIG_FILE} is already on ${base}`);
      }
      await ensureLabel(
        request,
        repo,
        {
          name: ONBOARDING_LABEL,
          color: "0e8a16",
          description: "Deckhand proposes this repository's .deckhand.yaml",
        },
        log,
      );
      const created = await request(repo, "POST", `/repos/${repo}/issues`, {
        title: ONBOARDING_TITLE,
        body: onboardingBody(sender, triggerWord(config.trigger), byHand),
        labels: [ONBOARDING_LABEL],
      });
      if (!created.ok) return skip(`creating its issue: ${created.status}`);
      const { number } = await created.json();
      store.record(repo, number);
      log(`  onboarding ${repo}: opened #${number}`);
      return { number, title: ONBOARDING_TITLE, base };
    } finally {
      opening.delete(key);
    }
  }

  // An onboarding issue for the repo, if it needs one, starting an onboarding run on it as a
  // "/mode onboarding" comment would. Resolves to the issue, or null (the reason logged).
  // `byHand`: started from the dashboard's repository list.
  async function start(repo, sender, byHand = false) {
    const issue = await open(repo, sender, byHand).catch((error) => {
      log(`  onboarding ${repo}: ${error.stack ?? error}`);
      return null;
    });
    if (!issue) return null;
    const { settings } = await repoSettings(repo, issue.base);
    await accept(
      issueItem(repo, issue, {
        trigger: null,
        modeLine: "onboarding",
        text: "",
        comment: null,
        base: issue.base,
        settings,
      }),
    );
    return issue;
  }

  // An installation delivery: an onboarding issue per repo that needs one.
  async function onboard(repos, sender) {
    for (const repo of repos) await start(repo, sender);
  }

  return { open, start, onboard };
}

// The open pull request of issue `number`: its branch (issue-<n>-…) or its "Closes #n", not
// a fork's.
async function issuePullRequest(request, repo, number) {
  const res = await request(repo, "GET", `/repos/${repo}/pulls?state=open&per_page=100`);
  if (!res.ok) return null;
  const pulls = await res.json();
  if (!Array.isArray(pulls)) return null;
  return (
    pulls.find((p) => headInRepo(p, repo) && p.head.ref?.startsWith(`issue-${number}-`)) ??
    pulls.find((p) => linkedIssue(p, repo) === number) ??
    null
  );
}

// What the onboarding pull request's config says, for the reply: its errors and warnings
// from parseRepoConfig(), the files it names that the branch doesn't have, and its policies'
// compile errors (`policies`: policies.mjs createPolicies()). Null when the issue has no open
// pull request.
export async function branchConfigReport(request, config, repo, number, policies = null) {
  const pr = await issuePullRequest(request, repo, number);
  if (!pr) return null;
  const branch = pr.head.ref;
  const file = await readRepoFile(request, repo, CONFIG_FILE, branch);
  const where = `\`${CONFIG_FILE}\` on \`${branch}\``;
  if (!file) return `⚠️ ${where}: not found, so nothing was checked.`;
  const { settings, errors, warnings } = parseRepoConfig(file.text, config);
  const named = [
    ["dockerfile", settings.dockerfile],
    ["instructions", settings.instructions],
    ...Object.entries(settings.modes).map(([name, m]) => [
      `modes.${name}.instructions`,
      m.instructions,
    ]),
  ].filter(([, path]) => path);
  for (const [key, path] of named) {
    if (!(await readRepoFile(request, repo, path, branch))) {
      errors.push(`${key}: \`${path}\` is not on the branch`);
    }
  }
  if (policies) {
    const checked = await policies.checkRepo(repo, branch);
    errors.push(...checked.errors.map((e) => `\`${POLICY_DIR}/\`: ${e}`));
    warnings.push(...checked.warnings.map((w) => `\`${POLICY_DIR}/\`: ${w}`));
  }
  if (!errors.length && !warnings.length) return `✅ ${where} checked: no errors or warnings.`;
  const lines = [...errors.map((e) => `- ❌ ${e}`), ...warnings.map((w) => `- ⚠️ ${w}`)];
  const verdict = errors.length
    ? "has errors: don't merge it as it is, reply here to fix them."
    : "has warnings:";
  return `${where} ${verdict}\n\n${lines.join("\n")}`;
}
