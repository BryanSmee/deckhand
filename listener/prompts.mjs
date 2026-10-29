// What the agent reads: each run's prompt (TASK_PROMPT), its first message (TASK_MESSAGE) and
// the comments delivered to it mid-run. Pure, apart from reading ../prompts/ once at start.
import { readFileSync } from "node:fs";
import { entryName } from "./agents/index.mjs";
import { entryLabel, providerLabel } from "./agents/select.mjs";
import { mandatoryHosts } from "./egress.mjs";
import { FRESH, INBOX, MODES } from "./modes.mjs";
import { triggerWord } from "./onboarding.mjs";
import { blockingSeverities } from "./reviews.mjs";

const instructions = (name) => readFileSync(new URL(`../prompts/${name}`, import.meta.url), "utf8");
// Each built-in mode's instructions, by mode (MODES' `prompt`).
const modeInstructions = Object.fromEntries(
  Object.entries(MODES)
    .filter(([, mode]) => mode.prompt)
    .map(([name, mode]) => [name, instructions(mode.prompt)]),
);
// The config's reference, in the image next to the prompts so the two can't drift apart.
const configReference = readFileSync(new URL("../docs/repo-config.md", import.meta.url), "utf8");

// Inbox entries and discussions: the entries come with the prompt, as the session is new.
function inboxPrompt(task, mode, text) {
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

${modeInstructions[mode]}

${mode === "discussion" ? "The message" : "The entry"}:

${text}`;
}

// A run analysis (analysis.mjs): its digest is a file in the run's inbox (TASK_DIGEST), the
// selection the maintainer made is `text`.
function analyzePrompt(task, text) {
  return `Analyze recent Deckhand runs of ${task.repo}, on GitHub issue #${task.number}. The digest of
the runs is at \`$TASK_DIGEST\` (\`cat "$TASK_DIGEST"\`; it is large: read it in parts if you
need to).

${modeInstructions.analyze}
${text ? `\nThe selection:\n\n${text}\n` : ""}`;
}

// A research run (modes.mjs OPEN) has no token to read the issue with: its thread is a file in
// the run's inbox (TASK_DIGEST, preparation.mjs threadDigest()).
function researchPrompt(task) {
  return `Research what GitHub issue #${task.number} of ${task.repo} asks. Its thread (title, description
and latest comments) is at \`$TASK_DIGEST\` (\`cat "$TASK_DIGEST"\`).

${modeInstructions.research}`;
}

// "critical, high or medium".
const severityList = (list) =>
  list.length > 1 ? `${list.slice(0, -1).join(", ")} or ${list.at(-1)}` : list.join("");

// prompts/review.md's verdict rule with `allowed` the most severe finding that doesn't block
// (reviews' tolerance()): the severities that block, from the list the parser blocks on, and
// with medium allowed, what the review says of the findings it tolerates.
function verdictRule(text, allowed) {
  const blocking = blockingSeverities(allowed);
  const tolerated = blockingSeverities().filter((s) => !blocking.includes(s));
  const note = tolerated.length
    ? `
  This review tolerates ${severityList(tolerated)} findings (the repository's
  \`review.max_allowed_severity\`): report them at their severity, and they still cap the
  rating as above, but they don't block this pull request. With ${severityList(tolerated)}
  findings and no ${severityList(blocking)} one, the verdict is \`comment\`, and the summary
  says the ${severityList(tolerated)} findings don't block it.`
    : "";
  return text.replaceAll("<blocking>", severityList(blocking)).replace("<tolerated>", note);
}

// A review (reviews.mjs) of pull request `pull`: its task may be the issue the pull request
// closes. Its thread is a file in the run's inbox (TASK_DIGEST, reviews.mjs reviewThread()).
// `instructions`: the repo's `review.instructions` file, if any; `text`: what the
// "/mode review" comment adds; `allowed`: the review's tolerance (verdictRule()).
function reviewPrompt(task, pull, instructions, text, allowed = "low") {
  const own = instructions?.trim()
    ? `\n\nThe repository's review instructions:\n\n${instructions.trim()}`
    : "";
  const asked = text ? `\n\nThe maintainer asks:\n\n${text}` : "";
  const rules = verdictRule(modeInstructions.review.replaceAll("<n>", String(pull)), allowed);
  return `Review pull request #${pull} of ${task.repo}.

${rules}${own}${asked}`;
}

function brainstormPrompt(task) {
  return `Brainstorm GitHub issue #${task.number} of ${task.repo} with the maintainer. Read it with
\`gh issue view ${task.number} --comments\`.

${modeInstructions.brainstorm}`;
}

