This is a grooming, not an implementation: go through the repository's open issues with the
maintainer and find those that no longer match the code, as a colleague who has done the
homework. Never write or edit code, create a branch, commit, push or open a pull request. The
"Stopping to ask" rules in your instructions (WIP commits, draft pull requests,
`<!-- needs-input -->`) don't apply here.

Each of your final messages is posted as a comment on this issue, and each of the
maintainer's comments comes back to you as the next message of this conversation.

1. The pass. List the open issues (`gh issue list --state open --limit 200 --json
number,title,labels,updatedAt`), oldest first, without this issue and the inbox issues:
   those `.deckhand.yaml` names under `inbox` (`ideas`, `bugs`) on the default branch, whose
   comments are entries, not work. For each, check what it describes against the code (cite
   `path:line`), the merged pull requests (`gh pr list --state merged --search "<words>"`) and
   the other issues, and give it a verdict:
   - **done**: what it asks has landed (the pull request or commit that did it);
   - **obsolete**: a change made it irrelevant (the files or design it builds on are gone);
   - **duplicate** of another open issue (which one, and which of the two to keep);
   - **outdated**: still valid, but its paths, line numbers, settled questions or proposal no
     longer match the code;
   - **fine**: nothing to change (list these in one line, not in the table).
2. Reply in batches of about 15 issues: a table with the issue (`#<n>` and title), the
   verdict, the evidence and the change you propose (close as not planned or as a duplicate
   of `#<n>`, the edit to its title or description, a label). End every reply with **Decided**
   (the changes the maintainer agreed to so far) and **Open** (the proposals still waiting for
   an answer), and with where the next batch starts. Don't reopen what was settled.
3. Comments on other issues: only when the maintainer agrees to one, or to ask the issue's
   author something only they can answer (say so in your reply). Keep them short, and link
   this issue. Don't edit, label or close any issue before the wrap-up: those wait for it.
4. The wrap-up: when the maintainer ends the grooming (`/stop`), apply what was agreed, and
   nothing else:
   - edits: the title or description as agreed (`gh issue edit <n> --title … --body-file …`),
     keeping its structure (Problem, Proposal, Acceptance criteria, Open questions);
   - labels: `gh issue edit <n> --add-label …` (`--remove-label` to drop one);
   - closes: as not planned (`gh issue close <n> --reason "not planned" --comment …`), or as a
     duplicate (`gh issue close <n> --reason duplicate --comment "Duplicate of #<m>"`; not
     `--duplicate-of`, which is refused). An issue that is done is closed as not planned too,
     its comment naming the pull request that did it: closing one as completed is refused.
   - follow-ups: a merged or rewritten issue that replaces several is created with
     `gh issue create --title … --body-file …` (the same sections), and the ones it replaces
     closed as its duplicates.
     Then update this issue's description (`gh issue edit <this issue> --body-file …`) with the
     log of the pass: each issue touched, what was done to it and why, and the issues reviewed
     that needed nothing. Your reply sums it up, with what failed (a write the policies refused,
     say) and the issues left for a next pass.
5. A pass spans several runs of this conversation: keep in your replies (and in this issue's
   description at the wrap-up) which issues were already reviewed, so a pass resumed after a
   pause, or a new one started on this issue, carries on where the last one stopped.

Replies are read on a phone: short, headings and lists, no preamble, no restating of the
question.

The clone in /workspace is set up for reading, not running: the project's setup was
skipped. The base branch was fetched from `origin` at the start of this run, so read the
current code there when another branch is checked out.

Don't post comments on GitHub yourself, but on the issues you review as step 3 and 4 say: your
final message is posted for you as the reply on this issue.
