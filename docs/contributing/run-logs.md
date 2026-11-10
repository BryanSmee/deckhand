# A run's log

A run's log holds the orchestrator's own lines and the sandbox's output as it came. The runner
service keeps it, as a blob of its store (`logs/<run>`,
[The runner service](each-service.md#the-runner-service)); the orchestrator writes it there as it
goes (`runner/client.mjs` `openRemote()`), and the dashboard's live view reads it from there. The
orchestrator also writes a `phase` line at each change of the run's part, with when it started
(`runlog.mjs` `enterPhase()`, its state saved for a restart): `setup` as the run begins, `image`
while the repo's image builds (then `setup` again: the sandbox starts after the build), `work` at
the agent's first event, `push` at a shell command that runs `git push` or
`gh pr create|edit|ready|merge` as a command of its own (not one quoted in a `grep`), and `work`
again at the next other tool call, `wrap-up` after its final answer. A phase whose line wouldn't fit
under `RUN_LOG_MAX_MB` isn't written. Logs from before phases have none, and read as one Work
section.

The runner keeps a log in segments (`runner/logs.mjs`, #607), so that the closed ones can leave its
store while the run goes on: `logs/<run>/<n>`, and an index (`logs/<run>/index`: each closed
segment's first byte, size and where it is, and where the open one, the last, starts). Only the open
one is appended to. It closes at a step of the run (a `phase` line, which the orchestrator sends at
the start of an append of its own, marked `step=1`), at `LOG_SEGMENT_MB` (8 MB by default),
whichever comes first, and at the run's end (an empty append marked `close=1`, from `teardown()`),
and again when the run's sandbox is removed (`DELETE /sandboxes/<name>?run=<run>`), should an
orchestrator stopped before its close never send it (#664). Closing takes two compare-and-sets of
the index: one marks the open segment `closing`, then whichever copy of the runner gets there first
records its size as it is then. An append reads the index again after its write: a segment marked or
closed meanwhile tells it whether its bytes are inside, and one past a closed segment's end is
answered with the log's size, as a conflict, so two copies handing over never lose or repeat bytes.
Callers only ever see offsets in the whole log: appends name the offset they go at, and a read
answers from the one segment holding its offset (`MAX_READ` at most). A log written before segments
(`logs/<run>`, one blob) reads as one closed segment and is appended to as it was, and an
orchestrator of the release before marks no step: its runs' logs close at the size cap only.

With blob storage (`BLOB_URL`, #608), each closed segment leaves the store: copied there under the
same key and measured (`HEAD`), then the index points at it (`where: "blobs"`, one compare-and-set),
then it is deleted from the store. It is in one place or the other at every moment, and a read takes
the index, then the store's blob or a ranged GET; one that finds the store's blob gone reads the
index again. Each closing is noted in a stream of the runner's store (`log-moves`, written before
the index says the segment is closed, so a copy stopping in between leaves a note too many, never
one too few), which the copy holding the runner's lease reads as it gets the lease, at each closing,
and every five minutes, acknowledging a note once its move is done: a move cut short after any step
is done again from the start, which does no harm. While blob storage fails, the notes stay, tried
again after a delay that doubles from 30 s to 30 minutes, and the runner's `/health` counts them and
their bytes (a warning on the dashboard's status page; the count is kept in its store, so either
copy says it, and a segment noted twice counts once). `/health` answers it from memory, never
waiting on the store: the copy acting knows it from its passes, the other reads it again in the
background every 10 s at most. A pass that fails after its copy lost the lease says nothing of it:
that is the next holder's. A copy losing the lease stops its pass at the next note. A segment whose
copy measures otherwise in blob storage (trying again would send the same bytes) is logged and left
in the store, and the notes after it go on. Retention deletes a log's segments in blob storage
first, then its index: one that fails stays for the next day's pass.

Some closed segments have no note (#671): those closed while `BLOB_URL` was unset, and those the
release before the notes closed as it handed over. The first copy acting with blob storage
notes them before its first pass, from the logs' indexes (`logs/<run>/index`, the only values
under `logs/`, listed once): a key of its store (`log-moves/swept`) says it was done, so the
next holder doesn't list them again, and a copy acting without blob storage deletes it, so that
setting `BLOB_URL` again sweeps again. A sweep cut short by the lease going is done again by the
next holder; a segment noted twice moves once.

The run's record keeps its phase too, for the dashboard's task state (`board.mjs`
`runState()`): `scheduled` from the moment the run leaves the queue (`setup`: its settings,
sandbox, clone and the repo's `setup`), `building-image` while the image builds (a step of
its scheduling, then `scheduled` again), `working` from the agent's first event on. The
record is saved with the live run, so a restart during setup still shows it `scheduled`;
a record saved before records kept their phase takes its log's. The dashboard's states are all
listed in `board.mjs` (`STATES`, and the comment above it) and in [the dashboard](../guides/dashboard.md#task-states); `in-review`, between the runs of a review loop, is in [Reviews](reviews.md).

The dashboard times slow steps from `at` lines (`{"type":"listener","event":"at","at":…}`), and
shows each line's time of day when Preferences says (#719). The runner follows the sandbox with
`docker logs --follow --timestamps` (`runner.follow()` hands each line Docker's time, without the
stamp, after a restart too; Docker also stamps each 16 KiB part of a longer line inside it,
moby/moby#37681, and those stamps go too). Before an agent line with a tool call, a tool result, a
message or a result, `runs.mjs` writes an `at` line with that time, so the agent's line stays as it
printed it. A plain line (not the agent's: setup's output, a push's) gets one when it starts a run
of them, after one of the agent's lines or a phase, and then only when the second changed
(`needsStamp()`), so a noisy `npm ci` doesn't double the log. An image build's output is written by
whole lines (`buildOutput()`), with an `at` line, at the orchestrator's time, before each step's
first line. Logs from before `at` lines have none, and show no times.

The log stream (`stream()`) reads lines in order (`reader()`): in the image phase, BuildKit's
plain progress (`#12 [build 5/9] RUN npm ci`, `#12 CACHED`, `#12 DONE 41.2s`,
`#12 ERROR: …`) comes as `step` entries, one when a step starts and one each time its status
changes, and its output as `raw` entries with the step's number; the lines of no step
(BuildKit's error summary) stay `raw`. An `at` line gives no entry: its time goes on the next
line's `tool`, `output`, `text`, `result` and starting `step` entries (`at`, ms). A run of plain
lines starts at an `at` line just before one, and ends at the agent's next line (`endsPlain()`)
or a phase: its `raw` entries take the last time said in it (an `at` line's, or one of the
listener's own lines', which carry theirs: `meta`, `message`). Plain lines with no `at` line
before their run (logs from before #719) get none. A page of `get_run_log` from the middle of a
log reads again the lines before it from the agent's last one (`mcp.mjs` `linesBack()`), so it
reads as the whole log does there. `dashboard/src/types/log.ts` `Entry` is the contract.

Each `entries` event has an `id:`, the byte offset of the last whole line it read (#923): a
browser whose connection dropped (a phone in the background, a proxy's idle timeout, a
handover) reconnects with it as `Last-Event-ID`, which edge passes on, and the stream goes on
from there. The lines before it are read again but not sent, so the reader's state (the phase,
the build steps, the times) is what it was. The dashboard (`api.ts` `followLog()`) drops an
event whose id it has read already, and replaces the log it shows when a stream without ids
opens again.

## Hot and cold

The runner and the broker keep blobs in two places (#604). **Hot**, their store (`STORE_URL`, file
or Redis), holds what is still being written: only it appends at an offset in one atomic step
(`appendBlobAt()`), which a live log and an inbox need, as two copies may write at once and a
retry must add nothing. **Cold**, blob storage (`BLOB_URL`, `lib/blobs.mjs`: S3 through
`lib/s3.mjs`, or a folder), holds what will never change again: written in one PUT, read with
ranged GETs, as `readBlob(key, { offset, length })` reads the store, and deleted object by object
by retention. S3 has no append, and an upload in parts can't be read before it completes: a blob
is cold only once closed.

| Blob                         | Service | Hot (the store)                                      | Cold (blob storage)                      |
| ---------------------------- | ------- | ---------------------------------------------------- | ---------------------------------------- |
| a run's log (`logs/<run>/…`) | runner  | its index, and its open segment while it is written  | each closed segment, moved as it closes  |
| a screenshot (`shots/…`)     | broker  | the run's folder's names and sizes (`shots:<token>`) | the file, written once as it is uploaded |
| a run's inbox, CA, digest    | broker  | all of it: appended to while the run goes on         | none: they go with the run's end         |

So once the moves have caught up, the store holds one open segment per live run, however long the
runs: the size Redis needs no longer grows with the history kept (`LOG_RETENTION_DAYS`). An append
never waits on a move: while a log is written faster than blob storage takes its segments, the
closed ones wait in the store, as many as the lag makes, as they do while blob storage fails. One
measurement (`test/blob-acceptance.test.mjs`, #604): a 500 MB log written as fast as the runner took
it, on Redis with Garage on the same machine, peaked at 12 MB in Redis, and kept 8 MB once its moves
caught up; a slower server would let more wait. Without `BLOB_URL`, the store's own blobs stand in
for blob storage (`storeBlobs()`, the same interface), and nothing moves: an install that never sets
it works as before.

**Restarts**: a log's move is three steps, each one a single write (the copy in blob storage,
the index pointing at it, the store's segment deleted), noted before it starts in a stream of
the runner's store (`log-moves`), which the copy holding the runner's lease reads as it gets the
lease: a move cut short at any step, by a restart, a handover or blob storage away, is done
again from its start, and a read finds the segment in one place or the other at every moment
([A run's log](#a-runs-log)). A screenshot's name goes in the store before its file goes to
blob storage, so an upload cut short leaves a name retention deletes, never a file it would
miss: blob storage lists nothing, and needs no listing. Each service checks its blob storage as
it starts (an object written, read back and deleted): a wrong key or bucket stops it there, rather
than at a run's end.