// Onboarding: its instructions, what this Deckhand allows the repo (a config can only narrow
// it, the operator's grants widen it: `grant`, grantFor()), and the config's reference.
function onboardingPrompt(task, settings, config, grant) {
  const { repo, number } = task;
  const none = (items) => (items.length ? items.map((i) => `\`${i}\``).join(", ") : "none");
  const roots = grant.mounts.map((m) => `${m.root}${m.readOnly === false ? " (read-write)" : ""}`);
  return `Onboard ${repo} with the maintainer, on GitHub issue #${number}. Read it with
\`gh issue view ${number} --comments\`.

${modeInstructions.onboarding}

## This Deckhand

- Trigger (confirms the proposal, alone on the first line of a comment): \`${triggerWord(settings.trigger)}\`
- Users who may start runs (\`ALLOWED_USERS\`; \`users\` can only narrow it): ${none(config.users)}
- Hosts every sandbox reaches: ${none(mandatoryHosts(config))}
- Hosts the operator grants this repository (\`grants/default.yaml\` and \`grants/${repo.toLowerCase()}.yaml\`): ${none(grant.hosts)}; any other is refused until the operator adds it there (\`.deckhand.yaml\` has no \`hosts\`)
- Host mount roots granted to this repository: ${roots.length ? none(roots) : "none: a \`mounts\` entry would be refused until the operator grants a root"}
- \`preview\` in \`.deckhand.yaml\`: ${grant.allowPreview ? "allowed: the operator grants this repository a preview hook" : "not granted: a \`preview\` hook stops runs until the operator sets \`allow_preview\` for this repository"}
- \`docker\` in \`.deckhand.yaml\`: ${grant.allowDocker ? (config.engine ? "allowed: its work runs get a container engine" : "granted, but the operator hasn't set up a container engine (SANDBOX_ENGINE): runs start without one") : "not granted: \`docker\` stops runs until the operator sets \`allow_docker\` for this repository"}
- Pushes that change \`.github/workflows/\`: ${grant.allowWorkflows ? "allowed: the operator grants this repository \`allow_workflows\`; Deckhand refuses a changed workflow without a top-level \`permissions:\` of \`read\` or \`none\` scopes only, or that mentions \`secrets\`" : "not granted: GitHub refuses them until the operator sets \`allow_workflows\` for this repository"}
- \`dockerfile\` in \`.deckhand.yaml\`: ${grant.allowDockerfile ? `allowed${grant.allowBranchDockerImages ? ", from pull requests' own branches too" : ""}` : "not granted: a \`dockerfile\` stops runs until the operator sets \`allow_dockerfile\` for this repository"}
- Models: work \`${settings.model}\` (${settings.effort} effort), brainstorms \`${settings.brainstormModel}\` (${settings.brainstormEffort})

## Reference: \`.deckhand.yaml\` (docs/repo-config.md)

${configReference}`;
}

