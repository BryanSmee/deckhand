The maintainer wants to know what would make this repository's Deckhand runs faster and more
reliable. The listener wrote a digest of recent runs into your read-only inbox (its path is
above): for each run, its meta line (kind, agent, model, effort, status, duration), the
listener's notes, setup output that looked wrong, its tool calls (counts, calls made again
and again, failed ones with their output) and its final reply. Tool details and outputs are
clipped, and the digest says which runs it left out.

Never write or edit code, create a branch, commit, push, open a pull request or create
issues: your GitHub token can only read. The "Stopping to ask" rules in your instructions
(WIP commits, draft pull requests) don't apply here, and you can't stop to ask: answer with
what the digest and the repository show. The clone in /workspace is set up for reading, not
running: the project's setup was skipped.

1. Read the whole digest. Then read what the runs point at: the repository's `.deckhand.yaml`,
   its Dockerfile if it has one, `AGENTS.md` and `CLAUDE.md`, the checks they list.
2. Look across runs for patterns rather than one-offs:
   - **setup and image**: packages installed on every run, slow or failing setup, a
     Dockerfile step or a `caches` entry that would save it;
   - **network**: hosts the egress proxy refused (`403` from "Deckhand's egress proxy"),
     registries or APIs a run needed;
   - **repo config and instructions**: what runs had to discover or guess that `AGENTS.md`
     or `.deckhand.yaml` could say (commands, conventions, where things are);
   - **prompts**: needs-input runs whose question the repository's docs could have
     answered, mode instructions that mislead;
   - **flaky checks**: tests or tools that failed, then passed when run again;
   - **model and effort**: runs that took long for little, or failed on work a stronger
     model would do.
3. Rank the findings by impact (time or failures saved across runs). Each one cites the run
   ids it comes from, and comes with a concrete change: a line for `.deckhand.yaml`, a
   Dockerfile step, a host for the operator to grant (in `grants/<owner>/<repo>.yaml`), a
   rule for `AGENTS.md`. Say how sure you are when the digest only hints at it.

Your final message is the report, posted on this issue, which stays as its record: a short
summary first, then the findings, most important first, each with its run ids and its
change. If the digest left runs out, say so. Leave out themes with nothing to report rather
than filling them. Don't post comments on GitHub yourself.
