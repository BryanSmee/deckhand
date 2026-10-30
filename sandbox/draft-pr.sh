#!/bin/bash
# Opens the task's draft pull request from the sandbox, so it never depends on the agent
# remembering to (the prompts only say it is there).
#
#   sandbox-draft-pr start   before the agent starts (entrypoint.sh): on the base branch, checks
#                            out the task's branch (issue-<n>-<slug>), with an empty
#                            "#<n>: start work" commit when it is new, pushes it and opens the
#                            draft.
#   sandbox-draft-pr hook    the agent's hook (Claude Code's managed-settings.json, Codex's
#                            and agy's hooks.json: after a `git push`, and when it stops; `hook
#                            Stop` without its payload): opens the draft for the current branch
#                            if it is pushed and has no pull request yet, whatever its name.
#                            Never blocks the agent: after a push it only tells it the URL.
#                            Both times, for every run, it then uploads the run's screenshots
#                            (deckhand-files shots), last and within 20 s, so the final message
#                            and the pushed work find them before the sandbox stops.
#
# Only for work runs on an issue: TASK_ISSUE (GitHub issue number, from the listener).
# Brainstorms and pull request runs don't set it, so nothing is created for them. TASK_BRANCH:
# the branch the listener created at the base's head and linked to the issue
# (listener/linked-branch.mjs), checked out and given its first commit here; with it, a repo's
# own mode a policy let link one opens its draft too. Never fails the run: problems go to
# stderr.
set -uo pipefail

base=${BASE_BRANCH:-main}

# The hook's event ("Stop ", "PostToolUse <command>"), read once: its payload is on stdin.
if [ "${1:-}" = hook ]; then
  if [ -n "${2:-}" ]; then
    event="$2 "
  else
    event=$(jq -r '"\(.hook_event_name) \(.tool_input.command // "")"')
  fi
  # Its stdout is the agent's hook answer, and a hook's stderr reaches only the run's log
  # (--log): a refusal is still told by the next gh call or push. After `git push`, pre-push
  # uploaded and told already. Last, on exit (the early ones below too), and within 20 s: the
  # draft pull request and its URL come first in the agent's 60 s for the hook, so its gh
  # calls don't upload (DECKHAND_SHOTS_SKIP, the gh wrapper).
  case $event in
    "Stop "* | PostToolUse*"git push"*)
      [ -z "${SCREENSHOT_DIR:-}" ] ||
        trap 'timeout 20 deckhand-files shots --log > /dev/null || true' EXIT
      ;;
  esac
  export DECKHAND_SHOTS_SKIP=1
fi

# In .git: survives between runs of the same issue, never committed.
cache=/workspace/.git/deckhand-task.json

[ "${TASK_MODE:-work}" = work ] || [ -n "${TASK_BRANCH:-}" ] || exit 0
[ -n "${TASK_ISSUE:-}" ] || exit 0
cd /workspace || exit 0

# "Café : bientôt" → "cafe-bientot", short enough for a branch name. A title with no Latin
# letter or digit ("修复登录") gives "task": the gateway takes issue-<n>-<something> only.
slug() {
  node -e 'process.stdout.write(require("fs").readFileSync(0, "utf8").normalize("NFD")
    .replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "")
    .slice(0, 50).replace(/-+$/, "") || "task")'
}

# Title and branch name of the issue, as JSON, looked up once. The listener's TASK_BRANCH
# over a name kept from an earlier run.
info() {
  local kept title branch
  kept=$([ -s "$cache" ] && jq -r .branch "$cache")
  if [ -n "$kept" ] && [ "${TASK_BRANCH:-$kept}" = "$kept" ]; then
    cat "$cache"
    return
  fi
  title=$(gh issue view "$TASK_ISSUE" --json title --jq .title) || return 1
  branch=issue-$TASK_ISSUE-$(slug <<< "$title")
  branch=${TASK_BRANCH:-${branch%-}}
  jq -n --arg title "$title" --arg branch "$branch" '{title: $title, branch: $branch}' |
    tee "$cache"
}

# Opens the draft for the current branch when it is pushed and has no pull request (open,
# closed or merged: never a duplicate). Prints its URL when it opened one.
ensure() {
  local branch task title body
  branch=$(git branch --show-current)
  [ -n "$branch" ] && [ "$branch" != "$base" ] || return 0
  git ls-remote --exit-code --heads origin "$branch" > /dev/null || return 0
  [ -z "$(gh pr list --head "$branch" --state all --json number --jq '.[].number')" ] || return 0
  task=$(info) || return 0
  title=$(jq -r .title <<< "$task")
  # The agent rewrites the title and description when the work is ready for review.
  title=${title:-$branch}
  body="Closes #$TASK_ISSUE

Work in progress: ${AGENT_NAME:-Claude} is on it and fills this in when it is ready for review."
  gh pr create --draft --base "$base" --head "$branch" --title "$title" --body "$body"
}

start() {
  # A resumed session is already on its branch (or chose to stay on the base one).
  [ "$(git branch --show-current)" = "$base" ] || return 0
  local task branch
  task=$(info) || {
    echo "draft-pr: could not read the task, the agent creates the branch" >&2
    return 0
  }
  branch=$(jq -r .branch <<< "$task")
  git fetch --quiet origin "$base"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    # Commits that aren't on the repository may be a fork's, merged in by a run that stopped
    # before pushing: entrypoint.sh left the branch for the agent to check out once it has
    # read them, not for setup to run on.
    if [ -n "$(git rev-list "$branch" --not --remotes=origin)" ]; then
      echo "draft-pr: $branch has commits that aren't pushed, the agent checks it out" >&2
      return 0
    fi
    git checkout --quiet "$branch"
  elif git fetch --quiet origin "$branch" 2> /dev/null; then
    git checkout --quiet -b "$branch" --track "origin/$branch"
    # The listener's, at the base's head: its first commit, so a pull request can open.
    if [ "$branch" = "${TASK_BRANCH:-}" ] && [ -z "$(git rev-list "origin/$base..HEAD")" ]; then
      git commit --quiet --allow-empty -m "#$TASK_ISSUE: start work"
      git push --quiet origin "$branch" || return 0
    fi
  else
    git checkout --quiet -b "$branch" "origin/$base"
    git commit --quiet --allow-empty -m "#$TASK_ISSUE: start work"
  fi
  git ls-remote --exit-code --heads origin "$branch" > /dev/null ||
    git push --quiet -u origin "$branch" || return 0
  ensure
}

hook() {
  local url
  case $event in
    "Stop "*) ensure > /dev/null ;;
    PostToolUse*"git push"*)
      url=$(ensure) || return 0
      # Tells the agent, so it doesn't try to open a second one.
      [ -z "$url" ] || jq -nc --arg url "$url" '{hookSpecificOutput: {hookEventName: "PostToolUse",
        additionalContext: "The sandbox opened draft pull request \($url) for this branch."}}'
      ;;
  esac
}

case "${1:-}" in
  start) start ;;
  hook) hook ;;
  *)
    sed -n '4,12s/^# \{0,1\}//p' "$0" >&2
    exit 2
    ;;
esac
exit 0