// The run the trigger line starts on an onboarding issue: the agreed files, nothing else.
function onboardingWorkPrompt(task) {
  const n = task.number;
  const { base } = task;
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

// What the agent reads for a brainstorm run, besides the comments themselves.
function brainstormMessage(mode, text, restored) {
  if (mode === "stop") {
    return `The maintainer ends the brainstorm here${text ? `, adding:\n\n${text}\n\n` : ". "}Wrap up as in step 4 of your instructions: create the follow-ups that were kept, post the summary and update the issue's description with what was decided.`;
  }
  return restored
    ? `${text}\n\n(The brainstorm resumes after a pause: check the issue for comments you haven't seen.)`
    : text;
}

// Before `gh pr ready`: the base may have moved during the run, and a pull request marked
// ready with conflicts isn't ready (github-pulls.mjs refuses it too). `base`: a branch name, or
// how to find it.
function rebaseStep(base) {
  return `bring the branch up to date: \`git fetch origin\`, \`git rebase origin/${base}\`,
resolve any conflicts, run the checks again, then \`git push --force-with-lease\` (rewriting
history is fine on this branch only). If a conflict can't be resolved safely (both sides
changed the same behaviour, say), stop and ask instead of guessing (see "Stopping to ask" in
your instructions).`;
}

// Where a pull request's run may push: its branch (`branches`, preparation.mjs pushBranches()), or
// nowhere when that branch is in a fork.
function prPush(branches) {
  return branches.length
    ? `push to its branch, \`${branches.at(-1)}\`: Deckhand refuses pushes to any other`
    : `you can't push: its branch is in a fork, so describe the changes in your reply instead`;
}

// The branches an issue's run may push: its own, and the pull requests' heads it was asked
// from (preparation.mjs pushBranches()), named so it doesn't pick another one.
function issueBranches(n, branches) {
  const others = branches.filter((b) => b !== `issue-${n}-*` && !b.startsWith(`issue-${n}-`));
  const extra = others.map((b) => ` or \`${b}\``).join("");
  return `\`issue-${n}-…\`${extra}`;
}

// Whether the run's pushes may change workflow files (git-gateway.mjs), so a run that can't
// says so rather than retrying GitHub's refusal. Nothing for a run that can't push at all (a
// fork's pull request): prPush() already says so.
function workflowsNote(task, grant, branches) {
  if (task.kind === "pr" && !branches.length) return "";
  return grant?.allowWorkflows
    ? "Pushes may add or change files under `.github/workflows/` (the operator grants `allow_workflows`),\nbut Deckhand refuses a changed workflow unless it has a top-level `permissions:` (`read-all`, `{}`,\nor scopes set to `read` or `none`), no `write` scope in any job, and doesn't mention `secrets`\nanywhere or call a reusable workflow from another repository, and no job has an\n`environment:`; it reads a strict YAML subset (no anchors, aliases, tags, merge keys, duplicate keys or\nmulti-line quoted scalars). It checks the branch merged with the default branch too: rebase on it\nfirst. Say in the pull request what a workflow would need beyond that."
    : "GitHub refuses pushes that add or change files under `.github/workflows/` (the operator\ndoesn't grant `allow_workflows`): leave them out and say in the pull request what they need.";
}

function initialPrompt(task, branches = [], grant = null) {
  const { base } = task;
  const workflows = workflowsNote(task, grant, branches);
  const common = `${workflows && `${workflows}\n`}Follow the repository's AGENTS.md and CLAUDE.md if it has them, with tests where the
code has them, and run the checks they list before pushing. Never push to ${base}. When
something is ambiguous, pick the reasonable option and say so rather than stopping, unless it
is a blocker only the maintainer can resolve: then push your work in progress and end with
your questions (see "Stopping to ask" in your instructions).
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
   you. Deckhand refuses pushes to branches not named ${issueBranches(task.number, branches)}.
3. Implement it, pushing to the same branch as you go.
4. When the checks pass, update the pull request with \`gh pr edit\`: final title, and a
   description with \`Closes #${task.number}\`, what changed and why, any choice you made, and
   screenshots if the UI changed (see "Screenshots" in your instructions).
5. Before marking it ready for review with \`gh pr ready\`,
${rebaseStep(base)}
${common}`;
}

// A run in one of the repo's own modes: its instructions (`instructions`, the file's text
// from the default branch) after what every run of that kind is told. The agent's
// instructions have the generic rules, as for work.
function modePrompt(task, own, instructions, branches = [], grant = null) {
  const { number: n, repo } = task;
  const { base } = task;
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
(Deckhand refuses pushes to branches not named ${issueBranches(n, branches)}). Never push to ${base}.`;
  const note = own.light ? "" : workflowsNote(task, grant, branches);
  const workflows = note && `\n${note}`;
  return `You are in the "${own.name}" mode of this repository, on ${where}.

${rules}${workflows}
Don't post comments on GitHub yourself: your final message is posted for you as the reply.

The ${own.name} mode's instructions, from the repository:

${instructions.trim()}`;
}
// The run's prompt, by what it is. `own`: the repo's mode, with its `instructions` text;
// `onboardingWork`: a work run on an onboarding issue; `grant`: what the operator grants the
// repo (grantFor()); `branches`: what the run may push (preparation.mjs pushBranches());
// `pull`: the issue or pull request the reply goes to, the one a review reads; `allowed`: a
// review's tolerance (reviews' tolerance()).
export function promptFor(
  task,
  {
    mode,
    text,
    settings,
    own,
    instructions,
    onboardingWork,
    config,
    grant,
    branches,
    pull,
    allowed,
  },
) {
  if (mode === "brainstorm" || mode === "stop") return brainstormPrompt(task);
  if (INBOX.has(mode)) return inboxPrompt(task, mode, text);
  if (mode === "analyze") return analyzePrompt(task, text);
  if (mode === "research") return researchPrompt(task);
  if (mode === "review")
    return reviewPrompt(task, pull ?? task.number, instructions, text, allowed);
  if (mode === "onboarding") return onboardingPrompt(task, settings, config, grant);
  if (own) return modePrompt(task, own, instructions, branches, grant);
  return onboardingWork ? onboardingWorkPrompt(task) : initialPrompt(task, branches, grant);
}

// A session that goes on runs in a new container: its transcript still names files of earlier
// runs (worktrees, screenshots, saved outputs under /tmp) that are gone, and the clone was reset
// (entrypoint.sh reset_clone(): untracked files stashed on work runs, else removed; ignored ones
// removed).
const NEW_CONTAINER =
  "This run is a new container: your session is kept, and so are /workspace's commits and branches, but its uncommitted files were stashed (`git stash list`) or removed, its ignored files removed, and /tmp and the rest of the container's own files are new (the repository's caches and mounts aside). Recreate what you need (worktrees, screenshots, servers, files) instead of reading paths from earlier runs.";

// The run's first message, after its prompt: the comments. `started`: the session goes on.
export function firstMessage({ mode, text, restored, started }) {
  const talk = mode === "brainstorm" || mode === "stop";
  const body = talk ? brainstormMessage(mode, text, restored) : text;
  // An empty follow-up (only "/model …", say) would open an interactive session instead.
  if (started) {
    return `${body || "Continue."}\n\n(${NEW_CONTAINER} Don't post comments on GitHub yourself: your final message is posted as a reply.)`;
  }
  // A new inbox session reads its entries in the prompt (inboxPrompt()), an analysis its
  // selection (analyzePrompt()), a review what the comment asks (reviewPrompt()).
  return INBOX.has(mode) || mode === "analyze" || mode === "review" ? "" : body;
}

// A run that falls back to the same agent on another provider (runs.mjs): its session goes on,
// and the comments come again after this.
export function retryNote({ reason, provider }) {
  return `(Your provider failed: ${reason}. This run goes on in the same session through ${provider}: carry on where you stopped.)`;
}

// A run that falls back to another agent, or that `/agent` gives to another one (runs.mjs):
// sessions don't move between agents, so it starts a new one on what the previous agent left.
// `from`: that agent and its provider; `reason`: why its provider failed (none: `/agent`);
// `result`: its last message, if any; `body`: what the run was asked (firstMessage()).
export function handoffMessage({ from, reason, result, body, branches = [] }) {
  const pushes = branches.length
    ? `; its branch, and yours: ${branches.map((b) => `\`${b.replace(/\*$/, "…")}\``).join(" or ")}`
    : "";
  const last = (result ?? "").trim();
  const quoted =
    last &&
    (last.length > 2000 ? `${last.slice(0, 1999)}…` : last)
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
  const why = reason
    ? `${from} was working on this and stopped, as its provider failed: ${reason}.`
    : `${from} was working on this before; this comment asked for you instead (\`/agent\`).`;
  return `${why} You take over, in a new session: sessions don't move between agents, so start from what it left. /workspace is the clone it worked in, with what it hadn't committed (\`git status\`, \`git log\`)${pushes}; GitHub has what it pushed and posted. The rest of its container (/tmp included) is gone.${quoted ? `\n\nIts last message:\n\n${quoted}` : ""}${body ? `\n\nWhat it was asked:\n\n${body}` : ""}`;
}

