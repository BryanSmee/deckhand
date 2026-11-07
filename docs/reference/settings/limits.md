# Runs and limits

How many runs go at once, and how often Deckhand looks again at what waits. What one sandbox
may use (CPUs, memory, processes) isn't here: it is in the grants folder's `limits`
([The grants folder](../server-folder.md#the-grants-folder)). A repository's `.deckhand.yaml`
may lower some of these for itself (`max_parallel`, `chats.per_user`), never raise them.
[Auto-pickup](../../guides/auto-pickup.md) and [Chats](../../guides/chats.md) say how their
settings work together.

## Settings

- **`MAX_PARALLEL`** · `max_parallel` · default: `2`\
  Sandboxes running at once (a repo's `max_parallel` within it).
- **`AUTO_PICKUP_SLOTS`** · `auto_pickup_slots` · default: `0` (off)\
  Slots within `MAX_PARALLEL` for the issues the orchestrator starts by itself (below `MAX_PARALLEL`; [Auto-pickup](../../guides/auto-pickup.md)).
- **`AUTO_PICKUP_LABEL`** · `auto_pickup_label` · default: `auto-pickup`\
  The label that asks for it.
- **`CHATS_PER_USER`** · `chats_per_user` · default: `2`\
  Chats a user keeps from the dashboard, across the repositories, running or not (a repo's `chats.per_user` within it; `0`: none; see [Chats](../../guides/chats.md)).
- **`MAX_RUNNING_CHATS`** · `max_running_chats` · default: `2`\
  Chats' sandboxes running at once, apart from `MAX_PARALLEL` (`0`: none start, and messages are refused).
- **`CHAT_IDLE_MINUTES`** · `chat_idle_minutes` · default: `30`\
  Minutes after a chat's last message or answer before its sandbox stops; the next message starts it again, in the same conversation.
- **`CHAT_PERMISSION_TIMEOUT`** · `chat_permission_timeout` · default: `10`\
  Minutes a chat's request for more permissions, or a machine run's tool call, waits for its owner's answer before it is denied (1 to 60; see [Chats](../../guides/chats.md)).
- **`BRAINSTORM_IDLE_MINUTES`** · `brainstorm_idle_minutes` · default: `10`\
  Minutes without a comment before a brainstorm shows as idle.
- **`CONFLICT_CHECK_MINUTES`** · `conflict_check_minutes` · default: `5`\
  Shortest interval of a repo's `conflicts.check_minutes`; `0` turns it off.
- **`MAX_FIX_ROUNDS`** · `max_fix_rounds` · default: `5`\
  Most fix runs a repo's `review.fix` may ask for per pull request (each is a work run plus a review run).
- **`WAITS_CHECK_MINUTES`** · `waits_check_minutes` · default: `5`\
  How often comments waiting for other issues (`/after`) ask GitHub again.
- **`DEBOUNCE_MS`** · `debounce_ms` · default: `15000`\
  Pause after a comment before its run starts, so that comments posted together go in one run.
- **`BRAINSTORM_DEBOUNCE_MS`** · `brainstorm_debounce_ms` · default: `3000`\
  The same before a light run (brainstorms, onboarding, inbox entries…).
- **`CONFLICT_MERGE_DELAY_MS`** · `conflict_merge_delay_ms` · default: `30000`\
  Pause after a repo's default branch moved before its pull requests' conflicts are checked, while GitHub computes them again.
- **`RUN_LOG_MAX_MB`** · `run_log_max_mb` · default: `200`\
  Megabytes a run's log may hold: a run whose output passes it is stopped and fails, the rest of its output not kept ([Run logs](#run-logs)).
- **`LOG_SEGMENT_MB`** · `log_segment_mb` · default: `8`\
  Megabytes of a run's log the runner keeps in one segment at most: a segment also closes at each step of the run ([Run logs](#run-logs)).
- **`LOG_RETENTION_DAYS`** · `log_retention_days` · default: `90`\
  Days a run's log, its summary and its screenshots are kept; `0` keeps them forever ([Run logs](#run-logs)).

## Run logs

Each run leaves its log at the runner, in its store (the agent's whole output, often a few
MB), a summary in the orchestrator's store (`summaries/<run>`, what the dashboard lists
after a restart or a handover, so the orchestrator doesn't read the logs to start: [The
store](../../guides/store.md)), and the broker keeps its screenshots (in blob
storage, or its store without it: [Blob storage](../../guides/blob-storage.md)). At start and then daily, the
orchestrator removes those of runs older than `LOG_RETENTION_DAYS` (90 days by default), the
screenshots through the broker, and they leave the dashboard. It keeps a run still going, and the latest run of a
task that is queued, in a brainstorm, waiting (`/after`) or waiting for input, whatever its
age. Screenshots linked from older pull requests and comments stop showing once their run is
removed: set a longer retention, or `0`, to keep them.

A run's output can't fill the data volume: once its log would pass `RUN_LOG_MAX_MB` (200 MB
by default), nothing more of it is written, its sandbox is stopped and the run fails, with a
note in its log and a reply that says why. A single line over 1 MB (no newline in sight) is
cut there, `… (line cut)` at its end, and the rest of it dropped up to its newline. It can't
be turned off (`0` is refused): it is what keeps a run from filling the volume.

The runner keeps a run's log in its store in segments, each closed at a step of the run (its
setup, image build, work, pushes, wrap-up) or at `LOG_SEGMENT_MB` (8 MB by default), whichever
comes first: only the last one is still written to.
