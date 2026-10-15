// What Claude reads: each run's prompt (TASK_PROMPT), its first message (TASK_MESSAGE) and the
// comments delivered to it mid-run. Pure, apart from reading ../prompts/ once at start.
import { readFileSync } from "node:fs";
import { mandatoryHosts } from "./egress.mjs";
import { FRESH, INBOX } from "./modes.mjs";
import { triggerWord } from "./onboarding.mjs";

const instructions = (name) => readFileSync(new URL(`../prompts/${name}`, import.meta.url), "utf8");
const brainstormInstructions = instructions("brainstorm.md");
const onboardingInstructions = instructions("onboarding.md");
// The config's reference, in the image next to the prompts so the two can't drift apart.
const configReference = readFileSync(new URL("../docs/repo-config.md", import.meta.url), "utf8");
const inboxInstructions = {
  idea: instructions("idea.md"),
  bug: instructions("bug.md"),
  discussion: instructions("discussion.md"),
};

// Inbox entries and discussions: the entries come with the prompt, as the session is new.
export function inboxPrompt(task, mode, text) {
  const { repo, number } = task;
  const where = {
    idea: `the ideas inbox of ${repo} (issue #${number})`,
    bug: `the bug reports inbox of ${repo} (issue #${number})`,
    discussion: `discussion #${number} of ${repo}`,
  }[mode];
  const read =
    mode === "discussion"
      ? `Read the whole discussion with:

\`\`\`sh
gh api graphql -F owner=${repo.split("/")[0]} -F name=${repo.split("/")[1]} -F number=${number} -f query='
  query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
    discussion(number: $number) { title body url author { login } comments(last: 50) { nodes {
      author { login } body url replies(last: 50) { nodes { author { login } body url } } } } } } }'
\`\`\``
      : `The latest comments of the inbox give the context of a follow-up:
\`gh issue view ${number} --comments\`.`;
  return `New on ${where}. ${read}

${inboxInstructions[mode]}

${mode === "discussion" ? "The message" : "The entries, each its own"}:

${text}`;
}

export function brainstormPrompt(task) {
  return `Brainstorm GitHub issue #${task.number} of ${task.repo} with the maintainer. Read it with
\`gh issue view ${task.number} --comments\`.

${brainstormInstructions}`;
}

// Onboarding: its instructions, what this Deckhand allows the repo (a config can only narrow
// it, the operator's grants widen it: `grant`, grantFor()), and the config's reference.
export function onboardingPrompt(task, settings, config, grant) {
  const { repo, number } = task;
  const none = (items) => (items.length ? items.map((i) => `\`${i}\``).join(", ") : "none");
  const roots = grant.mounts.map((m) => `${m.root}${m.readOnly === false ? " (read-write)" : ""}`);
  return `Onboard ${repo} with the maintainer, on GitHub issue #${number}. Read it with
\`gh issue view ${number} --comments\`.

${onboardingInstructions}

## This Deckhand

- Trigger (confirms the proposal, alone on the first line of a comment): \`${triggerWord(settings.trigger)}\`
- Users who may start runs (\`ALLOWED_USERS\`; \`users\` can only narrow it): ${none(config.users)}
- Hosts every sandbox reaches: ${none(mandatoryHosts(config))}, and the operator's \`ALLOWED_HOSTS\`: ${none(config.hosts)}
- Hosts the operator grants this repository: ${none(grant.hosts)}
- \`hosts\` in \`.deckhand.yaml\`: ${grant.allowRepoHosts ? "allowed: the operator lets this repository add hosts (never `*`)" : "only hosts listed above count; any other is refused and stops runs until the operator sets `allow_repo_hosts` for this repository"}
- Host mount roots granted to this repository: ${roots.length ? none(roots) : "none: a \`mounts\` entry would be refused until the operator grants a root"}
- Models: work \`${settings.model}\` (${settings.effort} effort), brainstorms \`${settings.brainstormModel}\` (${settings.brainstormEffort})

## Reference: \`.deckhand.yaml\` (docs/repo-config.md)

${configReference}`;
}