// The agent's first message, and when another agent takes over the issue's session
// (agents/select.mjs resolveEntry()), what it is handed (handoffMessage(), once the run's branches
// are known). The same agent on another provider: its session goes on, told why.
export function openingMessages(mode, text, chosen, { restored, started, previous }) {
  const { entry, switched, handedBy, takeOver } = chosen;
  const retry = switched && !takeOver;
  const said = retry
    ? `${retryNote({ ...switched, provider: providerLabel(entry) })}\n\n${text}`
    : text;
  const message = firstMessage({ mode, text: said, restored, started });
  const handoff = takeOver && {
    from: handedBy
      ? entryLabel(entryName(previous.agent, previous.provider, previous.credential))
      : entryLabel(switched.from),
    reason: handedBy ? null : switched.reason,
    result: handedBy ? previous.summary : entry.result,
    body: firstMessage({ mode, text, restored, started: false }),
  };
  return { message, handoff };
}

// What the agent reads for comments delivered mid-run (Claude Code adds that the user sent it
// while it was working).
export function liveMessage(mode, text) {
  const reply =
    "Your final message is still posted as the single reply for this run: make it cover this comment too. (Don't post comments on GitHub yourself.)";
  if (mode === "brainstorm") {
    return `New comment on the issue: ${text}\n\n(Still a brainstorm: no code, branch, commit or pull request, and new issues only for kept follow-ups. ${reply})`;
  }
  if (FRESH.has(mode) && mode !== "analyze") {
    return `Another entry arrived on the inbox while you were working:\n\n${text}\n\nHandle it like the others, as its own entry. ${reply}`;
  }
  if (mode === "discussion") return `New comment in the discussion:\n\n${text}\n\n${reply}`;
  if (mode === "onboarding") {
    return `New comment on the issue: ${text}\n\n(Still onboarding: no code, branch, commit, pull request or new issue. ${reply})`;
  }
  return `New comment on this issue while you are working:\n\n${text}\n\nTake it into account from here on. ${reply}`;
}
