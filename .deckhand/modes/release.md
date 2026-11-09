# Prepare a release

You draft this repository's release. The maintainer reviews and publishes it. Read
`docs/contributing/releases.md`, `AGENTS.md`, the release issue and all its comments first.
These mode instructions keep the prepare pull request **draft**, even when the ordinary
work instructions would mark it ready. Never tag, create or edit a GitHub release, merge,
enable auto-merge, mark ready, or push outside this issue's branch. Do not post comments:
edit the issue and pull request bodies; Deckhand posts your final reply.

## Establish the release

- Take the version from the issue's `Release vX.Y.Z` title and the milestone from the issue.
  A completed milestone represents a new concept and normally a minor release. Read its
  description and all its issues, open and closed, with pagination. If the version or
  milestone is missing or contradictory, ask in Open questions; do not invent a release.
- Fetch `origin/main` and tags. Record the main commit audited and the previous published
  stable release tag reachable from it (exclude drafts and prereleases). Inspect the history
  and the merged pull requests between that tag and the audited commit, including changes
  outside the milestone. Paginate results and reconcile them with git history; don't use
  only the first page, milestone membership, or merge dates as the release boundary. Ask if
  the baseline cannot be established.
- Work on the branch and draft pull request the sandbox opened for this issue before you
  started (`gh pr view`); it is the prepare pull request. On continuation, read your earlier
  checklist and gap issues first.

## Checklist in the release issue

Preserve the maintainer's scope, decisions and other text. Add or refresh a `Release
checklist` section in the issue body, using `gh issue edit --body-file`. Record the audited
commit and tag range. Keep every unchecked or failed item visible, with a reason and a gap
issue or question. Tick an item only when its evidence proves it: a permalink to the issue,
pull request or CI run, a source file and line at the audited commit, or the command and its
result. A closed issue alone is not evidence that its acceptance criteria pass.

Include these checks, broken into individual items where needed:

- Every milestone issue is closed and every acceptance criterion is ticked and supported
  by the implementation or a passing test. Identify unchecked criteria and closed issues
  whose implementation is incomplete. Do not tick or rewrite another issue's criteria.
  Exclude the release tracking issue itself from this closure check; it closes only after
  the release preparation is merged. Newly filed gap issues remain blockers.
- The docs explain the milestone's concept as the code implements it: defaults, settings,
  commands, installation and upgrade behaviour. Link the code and the corresponding docs.
- When an on-screen flow changed, check the screenshots using
  `cd dashboard && npm run screenshots`, inspect desktop/mobile and both themes, and check
  the demo's scenario against the new flow. Generated files are evidence, not additions to
  this prepare pull request. File a gap for stale screenshots or a scenario needing work.
  If the demo or scenario is outside the repository or cannot be found, ask for its location;
  do not claim it was checked. When no flow changed, record why this check is not applicable.
- Build the docs site and run its link tests using the commands in `AGENTS.md`.
- Check the **Checks** workflow on the exact audited `main` commit: every required job must
  pass. Link the run; pending, missing or inaccessible results are not green. Local tests
  do not substitute for main's CI.
- Read every merged pull request's `Runs in flight` section and relevant upgrade notes.
  Check running old sandboxes against new services, new runs on older sandbox images, and
  resumed runs' stored state. A missing section is unknown, not "None affected": inspect
  the diff and file a gap or ask if it cannot be established.
- Add this release's particular steps: migrations, renamed settings, compatibility shims,
  recovery commands, image pulls or other operator actions. Give each its source and owner;
  future maintainer actions stay unchecked until there is evidence they happened.

## Gaps and questions

Search for an existing issue before filing each gap. File concrete, independently fixable
gaps with acceptance criteria and the evidence, in the release milestone. Do not implement
them on the prepare branch or apply `auto-pickup`. Attach each new issue as a sub-issue of
the release issue, using the issue's numeric API `id` for `sub_issue_id` at
`POST /repos/{owner}/{repo}/issues/{release}/sub_issues`. Link it from the checklist. Where
order matters, add a blocked-by link on the dependent issue at
`POST /repos/{owner}/{repo}/issues/{dependent}/dependencies/blocked_by`, with the blocker's
numeric `issue_id`. Reuse existing links on continuation. An existing unrelated gap stays
linked in the checklist; do not edit it or reparent it from another parent.

Put decisions only the maintainer can make under `## Open questions` in the release issue
body, using the sandbox's numbered questions and unticked options format. Put resolved
answers under `## Decisions`; when none remain, write `None` alone under Open questions.
If blocked, also start your final reply with `<!-- needs-input -->` and ask only the still
open questions there, as the sandbox instructions require. Keep the draft and push any
reviewable preparation first. Never bypass a refused write.

## Draft prepare pull request

Change **only** these two files on this issue's branch:

1. `deploy/helm/deckhand/Chart.yaml`: set `appVersion` to the release without `v`; set
   `version` to the same `X.Y.Z`, following this repository's chart/release convention.
   Both must advance from their current values; ask if the proposed version cannot do so.
2. `.github/release-notes/vX.Y.Z.md`: write operator-facing notes from the merged pull
   requests, with links to them and to the relevant upgrade notes. Explain the new concept,
   changed behaviour and required actions, rather than dumping commit titles. Include a
   `Runs in flight` section gathering every breaking case, its affected runs and the chosen
   mitigation or recovery commands, with source links. Say `None affected` only when verified.

Keep screenshot regeneration and other audit artifacts out of the commit. Fixes to docs,
demo scenarios, screenshots, tests or implementation belong in the gap issues. Do not
change workflows; replacing generated release notes with the prepared file remains a
maintainer command.

Give the draft a title `Prepare vX.Y.Z`, `Closes #<release issue>`, the milestone, links to
the checklist and gaps, the audited range, validation results, and `Runs in flight` with
the operator actions. Run the required repository checks; inspect the diff against main
to ensure only the two allowed files changed. Fetch and rebase before the final push. If
main moved, update the audited range, notes and checks before claiming they are current.
Keep the pull request draft even when all preparation checks pass. End with its link, the
checklist's status, remaining blockers, and checks with their results. The maintainer alone
marks it ready, merges, tags, checks published images, replaces release notes and uploads
the demo.
