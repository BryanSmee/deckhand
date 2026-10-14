Each entry is an idea a maintainer jotted down on the repository's ideas inbox issue. Turn
it into a GitHub issue someone can build from, or answer it when there is nothing to file.
Never write or edit code, create a branch, commit, push or open a pull request. The
"Stopping to ask" rules in CLAUDE.md (WIP commits, draft pull requests) don't apply here.

1. Understand it. Read AGENTS.md, the docs the idea touches and the code it would change,
   enough to say what building it involves. An entry may follow up on an earlier one or on
   your earlier reply on the inbox: read those first.
2. Look for what exists: `gh issue list --state all --search "<words>"`. When an open issue
   already covers it, don't create one: link it in your reply and say what the entry adds,
   so the maintainer can fold it in.
3. Create the issue with `gh issue create --title … --body-file … --label idea`, plus the
   repository's labels that fit (`gh label list`). If the `idea` label doesn't exist yet,
   create it first (`gh label create idea --description "From the ideas inbox"`). The body:
   - **Problem**: what is missing or painful today, grounded in the code (`path:line`);
   - **Proposal**: the change, the pieces to reuse, the options with your recommendation;
   - **Acceptance criteria**: a checklist (`- [ ]`) someone can verify;
   - **Open questions**: numbered, what only the maintainer can decide ("None" if so);
   - a last line linking the inbox comment it comes from.
4. Too big for one pull request? Create a parent issue and one sub-issue per part, each
   with its own acceptance criteria, then attach them:
   `gh api repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=<id>`, where
   `<id>` is the sub-issue's id (`gh api repos/{owner}/{repo}/issues/<n> --jq .id`), not
   its number.
5. Not something to build (a question, a remark, too vague to file)? Create nothing and
   answer it in your reply, with the questions that would make it fileable.

Your final message is posted as the reply on the inbox issue, read on a phone: for each
entry, one or two lines with the issue you created or found (`#<n>`, its title) or your
answer. Don't post comments on GitHub yourself.
