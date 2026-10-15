#!/bin/bash
# Opens the task's draft pull request from the sandbox, so it never depends on Claude
# remembering to (the prompts only say it is there).
#
#   sandbox-draft-pr start   before Claude starts (entrypoint.sh): on the base branch, checks
#                            out the task's branch (issue-<n>-<slug>), with an empty
#                            "#<n>: start work" commit when it is new, pushes it and opens the
#                            draft.
#   sandbox-draft-pr hook    Claude Code hook (managed-settings.json: after a `git push`, and
#                            when Claude stops): opens the draft for the current branch if it
#                            is pushed and has no pull request yet, whatever its name. Never
#                            blocks Claude: after a push it only tells it the URL.
#
# Only for work runs on an issue: TASK_ISSUE (GitHub issue number, from the listener).
# Brainstorms and pull request runs don't set it, so nothing is created for them. Never
# fails the run: problems go to stderr.
set -uo pipefail

base=${BASE_BRANCH:-main}
# In .git: survives between runs of the same issue, never committed.
cache=/workspace/.git/deckhand-task.json

[ "${TASK_MODE:-work}" = work ] || exit 0
[ -n "${TASK_ISSUE:-}" ] || exit 0
cd /workspace || exit 0

# "Café : bientôt" → "cafe-bientot", short enough for a branch name. A title with no Latin
# letter or digit ("修复登录") gives "task": the gateway takes issue-<n>-<something> only.
slug() {
  node -e 'process.stdout.write(require("fs").readFileSync(0, "utf8").normalize("NFD")
    .replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "")
    .slice(0, 50).replace(/-+$/, "") || "task")'
}

# Title and branch name of the issue, as JSON, looked up once.
info() {
  if [ -s "$cache" ]; then
    cat "$cache"
    return
  fi
  local title branch
  title=$(gh issue view "$TASK_ISSUE" --json title --jq .title) || return 1
  branch=issue-$TASK_ISSUE-$(slug <<< "$title")
  branch=${branch%-}
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
  # Claude rewrites the title and description when the work is ready for review.
  title=${title:-$branch}
  body="Closes #$TASK_ISSUE

Work in progress: Claude is on it and fills this in when it is ready for review."
  gh pr create --draft --base "$base" --head "$branch" --title "$title" --body "$body"
}

start() {
  # A resumed session is already on its branch (or chose to stay on the base one).
  [ "$(git branch --show-current)" = "$base" ] || return 0
  local task branch
  task=$(info) || {
    echo "draft-pr: could not read the task, Claude creates the branch" >&2
    return 0
  }
  branch=$(jq -r .branch <<< "$task")
  git fetch --quiet origin "$base"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git checkout --quiet "$branch"
  elif git fetch --quiet origin "$branch" 2> /dev/null; then
    git checkout --quiet -b "$branch" --track "origin/$branch"
  else
    git checkout --quiet -b "$branch" "origin/$base"
    git commit --quiet --allow-empty -m "#$TASK_ISSUE: start work"
  fi
  git ls-remote --exit-code --heads origin "$branch" > /dev/null ||
    git push --quiet -u origin "$branch" || return 0
  ensure
}

hook() {
  local event url
  event=$(jq -r '"\(.hook_event_name) \(.tool_input.command // "")"')
  case $event in
    "Stop "*) ensure > /dev/null ;;
    PostToolUse*"git push"*)
      url=$(ensure) || return 0
      # Tells Claude, so it doesn't try to open a second one.
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
