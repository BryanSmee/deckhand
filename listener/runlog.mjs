// Runs and their logs, for the dashboard: each run's log (its first line the listener's, then
// the agent's raw output), kept by the runner service (#503, ../runner/logs.mjs), its summary
// once it ended (`summaries/<run>` in the orchestrator's store, #618), the list rebuilt from the
// summaries after a restart, and the entries the dashboard shows for each line. The agent's
// lines are read through its normalize() (agents/), so a log keeps what the agent wrote.
import { appendFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { idOf } from "./agents/common.mjs";
import { agentFor, entryName } from "./agents/index.mjs";
import { entryLabel } from "./agents/select.mjs";
import { kindOf } from "./modes.mjs";
import { asksInput, replyQuestions, withoutMarker } from "./questions.mjs";
import { listDir, readJson, setAside } from "../lib/files.mjs";
import { storable, values } from "../lib/store.mjs";

// "ok", "needs-input" or "error" for an agent's `result` event (null: no result).
export function outcome(result) {
  if (!result?.ok) return "error";
  return asksInput(result.text) ? "needs-input" : "ok";
}

// The agent's last result in these log lines, if any.
export function lastResult(lines, agent) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const result = agent.normalize(lines[i]).findLast((e) => e.type === "result");
    if (result) return result;
  }
  return null;
}

export function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Appended synchronously, so a line counted as read (live.lines) is on disk. `size`: the
// file's, in bytes, from what it had when opened (a run picked up after a restart): what
// RUN_LOG_MAX_MB is checked against (runs.mjs).
export function openLog(path) {
  let size = existsSync(path) ? statSync(path).size : 0;
  return {
    write: (text) => {
      appendFileSync(path, text);
      size += Buffer.byteLength(text);
    },
    get size() {
      return size;
    },
  };
}

// One of the listener's own lines in a run's log (`file`: openLog()'s): `event` ("note",
// "delivered", "cancelled"…) with what `fields` add, at `fields.at` or now. `options`: the
// write's (../runner/client.mjs openRemote(), `step`).
export function writeEvent(file, event, fields = {}, options = undefined) {
  const at = "at" in fields ? {} : { at: Date.now() };
  file.write(JSON.stringify({ type: "listener", event, ...at, ...fields }) + "\n", options);
}

// The agent's events whose time a run's log keeps (runs.mjs output()): its tool calls and
// their outputs, for the dashboard's durations.
export const timed = (e) => e.type === "tool" || e.type === "toolOutput";

// An `at` line of the listener's (writeEvent()): when the next line came, or null.
export function stampOf(line) {
  if (!line.includes('"event":"at"')) return null;
  const e = parse(line);
  return e?.type === "listener" && e.event === "at" && Number.isFinite(e.at) ? e.at : null;
}

// The parts of a run, each its own section in the dashboard's log: getting the sandbox ready
// (agent install, clone, the repo's setup), building the repo's image (between two of setup's
// parts: before the sandbox starts), the agent's work, its pushes and pull request changes,
// and what comes after its answer. The listener writes a `phase` line at each change
// (enterPhase()), so a phase may come back (setup after the image, work after a push). Logs
// from before phases have none: all of them is work.
const PHASES = new Set(["setup", "image", "work", "push", "wrap-up"]);

// Moves a live run (runs.mjs) to `phase`: a `phase` line in its log, only when it changes.
// Its record keeps it too, for the dashboard's state (board.mjs runState()).
export function enterPhase(live, phase) {
  if (!PHASES.has(phase)) throw new Error(`no such phase: ${phase}`);
  if (live.record) live.record.phase = phase;
  if (live.logPhase === phase) return false;
  live.logPhase = phase;
  // A step of the run: the runner starts its log's next segment with it (../runner/logs.mjs).
  writeEvent(live.logFile, "phase", { phase }, { step: true });
  return true;
}

// The agents' shell tools (Claude Code's Bash, Codex's and Antigravity's command): only their
// commands push. Other tools' details (a Grep pattern, a subagent's prompt) may name a push.
const SHELLS = new Set(["Bash", "command"]);

