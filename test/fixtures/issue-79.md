## Problem

Work on an issue starts only when someone comments with the trigger line. To do #78 after #77, the maintainer has to watch #77 and come back to comment on #78 once it closes. Nothing in the listener can hold a comment back until something else happens:

- `splitTrigger()` (`listener/events.mjs:45-54`) knows only `Deckhand`, `/stop` and `/mode <name>`. Its other lines, `/model` and `/effort`, are read by `takeOptions()` (`listener/events.mjs:70`).
- A task is queued as soon as it is accepted (`accept()`, `listener/tasks.mjs:95-130`) and starts after the debounce. The only reason to wait is the parallel cap.
- The App gets no `issues` events (`APP_EVENTS`, `listener/github-app.mjs:20-29`), so the listener can't tell when an issue closes. It does get `pull_request` closed events, but only feeds them to `pulls.mjs` for the dashboard.
- State that must survive a restart lives in JSON files written with `writeJsonAtomic()` (`listener/store.mjs`). Nothing like that exists for a pending start.

## Proposal

### Command

A `/after #<n>` line, written like `/mode`: on the trigger line or on its own line.

```
Deckhand /after #77
```

```
Deckhand
/after #77 #80
/mode work
/effort high
Do it on top of the new parser.
```

- Parsed in `events.mjs`, next to `takeMode()`: one or more `#<n>`, same repository only. Cross-repo references (`org/repo#n`) are refused with a reply, so the check fails closed.
- It works only with a trigger line or a `/mode` line that starts a run. On its own it does nothing, like a bare `/mode` on an issue with no session.
- The rest of the comment is kept as it is: the text, `/mode`, `/model` and `/effort`. That comment is the one that starts the run later, as if it had just been posted.
- **Reply** right away: "Waiting for #77 (and #80); I'll start when they are closed." Add a reaction too (⏳ isn't a reaction GitHub offers, so 👀 as today and nothing else until the start).
- If every blocker is already closed, start now, as a normal trigger would.
- A new trigger comment on #78 without `/after` replaces the wait and starts now. `/after` again replaces the list. Cancelling: see open question 3.

### What counts as "done"

An issue closed as **completed** (`state_reason: completed`), which is what merging a pull request with `Closes #77` does. A blocker that is a pull request counts when it is **merged**.

If a blocker is closed as _not planned_, or a pull request is closed without being merged, nothing starts. Deckhand replies on #78 that #77 was closed without being done, and drops the wait.

Chains work without extra code: #79 `/after #78`, #78 `/after #77`.

### Pieces

1. **`waits.mjs`** (new, small, like `pulls.mjs`): `waits.json` through `writeJsonAtomic`. It holds the waiting task key → `{ blockers: [n…], item }`, where `item` is the plain work item: `restart.mjs` already turns a queued item into plain JSON and back (`plain`/`revive`). It also keeps a reverse index, blocker → waiting keys.
2. **Events**: add `issues` to `APP_EVENTS`. An `issues` `closed` delivery, or a `pull_request` `closed` + `merged` one, for an allowed repo looks up the waiting tasks. When a task has no blockers left, `tasks.accept(item)` runs as for a fresh comment. Document in `docs/setup.md` (next to the discussions note, line 53) that existing Apps must turn on the **Issues** event.
3. **Re-checks before starting**: the commenter must still be in the effective allowlist, and the repo config is read again from the default branch (`admit()`'s path). This is the same rule #69 wants for queued work after an allowlist change: reuse it if #69 lands first.
4. **Restart and missed webhooks**: on startup, and on a slow timer (for example every 15 minutes), ask GitHub for each blocker's state (`GET /repos/{repo}/issues/{n}`, which also covers pull requests). A webhook lost while the listener was down then still starts the work. Inject `fetch` and the clock for tests.
5. **Dashboard**: tasks that are waiting show up as "waiting for #77". `src/types.ts` and `api/state` change together.
6. **Docs**: README's command list, `docs/architecture.md` (the commands section and the module table).

### GitHub's own issue dependencies (an option)

GitHub now has native "blocked by" links between issues (`gh issue view` shows `blocked-by:` / `blocking:`). Two ways to use them:

- **A. Our own list only** (above). It is simple, and the state is entirely in `waits.json`.
- **B. Mirror it on GitHub**: `/after #77` also adds the "blocked by #77" link through the REST dependencies API, so the relation shows on the issues themselves. Later, an issue marked blocked on GitHub with a trigger comment could wait without `/after`.

I recommend **A** first, with B as a follow-up. B needs an API this listener hasn't used yet, and maybe another permission.

## Acceptance criteria

- [ ] `Deckhand /after #77` and `/after #77 #80` on its own line under the trigger are parsed. `/mode`, `/model`, `/effort` and the text are kept for the run. Tested in `test/events.test.mjs`.
- [ ] `/after` with no trigger or `/mode` line, with `org/repo#n`, or with the issue's own number is refused with a reply explaining why. Nothing waits.
- [ ] Deckhand replies right away, saying what it is waiting for. If the blockers are already closed, the run starts at once.
- [ ] Closing #77 as completed, or merging a pull request that is a blocker, starts #78's run with the saved comment, mode and options. The reply goes on #78 and links #77.
- [ ] Closed as not planned, or a pull request closed without merging: no run starts, a reply on #78 says why, and the wait is dropped.
- [ ] With several blockers, nothing starts until the last one is done.
- [ ] Waits survive a restart (`waits.json`, atomic). A blocker that closed while the listener was down is caught on startup or by the periodic check. Tested with an injected `fetch`, clock and temp dir.
- [ ] Before starting, the commenter is checked again against the current allowlist and repo config. If they no longer pass, nothing starts and the reason is logged.
- [ ] A later trigger comment on #78 replaces the wait.
- [ ] `issues` is in `APP_EVENTS`. `docs/setup.md` tells existing Apps to turn on the Issues event. README and `docs/architecture.md` document `/after`.
- [ ] The dashboard shows waiting tasks and what they wait for.
- [ ] `node --test`, the syntax checks, prettier and the dashboard checks pass.

## Open questions

1. **Command name**: `/after #77` (my pick: short, reads like the sentence), `/autostart after #77`, or `/blocked-by #77`?
2. **When a blocker counts as done**: closed as completed only, with "not planned" dropping the wait (my pick), or any close?
3. **Cancelling**: is a new trigger comment replacing the wait enough, or should there also be a `/after none` line (my pick: both, it costs little) or a dashboard button?
4. **GitHub's native dependencies**: our own list only for now (A, my pick), or mirror `/after` as a GitHub "blocked by" link from the start (B)?

From the ideas inbox: https://github.com/BryanSmee/deckhand/issues/15#issuecomment-6191710651