// The run the trigger line starts on an onboarding issue: the agreed files, nothing else.
export function onboardingWorkPrompt(task) {
  const n = task.number;
  const base = task.base || "main";
  return `The maintainer confirmed the onboarding proposal on GitHub issue #${n} of ${task.repo}
(\`gh issue view ${n} --comments\` has the conversation). Open the pull request:
1. The sandbox has already checked out the issue's branch, pushed it and opened a draft pull
   request (\`Closes #${n}\`; \`gh pr view\` shows it). If you are still on ${base}, create a
   branch from ${base} named \`issue-${n}-deckhand-config\` and push it.
2. If the maintainer agreed to inbox issues, create them now (\`gh issue create\`) and put
   their numbers in \`inbox\`. Create none they didn't agree to.
3. Write only the agreed files (\`.deckhand.yaml\`, and the Dockerfile and instructions file
   if they were part of it), exactly as last proposed with the changes agreed since. Change
   nothing else in the repository.
4. Commit, push, then update the pull request with \`gh pr edit\`: title "Set up Deckhand", a
   description with \`Closes #${n}\` and a line per file. Before marking it ready with
   \`gh pr ready\`, ${rebaseStep(base)}
Never push to ${base}. The listener checks the branch's \`.deckhand.yaml\` once you are done
and adds the result to your reply.
Don't post comments on GitHub yourself: your final message is posted for you as a reply, so
end with a short summary (the pull request link, the files, the inbox issues created).`;
}

// What Claude reads for a brainstorm run, besides the comments themselves.
export function brainstormMessage(mode, text, restored) {
  if (mode === "stop") {
    return `The maintainer ends the brainstorm here${text ? `, adding:\n\n${text}\n\n` : ". "}Wrap up as in step 4 of your instructions: post the summary and update the issue's description with what was decided.`;
  }
  return restored
    ? `${text}\n\n(The brainstorm resumes after a pause: check the issue for comments you haven't seen.)`
    : text;
}

// Before `gh pr ready`: the base may have moved during the run, and a pull request marked
// ready with conflicts isn't ready (pr-ready.mjs refuses it too). `base`: a branch name, or
// how to find it.
export function rebaseStep(base) {
  return `bring the branch up to date: \`git fetch origin\`, \`git rebase origin/${base}\`,
resolve any conflicts, run the checks again, then \`git push --force-with-lease\` (rewriting
history is fine on this branch only). If a conflict can't be resolved safely (both sides
changed the same behaviour, say), stop and ask instead of guessing (see "Stopping to ask" in
CLAUDE.md).`;
}

// Where a pull request's run may push: its branch (`branches`, runs.mjs pushBranches()), or
// nowhere when that branch is in a fork.
function prPush(branches) {
  return branches.length
    ? `push to its branch, \`${branches.at(-1)}\`: Deckhand refuses pushes to any other`
    : `you can't push: its branch is in a fork, so describe the changes in your reply instead`;
}

export function initialPrompt(task, branches = []) {
  const base = task.base || "main";
  const common = `Follow the repository's AGENTS.md and CLAUDE.md if it has them, with tests where the
code has them, and run the checks they list before pushing. Never push to ${base}. When
something is ambiguous, pick the reasonable option and say so rather than stopping, unless it
is a blocker only the maintainer can resolve: then push your work in progress and end with
your questions (see "Stopping to ask" in CLAUDE.md).
Don't post comments on GitHub yourself: your final message is posted for you as a reply, so
end with a short summary (what you did, the pull request link, anything left open).`;
  if (task.kind === "pr") {
    return `Work on pull request #${task.number} of ${task.repo}: check it out with
\`gh pr checkout ${task.number}\`, read it with \`gh pr view ${task.number} --comments\`, do what
is asked below, and ${prPush(branches)}. Before marking it ready with \`gh pr ready\`, or
when it conflicts with its base (\`gh pr view ${task.number} --json baseRefName\`),
${rebaseStep("<its base>")}
${common}`;
  }
  return `Work on GitHub issue #${task.number} of ${task.repo} until it is ready for review.
1. Read it with \`gh issue view ${task.number} --comments\`. If it was brainstormed there, build
   on what was settled.
2. The sandbox has already checked out the issue's branch, pushed it and opened a draft pull
   request (\`Closes #${task.number}\`; \`gh pr view\` shows it): work on that branch. If you
   are still on ${base}, it couldn't: create a branch from ${base} named
   \`issue-${task.number}-<short-slug>\` and push it, and the draft pull request is opened for
   you. Deckhand refuses pushes to branches not named \`issue-${task.number}-…\`.
3. Implement it, pushing to the same branch as you go.
4. When the checks pass, update the pull request with \`gh pr edit\`: final title, and a
   description with \`Closes #${task.number}\`, what changed and why, any choice you made, and
   screenshots if the UI changed (see "Screenshots" in CLAUDE.md).
5. Before marking it ready for review with \`gh pr ready\`,
${rebaseStep(base)}
${common}`;
}