// A push or a pull request change, as a command of its own: at the start, or after `;`, `&&`,
// `||`, `|`, `(` or a new line, not quoted in another one (`grep "git push"`).
const PUSHING =
  /(?:^|[;&|(\n])\s*(?:git(?:\s+-[Cc]\s+\S+)*\s+push|gh\s+pr\s+(?:create|edit|ready|merge))\b/;

// The phase a line of the agent's events (its normalize()) moves a live run to, before the
// line is written, or null for none: its first event starts its work, a push or pull request
// command pushes, any other tool call goes back to work. Its final answer wraps up
// (runs.mjs), for good: what it writes after that is still the wrap-up's.
export function phaseOf(current, events) {
  if (current === "wrap-up" || !events.length) return null;
  let phase = current === "work" || current === "push" ? current : "work";
  for (const e of events) {
    if (e.type !== "tool") continue;
    phase = SHELLS.has(e.name) && PUSHING.test(e.detail ?? "") ? "push" : "work";
  }
  return phase !== current ? phase : null;
}

// A duration in minutes, to a tenth: what the dashboard, replies and digests show.
export const minutes = (ms) => Math.round(ms / 6000) / 10;

// The runs' summaries in the orchestrator's store (#618), a key each: what the dashboard lists.
export const SUMMARIES = "summaries/";
export const summaryKey = (id) => `${SUMMARIES}${id}`;

// Rebuilds the list at the lease's takeover, so the dashboard survives a handover or a crash:
// from the runs' summaries in the store, as the logs are the runner's (#503). A run still live
// (restart.mjs) has none yet: restoreRuns() lists it, and it gets one when it ends. Newest
// first. A summary that isn't one is left out, logged: none stops the start.
export async function loadRuns(store, { log = console.error } = {}) {
  const runs = [];
  for await (const [key, saved] of values(store, SUMMARIES)) {
    if (saved?.id === key.slice(SUMMARIES.length)) runs.push(saved);
    else log(`Listing the run of ${key}: not a run's summary`);
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

// Where a release before #619 kept a summary the store didn't take, at a run's end.
const KEPT = ".summary.json";
const NOT_SUMMARIES = [".live.json", ".queued.json", KEPT];

// The summaries a release before #618 kept in logs/<run>.json: each written to the store, then
// removed. A key already there wins: a start that stopped before removing the file wrote it, and
// the run may have changed since. Those a release before #619 kept there when the store failed
// (<run>.summary.json) are newer than the store's, and go after them, over it. `secrets`: as
// saveSummary()'s. A file that isn't a summary is set aside as <file>.bad (lib/files.mjs
// setAside()), logged once: left as it was, it would be logged at every start (#853). A rename
// that fails leaves it there, logged, for the next start to try again. One the store didn't take
// stays for the next start. The run states (.live.json) and
// queues (.queued.json) the release before kept beside them, which restart.mjs moves to the
// store, aren't summaries. No `logDir` (an orchestrator with no volume, #619): none. → how many
// moved.
export async function moveSummaries(logDir, store, { log = console.error, secrets = [] } = {}) {
  const all = listDir(logDir);
  const older = all.filter(
    (f) => f.endsWith(".json") && !NOT_SUMMARIES.some((end) => f.endsWith(end)),
  );
  const kept = all.filter((f) => f.endsWith(KEPT));
  let count = 0;
  const move = (newer) => async (file) => {
    const id = file.slice(0, -(newer ? KEPT : ".json").length);
    const path = join(logDir, file);
    const saved = readJson(path);
    if (saved?.id !== id) {
      try {
        const aside = setAside(logDir, file);
        log(`Listing the run of ${file}: not a run's summary, set aside as ${aside}`);
      } catch (error) {
        log(`Listing the run of ${file}: not a run's summary, left in ${logDir}: ${error.message}`);
      }
      return;
    }
    try {
      const value = storable(saved, secrets);
      if (newer) await store.set(summaryKey(id), value);
      else await store.setIfAbsent(summaryKey(id), value);
      rmSync(path, { force: true });
      count++;
    } catch (error) {
      log(
        `Run summaries: ${file} not moved to the store (${error.message}), again at the next start`,
      );
    }
  };
  // A few at a time: Redis answers them together.
  for (const [files, newer] of [
    [older, false],
    [kept, true],
  ]) {
    for (let i = 0; i < files.length; i += MOVE_BATCH) {
      await Promise.all(files.slice(i, i + MOVE_BATCH).map(move(newer)));
    }
  }
  if (count) log(`Run summaries: ${count} moved from ${logDir} to the store`);
  return count;
}
const MOVE_BATCH = 50;

// Whether what a file or the store holds is a run's state (restart.mjs): one without its id,
// task or record can't be restored (a write cut short, a hand edit).
export const isRunState = (saved) => Boolean(saved?.id && saved.task && saved.record);

// What loadRuns() lists a finished run with, in the store: without the operator's `secrets`, a
// GitHub token or a private key its text may hold (lib/store.mjs storable()), rather than
// refused whole. A store that fails (Redis away a moment) is logged: the caller tries again, as
// the orchestrator keeps nothing anywhere else (#619), and `failed(error)` hears why. → whether
// the store took it.
export async function saveSummary(
  store,
  record,
  { log = console.error, secrets = [], failed = () => {} } = {},
) {
  try {
    await store.set(summaryKey(record.id), storable(record, secrets));
    return true;
  } catch (error) {
    log(`${record.key}: saving the summary of ${record.id}: ${error.message}`);
    failed(error);
    return false;
  }
}

// What the dashboard lists for a run (runs.mjs): `title` its task's as known, `agent` the
// operator's for its kind. Its log is the runner's, by its id.
export function newRecord(
  task,
  { id, key, mode, light, replyTo, reason, round = null, rounds = null, items },
  { title, agent },
) {
  return {
    id,
    key,
    kind: kindOf(mode, task.kind),
    // work, brainstorm, idea, bug, discussion or one of the repo's own modes.
    taskMode: mode === "stop" ? "brainstorm" : mode,
    repo: task.repo,
    title,
    replyTo,
    // What runs it: the operator's until the repo's settings are read (begin()), on which
    // provider, and why when it is a fallback's or `/agent`'s (entryFor()).
    agent,
    provider: null,
    credential: null,
    auth: null,
    fallback: null,
    picked: null,
    // Whether it is a light run: an issue's light runs and its work have their own sessions.
    light,
    // Why the listener started it itself ("conflict": conflicts.mjs); null for comments.
    reason,
    // A review fix run's round, of how many the repo's `review.fix` allows (reviews.mjs).
    round,
    rounds,
    // Started by the listener from the issue's auto-pickup label (auto-pickup.mjs), or following
    // such a run until its work is done (`followsPick`, tasks.mjs followsPick()): it holds one
    // of AUTO_PICKUP_SLOTS. Only on those runs.
    ...(items.some((i) => i.autoPickup) && { autoPickup: true }),
    // What it was asked to act on, kept in its log's first line: a run that fails can run
    // again with it, after a restart too (the dashboard's Rerun, work.mjs).
    items: items.map(({ id, kind, number, trigger, modeLine, text }) => ({
      id,
      kind,
      number,
      trigger,
      modeLine,
      text,
    })),
    mode: null,
    // What its start decided it gets (preparation.mjs, capabilities.mjs), once it did.
    capabilities: null,
    // The part of the run it is in (enterPhase()), while it runs: setup from the moment it
    // leaves the queue, so the dashboard shows it scheduled until its agent starts.
    phase: "setup",
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    // Its screenshots' folder, once it starts: they go with its log (history.mjs).
    shots: null,
    // The branch of its last push GitHub took, and when (restart.mjs watchPushes()).
    branch: null,
    lastPushAt: null,
  };
}

// A new run, or one a restart picks up again (restart.mjs), in the list and its index by id.
export function addRun(ctx, record) {
  const known = ctx.runsById.get(record.id);
  const at = known ? ctx.runs.indexOf(known) : -1;
  if (at >= 0) ctx.runs[at] = record;
  else ctx.runs.unshift(record);
  ctx.runsById.set(record.id, record);
}

// A run as the dashboard gets it: without where its log was on disk (summaries from before
// #503 have it), its questions (the task carries those, board.mjs), the comments it ran on
// (their text is in its log), whether it was light (its kind says it), nor its screenshots'
// folder (history.mjs).
export function publicRun(r) {
  const { logPath, questions, items, light, shots, ...rest } = r;
  return rest;
}

// What a run that stopped to ask asks (questions.mjs parseQuestions()), null otherwise.
export function questionsOf(result) {
  return result && outcome(result) === "needs-input" ? replyQuestions(result.text) : null;
}

// The first line of a run's reply, for the dashboard: what the run ended with. Headings
// ("## Needs your input") say less than the sentence under them.
export function summaryOf(result) {
  const lines = withoutMarker(result?.text).split("\n");
  const plain = (l) => l.replace(/^[#>*\s-]+/, "").trim();
  const line =
    plain(lines.find((l) => plain(l) && !/^\s*#/.test(l)) ?? "") || plain(lines.find(plain) ?? "");
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// At most `lines` lines and `chars` characters of `text`, "…" when cut.
export function clip(text, lines, chars) {
  const all = String(text).split("\n");
  let out = all.slice(0, lines).join("\n");
  if (out.length > chars) out = out.slice(0, chars);
  return out.length < String(text).length ? out + "\n…" : out;
}

const STARTING = {
  brainstorm: "Starting a brainstorm",
  idea: "New idea",
  bug: "New bug report",
  discussion: "Answering a discussion",
  chat: "Starting a chat",
};

const GOING_ON = {
  "wrap-up": "Wrapping up the brainstorm",
  restore: "Restoring the session after a pause",
  continue: "Continuing the session",
};

// Runs the listener started itself (conflicts.mjs, reviews.mjs).
const REASONS = {
  conflict: "Rebasing a pull request in conflict",
  review: "Reviewing a pull request that turned ready",
  "review-fix": "Addressing the findings of a review that requested changes",
  "ci-fix": "Fixing the CI that failed on a pull request, before its review",
};

// The listener's own lines: a run's first line (what it is), notes and delivered comments.
// `seen.chat`: whether the run's first line said it is a chat (reader() keeps it for the lines
// after it).
function listenerEntries(e, agent, seen) {
  // When the next line came: reader() puts it on that line's entries.
  if (e.event === "at") return [];
  if (e.event === undefined && e.kind !== undefined) seen.chat = e.kind === "chat";
  if (e.event === "phase") return [{ kind: "phase", phase: e.phase, at: e.at }];
  if (e.event === "note") return [{ kind: "meta", text: e.message }];
  // The record's mode corrected (runs.mjs reopen()): the note beside it says why. The sandbox
  // starting: its own lines come next.
  if (e.event === "session" || e.event === "sandbox") return [];
  if (e.event === "cancelled") {
    const time = new Date(e.at).toISOString().slice(11, 19);
    return [{ kind: "meta", text: `Stopped by @${e.by} at ${time} UTC` }];
  }
  // A sandbox still running, silent, after its answer (runs.mjs linger()).
  if (e.event === "ended") {
    const time = new Date(e.at).toISOString().slice(11, 19);
    const text = `Stopped at ${time} UTC, silent for ${minutes(e.after)} min after its answer: the answer is posted`;
    return [{ kind: "meta", text }];
  }
  // A chat's message (tasks.mjs deliver()): its owner's turn in the conversation. Those
  // written before #817 lack `chat`: the run's first line says it then (#850).
  if (e.event === "delivered" && (e.chat || seen.chat))
    return [{ kind: "message", text: e.message }];
  if (e.event === "delivered") {
    const time = new Date(e.at).toISOString().slice(11, 19);
    const text = `New comment delivered to ${agent.displayName} at ${time} UTC: ${e.message}`;
    return [{ kind: "meta", text }];
  }
  const own = e.taskMode && e.taskMode !== "work" ? `Starting the ${e.taskMode} mode` : null;
  const what =
    (REASONS[e.reason] ?? GOING_ON[e.mode] ?? STARTING[e.kind] ?? own ?? "Starting") +
    (e.model ? ` (${e.model}, ${e.effort} effort${e.speed === "fast" ? ", fast" : ""})` : "");
  // A fallback's run (runs.mjs): what it took over from, and why.
  const fell = e.fallback && !e.fallback.sticky;
  const from = fell
    ? `Falling back to ${entryLabel(entryName(agent.name, e.provider, e.credential))} from ${entryLabel(e.fallback.from)}, whose provider failed: ${e.fallback.reason}. `
    : "";
  const picked = e.picked && !e.picked.sticky ? `${agent.displayName} picked with /agent. ` : "";
  // A chat's first line: its owner's messages that started the run, as theirs.
  if (e.kind === "chat") {
    const said = e.message ? [{ kind: "message", text: e.message }] : [];
    return [{ kind: "meta", text: from + picked + what }, ...said];
  }
  return [{ kind: "meta", text: from + picked + what + (e.message ? `: ${e.message}` : "") }];
}

// What Claude Code says of its fast mode as it starts (agents/claude.mjs), when on.
const FAST_MODE = { on: ", fast mode on", cooldown: ", fast mode cooling down" };

// The agent's events (its normalize()) → the dashboard's entries.
function agentEntry(e, agent) {
  switch (e.type) {
    case "started": {
      // Codex doesn't say its model there: the run's first line does. Fast mode only once
      // on: an agent that has it says "off" in every run.
      const fast = Object.hasOwn(FAST_MODE, e.fastMode ?? "") ? FAST_MODE[e.fastMode] : "";
      return {
        kind: "meta",
        text: `${agent.displayName} started${e.model ? ` (${e.model}${fast})` : ""}`,
      };
    }
    case "text":
      return { kind: "text", text: e.text };
    // `id`: what pairs an output with its call, for agents that give one; `done`: a call that
    // came whole, with no output to wait for.
    case "tool":
      return {
        kind: "tool",
        name: e.name,
        text: clip(e.detail, 6, 600),
        ...idOf(e.id),
        ...(e.done && { done: true }),
      };
    case "toolOutput":
      return { kind: "output", error: e.error, text: clip(e.text, 40, 4000), ...idOf(e.id) };
    case "result": {
      return { kind: "result", status: outcome(e), text: e.text, minutes: minutes(e.durationMs) };
    }
  }
  return null;
}

// The most of a line that isn't JSON the dashboard gets: setup output, or an agent's event cut
// at follow()'s MAX_LINE (a screenshot read in a tool's result, say), which no longer parses.
const RAW_MAX = 4000;

function clipRaw(line) {
  if (line.length <= RAW_MAX) return line;
  return `${line.slice(0, RAW_MAX)}… (${Math.round(line.length / 1024)} KB in all)`;
}

// One log line (the listener's, the agent's, or setup output) → entries for the dashboard.
// `agent`: the run's (agents/), Claude Code for logs from before agents had names. `seen`: what
// the log's earlier lines said of the run (listenerEntries()), reader()'s.
export function format(line, agent = agentFor(), seen = {}) {
  if (!line.trim()) return [];
  const e = parse(line);
  // A line cut at MAX_LINE: raw, unless the agent still knows whose output it was.
  if (!e) {
    const cut = agent.normalize(line).flatMap((event) => agentEntry(event, agent) ?? []);
    return cut.length ? cut : [{ kind: "raw", text: clipRaw(line) }];
  }
  if (e.type === "listener") return listenerEntries(e, agent, seen);
  return agent.normalize(line).flatMap((event) => agentEntry(event, agent) ?? []);
}

// BuildKit's plain progress (`docker build --progress plain`, images.mjs): `#<n> <text>`, the
// step's name on its first line ("[stage 2/5] RUN npm ci", or "exporting to image"), then
// its output (after the seconds since it started) and how it ended. #0 says which builder.
const BUILD_LINE = /^#([1-9]\d*) (.*)$/;
const STAGE = /^\[([^\]]+)\] (.*)$/;
const TIMED = /^\d+\.\d+ (.*)$/;
const ENDED = /^(?:(CACHED)|DONE (\d+(?:\.\d+)?)s|ERROR:? ?(.*)|(CANCELED))$/;

// One line of an image build → its step's entries: a `step` entry when the step starts or
// its status changes (the latest one for a number says it), a `raw` one with its number for
// its output. Null for lines of no step (the error summary at the end): format()'s.
function buildEntries(line, steps, at = null) {
  const m = BUILD_LINE.exec(line.trimEnd());
  if (!m) return null;
  const n = Number(m[1]);
  const text = m[2];
  const known = steps.get(n);
  if (!known) {
    const named = STAGE.exec(text);
    const step = {
      kind: "step",
      step: n,
      stage: named?.[1] ?? null,
      // The whole command, heredocs included: BuildKit prints it on one line.
      name: clipRaw(named?.[2] ?? text),
      status: "running",
      seconds: null,
      error: null,
      ...(at !== null && { at }),
    };
    steps.set(n, { header: text, step });
    return [step];
  }
  // Its name again, when BuildKit comes back to it between other steps' lines.
  if (text === known.header) return [];
  const ended = ENDED.exec(text);
  if (!ended) return [{ kind: "raw", step: n, text: clipRaw(TIMED.exec(text)?.[1] ?? text) }];
  const [, cached, seconds, error, cancelled] = ended;
  known.step = {
    ...known.step,
    status: cached ? "cached" : seconds ? "done" : cancelled ? "cancelled" : "error",
    seconds: seconds ? Number(seconds) : null,
    error: error === undefined ? null : clipRaw(error || "failed"),
  };
  return [known.step];
}

// The entries that take the time of an `at` line before theirs: a tool call, an output, an
// image build step as it starts.
const STAMPED = new Set(["tool", "output", "step"]);

// The phases of a run's preparation, the only ones whose lines reader() reads apart.
const PREPARING = new Set(["setup", "image"]);

// format() for a stream of a log's lines, in order: it follows the phase they are in, the
// image build's lines come as its steps (buildEntries()), and a line after an `at` one gets
// its time (`at`, ms). Logs from before `at` lines have none. Its `settled()`: whether the
// run's preparation is over (a phase after it, or an agent's line in a log from before phases),
// after which the lines read so far change how no later one reads but through an `at` line:
// where a page read from the middle of a log (mcp.mjs) stops reading what comes before it.
export function reader(agent = agentFor()) {
  const seen = {};
  let phase = null;
  let steps = new Map();
  let at = null;
  let settled = false;
  const read = (line) => {
    const entries = format(line, agent, seen);
    for (const e of entries) {
      if (e.kind !== "phase") continue;
      phase = e.phase;
      if (phase === "image") steps = new Map();
    }
    if (phase !== "image" || entries.length !== 1 || entries[0].kind !== "raw") return entries;
    return buildEntries(line, steps, at) ?? entries;
  };
  const reading = (line) => {
    const stamp = stampOf(line);
    if (stamp !== null) {
      at = stamp;
      return [];
    }
    if (!line.trim()) return [];
    const entries = read(line);
    if (!settled)
      settled = phase === null ? parse(line)?.type !== "listener" : !PREPARING.has(phase);
    if (at !== null)
      for (const e of entries) if (STAMPED.has(e.kind) && e.at === undefined) e.at = at;
    at = null;
    return entries;
  };
  reading.settled = () => settled;
  return reading;
}

// An image build's output (images.mjs), written to a run's log (`file`: openLog()'s) by whole
// lines, each step's first one after an `at` line: what times the step in the dashboard.
// BuildKit's own lines say when a step ends, not when it started. `flush()` writes what is
// left once the build ends, as a whole line.
export function buildOutput(file, now = Date.now) {
  // docker() gives Buffers: a character split between two stays whole.
  const decoder = new StringDecoder("utf8");
  let rest = "";
  const seen = new Set();
  const write = (line) => {
    const n = BUILD_LINE.exec(line)?.[1];
    if (n && !seen.has(n)) {
      seen.add(n);
      writeEvent(file, "at", { at: now() });
    }
    file.write(line + "\n");
  };
  return {
    write: (chunk) => {
      const lines = (rest + decoder.write(chunk)).split("\n");
      rest = lines.pop();
      for (const line of lines) write(line);
    },
    flush: () => {
      rest += decoder.end();
      // A line of its own: the listener's next one (a phase, a note) must still parse.
      if (rest) file.write(rest + "\n");
      rest = "";
    },
  };
}

// Server-sent events: the log so far, then new lines as they are written, until the run ends,
// or until `allowed()` (or its promise) turns false (a sign-out, a repo's `users` or the access
// decision narrowed): checked each second
// (`every`, in ms: shorter in the tests). The log is the runner's: `read(offset)` → { data }, its
// bytes from `offset` (../runner/client.mjs readLog(), as edge). A run that hasn't written a line
// yet reads as empty. Any error ends this stream only, through `onError`, never the listener.
export function stream(
  req,
  res,
  run,
  { read, allowed = () => true, every = 1000, onError = () => {} },
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  // At once, not with the first line: a run that has written none yet is still open.
  res.flushHeaders?.();
  const reading = reader(agentFor(run.agent));
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let rest = "";
  let busy = false;
  let stopped = false;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const pump = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await next();
    } catch (error) {
      onError(error);
      stop();
    } finally {
      busy = false;
    }
  };
  const next = async () => {
    if (!(await allowed())) return stop();
    // Asked before it is read: a run that ended is read to its end, then ends the stream.
    const ended = run.status !== "running";
    for (;;) {
      const { data } = await read(offset);
      if (stopped) return;
      if (!data.length) break;
      offset += data.length;
      const lines = (rest + decoder.write(data)).split("\n");
      rest = lines.pop();
      const entries = lines.flatMap(reading);
      if (entries.length) send("entries", entries);
    }
    if (ended) {
      rest += decoder.end();
      if (rest) send("entries", reading(rest));
      send("end", publicRun(run));
      return stop();
    }
  };
  const timer = setInterval(pump, every);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(keepAlive);
    res.end();
  };
  req.on("close", stop);
  pump();
}
