Each entry is a bug a maintainer reported on the repository's bug reports inbox issue.
Find where it comes from and file it as a GitHub issue someone can fix from, or answer it
when there is nothing to file. Never write or edit code, create a branch, commit, push or
open a pull request: the fix comes later, from the issue. The "Stopping to ask" rules in
your instructions (WIP commits, draft pull requests) don't apply here.

1. Understand it. Read AGENTS.md and the code the report points to; follow the path from
   what the user sees to its likely cause, and say how sure you are. The clone is set up
   for reading, not running (the project's setup was skipped). An entry may follow up on an
   earlier one or on your earlier reply on the inbox: read those first.
2. Look for what exists: `gh issue list --state all --search "<words>"`, and the recent
   history of the files involved (`git log -p -- <path>`). When an open issue already
   covers it, don't create one: link it in your reply and say what the entry adds. When a
   closed one fixed it before, say so: it may be a regression.
3. Create the issue with `gh issue create --title … --body-file … --label bug`, plus the
   repository's labels that fit (`gh label list`). If the `bug` label doesn't exist yet,
   create it first (`gh label create bug --description "Something isn't working"`). The
   body:
   - **Problem**: what happens, what should happen, how to reproduce (from the report; say
     what it doesn't tell);
   - **Cause**: where it likely comes from, citing `path:line`, and how sure you are;
   - **Proposal**: the fix, and what else it may touch;
   - **Acceptance criteria**: a checklist (`- [ ]`), with a test that would have caught it;
   - **Open questions**: what only the maintainer can decide, in the open questions format
     of your instructions, or "None" alone; nothing you settled yourself (that goes in the
     Proposal). Leave every box unticked: a ticked one (`- [x]`) is the maintainer's answer;
   - a last line linking the inbox comment it comes from.
4. Several separate bugs in one entry: one issue each. One bug with several parts to fix:
   a parent issue and sub-issues (`gh api repos/{owner}/{repo}/issues/<parent>/sub_issues
-F sub_issue_id=<id>`, with the sub-issue's id from
   `gh api repos/{owner}/{repo}/issues/<n> --jq .id`, not its number).
5. Not a bug (expected behaviour, a usage question, not enough to go on)? Create nothing
   and answer it in your reply, with what you would need to know.

Your final message is posted as the reply on the inbox issue, read on a phone: for each
entry, one or two lines with the issue you created or found (`#<n>`, its title, the likely
cause) or your answer. Don't post comments on GitHub yourself.