// A run in one of the repo's own modes: its instructions (`instructions`, the file's text
// from the default branch) after what every run of that kind is told. CLAUDE.md has the
// generic rules, as for work.
export function modePrompt(task, own, instructions, branches = []) {
  const { number: n, repo } = task;
  const base = task.base || "main";
  const where =
    task.kind === "pr"
      ? `pull request #${n} of ${repo}. Read it with \`gh pr view ${n} --comments\` and \`gh pr diff ${n}\``
      : `GitHub issue #${n} of ${repo}. Read it with \`gh issue view ${n} --comments\`, and its pull
request if it has one (\`gh pr list --state all --search ${n}\`)`;
  const rules = own.light
    ? `This mode only comments: never write or edit code, create a branch, commit, push, open a
pull request or create issues (your GitHub token can only read). The clone in /workspace is
set up for reading, not running: the project's setup was skipped. The base branch was
fetched from \`origin\` at the start of this run.`
    : task.kind === "pr"
      ? `Check the pull request out with \`gh pr checkout ${n}\` if you change code, and ${prPush(branches)}.
Never push to ${base}.`
      : `The sandbox has already checked out the issue's branch, pushed it and opened a draft pull
request (\`gh pr view\` shows it): if you change code, commit and push to that branch
(Deckhand refuses pushes to branches not named \`issue-${n}-…\`). Never push to ${base}.`;
  return `You are in the "${own.name}" mode of this repository, on ${where}.

${rules}
Don't post comments on GitHub yourself: your final message is posted for you as the reply.

The ${own.name} mode's instructions, from the repository:

${instructions.trim()}`;
}
// The run's prompt, by what it is. `own`: the repo's mode, with its `instructions` text;
// `onboardingWork`: a work run on an onboarding issue; `grant`: what the operator grants the
// repo (grantFor()); `branches`: what the run may push (runs.mjs pushBranches()).
export function promptFor(
  task,
  { mode, text, settings, own, instructions, onboardingWork, config, grant, branches },
) {
  if (mode === "brainstorm" || mode === "stop") return brainstormPrompt(task);
  if (INBOX.has(mode)) return inboxPrompt(task, mode, text);
  if (mode === "onboarding") return onboardingPrompt(task, settings, config, grant);
  if (own) return modePrompt(task, own, instructions, branches);
  return onboardingWork ? onboardingWorkPrompt(task) : initialPrompt(task, branches);
}

// The run's first message, after its prompt: the comments. `started`: the session goes on.
export function firstMessage({ mode, text, restored, started }) {
  const talk = mode === "brainstorm" || mode === "stop";
  const body = talk ? brainstormMessage(mode, text, restored) : text;
  // An empty follow-up (only "/model …", say) would open an interactive session instead.
  if (started) {
    return `${body || "Continue."}\n\n(Don't post comments on GitHub yourself: your final message is posted as a reply.)`;
  }
  // A new inbox session reads its entries in the prompt (inboxPrompt()).
  return INBOX.has(mode) ? "" : body;
}

// What Claude reads for comments delivered mid-run (the CLI adds that the user sent it while
// Claude was working).
export function liveMessage(mode, text) {
  const reply =
    "Your final message is still posted as the single reply for this run: make it cover this comment too. (Don't post comments on GitHub yourself.)";
  if (mode === "brainstorm") {
    return `New comment on the issue: ${text}\n\n(Still a brainstorm: no code, branch, commit, pull request or new issue. ${reply})`;
  }
  if (FRESH.has(mode)) {
    return `Another entry arrived on the inbox while you were working:\n\n${text}\n\nHandle it like the others, as its own entry. ${reply}`;
  }
  if (mode === "discussion") return `New comment in the discussion:\n\n${text}\n\n${reply}`;
  if (mode === "onboarding") {
    return `New comment on the issue: ${text}\n\n(Still onboarding: no code, branch, commit, pull request or new issue. ${reply})`;
  }
  return `New comment on this issue while you are working:\n\n${text}\n\nTake it into account from here on. ${reply}`;
}
