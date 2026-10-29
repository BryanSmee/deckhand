// Runs and their logs, for the dashboard: each run's log file (logs/<run>.log, its first line
// the listener's, then the agent's raw output), its summary once it ended (logs/<run>.json),
// the list rebuilt from them after a restart, and the entries the dashboard shows for each
// line. The agent's lines are read through its normalize() (agents/), so a log keeps what the
// agent wrote. Pure, apart from the log files.
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { idOf } from "./agents/common.mjs";
import { agentFor, entryName } from "./agents/index.mjs";
import { entryLabel } from "./agents/select.mjs";
import { kindOf } from "./modes.mjs";
import { NEEDS_INPUT, replyQuestions } from "./questions.mjs";
import { readJson, writeJsonAtomic } from "./store.mjs";

// "ok", "needs-input" or "error" for an agent's `result` event (null: no result).
export function outcome(result) {
  if (!result?.ok) return "error";
  return (result.text ?? "").trimStart().startsWith(NEEDS_INPUT) ? "needs-input" : "ok";
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
// "delivered", "cancelled"…) with what `fields` add, at `fields.at` or now.
export function writeEvent(file, event, fields = {}) {
  const at = "at" in fields ? {} : { at: Date.now() };
  file.write(JSON.stringify({ type: "listener", event, ...at, ...fields }) + "\n");
}

// The agent's events whose time a run's log keeps (runs.mjs output()): its tool calls and
// their outputs, for the dashboard's durations.
export const timed = (e) => e.type === "tool" || e.type === "toolOutput";

// An `at` line of the listener's (writeEvent()): when the next line came, or null.
function stampOf(line) {
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
export function enterPhase(live, phase) {
  if (!PHASES.has(phase)) throw new Error(`no such phase: ${phase}`);
  if (live.logPhase === phase) return false;
  live.logPhase = phase;
  writeEvent(live.logFile, "phase", { phase });
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

// Rebuilds the list after a restart, so the dashboard survives it. From the runs' summaries:
// a log is read in full (a few MB each) only when its run has none, from before summaries or
// a listener that died mid-run, and then gets one, so the next start skips it. A run still
// live (its .live.json, restart.mjs) gets its summary when it ends. Newest first. A log over
// `max` bytes is read by its ends alone (logLines()); one that can't be read at all is left
// out, logged: no log stops the start.
export function loadRuns(logDir, { max = READ_MAX, log = console.error } = {}) {
  return readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .map((file) => {
      const id = file.slice(0, -4);
      const logPath = join(logDir, file);
      const saved = readJson(summaryPath(logPath));
      if (saved?.id === id) return { ...saved, logPath };
      let run;
      try {
        run = runOf(logDir, file, max, log);
      } catch (error) {
        log(`Listing the run of ${file}: ${error.message}`);
        return null;
      }
      if (!existsSync(join(logDir, `${id}.live.json`))) saveSummary(run);
      return run;
    })
    .filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export const summaryPath = (logPath) => logPath.replace(/\.log$/, ".json");

// What loadRuns() lists a finished run with. Written whole (store.mjs), so a crash damages no
// summary; one that can't be written leaves its log to be read again at the next start.
export function saveSummary(record, log = console.error) {
  const { logPath, ...summary } = record;
  try {
    writeJsonAtomic(summaryPath(logPath), summary);
  } catch (error) {
    log(`${record.key}: saving the summary of ${record.id}: ${error.message}`);
  }
}

// What the dashboard lists for a run (runs.mjs): `title` its task's as known, `agent` the
// operator's for its kind, `logDir` where its log goes.
export function newRecord(
  task,
  { id, key, mode, light, replyTo, reason, round = null, rounds = null, items },
  { title, agent, logDir },
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
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    // Its screenshots' folder, once it starts: they go with its log (history.mjs).
    shots: null,
    // The branch of its last push GitHub took, and when (restart.mjs watchPushes()).
    branch: null,
    lastPushAt: null,
    logPath: join(logDir, `${id}.log`),
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

// The most of a log loadRuns() reads whole: a string can't hold much more than 512 MB, and
// older logs had no cap (RUN_LOG_MAX_MB). Past it, its first and last ENDS bytes.
const READ_MAX = 64 * 1024 * 1024;
const ENDS = 4 * 1024 * 1024;

// A log's lines, or for one over `max` bytes, the first (the listener's, what the run is) and
// those of its last bytes (its result, a cancel), the line cut there dropped.
function logLines(logPath, max, log) {
  const size = statSync(logPath).size;
  if (size <= max) return readFileSync(logPath, "utf8").split("\n");
  log(`${logPath}: ${Math.round(size / 1024 / 1024)} MB, only its first line and its end read`);
  const ends = Math.min(ENDS, max);
  const fd = openSync(logPath, "r");
  try {
    const read = (at, length) => {
      const buffer = Buffer.alloc(length);
      return buffer.toString("utf8", 0, readSync(fd, buffer, 0, length, at));
    };
    const first = read(0, ends).split("\n")[0];
    const tail = read(size - ends, ends)
      .split("\n")
      .slice(1);
    return [first, ...tail];
  } finally {
    closeSync(fd);
  }
}

function runOf(logDir, file, max = READ_MAX, log = console.error) {
  const logPath = join(logDir, file);
  const lines = logLines(logPath, max, log);
  const meta = parse(lines[0])?.type === "listener" ? parse(lines[0]) : {};
  // Logs from before agents had names are Claude Code's.
  const agent = agentFor(meta.agent);
  const result = lastResult(lines, agent);
  const stopper = cancelledBy(lines);
  const id = file.slice(0, -4);
  return {
    id,
    agent: agent.name,
    // Its provider, and why when it is a fallback's (agents/select.mjs entryFor()): a later run of the
    // task sticks to it. None in logs from before fallbacks.
    provider: meta.provider ?? null,
    // The provider's credential its entry named (`claude@anthropic:key`); null: the default.
    credential: meta.credential ?? null,
    // The credential it ran on (agents/select.mjs authOf()); null in logs from before it.
    auth: meta.auth ?? null,
    fallback: meta.fallback ?? null,
    // Whether `/agent` picked it (or a previous run's `/agent`: sticky): it doesn't fall back.
    picked: meta.picked ?? null,
    light: meta.light ?? null,
    key: meta.key ?? id.replace(/-\d+$/, ""),
    kind: meta.kind ?? null,
    title: meta.title ?? null,
    repo: meta.repo ?? null,
    replyTo: meta.replyTo ?? null,
    mode: meta.mode ?? null,
    taskMode: meta.taskMode ?? null,
    reason: meta.reason ?? null,
    round: meta.round ?? null,
    rounds: meta.rounds ?? null,
    // Logs from before runs kept them have none: those runs can't run again.
    items: meta.items ?? null,
    model: meta.model ?? null,
    effort: meta.effort ?? null,
    // "fast" in Claude Code's fast mode, which costs more (agents/select.mjs speedFor()), and
    // why it didn't get the speed or model asked for. None in logs from before speeds.
    speed: meta.speed ?? null,
    speedNote: meta.speedNote ?? null,
    startedAt: meta.startedAt ?? Number(id.match(/-(\d+)$/)?.[1] ?? 0),
    finishedAt: statSync(logPath).mtimeMs,
    // Unfinished and not ours: the listener restarted during the run.
    status: stopper ? "cancelled" : result ? outcome(result) : "interrupted",
    summary: stopper ? `Stopped by @${stopper}` : summaryOf(result),
    questions: questionsOf(result),
    logPath,
  };
}

// Who cancelled the run (runs.mjs cancel()), from its log, or null.
function cancelledBy(lines) {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!lines[i].includes('"cancelled"')) continue;
    const e = parse(lines[i]);
    if (e?.type === "listener" && e.event === "cancelled") return e.by ?? "?";
  }
  return null;
}

// A run as the dashboard gets it: without where its log is on disk, its questions (the task
// carries those, board.mjs), the comments it ran on (their text is in its log), whether it
// was light (its kind says it), nor its screenshots' folder (history.mjs).
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
  const lines = (result?.text ?? "").replace(NEEDS_INPUT, "").split("\n");
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
};

// The listener's own lines: a run's first line (what it is), notes and delivered comments.
function listenerEntries(e, agent) {
  // When the next line came: reader() puts it on that line's entries.
  if (e.event === "at") return [];
  if (e.event === "phase") return [{ kind: "phase", phase: e.phase, at: e.at }];
  if (e.event === "note") return [{ kind: "meta", text: e.message }];
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
    // `id`: what pairs an output with its call, for agents that give one.
    case "tool":
      return { kind: "tool", name: e.name, text: clip(e.detail, 6, 600), ...idOf(e.id) };
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
// `agent`: the run's (agents/), Claude Code for logs from before agents had names.
export function format(line, agent = agentFor()) {
  if (!line.trim()) return [];
  const e = parse(line);
  // A line cut at MAX_LINE: raw, unless the agent still knows whose output it was.
  if (!e) {
    const cut = agent.normalize(line).flatMap((event) => agentEntry(event, agent) ?? []);
    return cut.length ? cut : [{ kind: "raw", text: clipRaw(line) }];
  }
  if (e.type === "listener") return listenerEntries(e, agent);
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

// format() for a stream of a log's lines, in order: it follows the phase they are in, the
// image build's lines come as its steps (buildEntries()), and a line after an `at` one gets
// its time (`at`, ms). Logs from before `at` lines have none.
export function reader(agent = agentFor()) {
  let phase = null;
  let steps = new Map();
  let at = null;
  const read = (line) => {
    const entries = format(line, agent);
    for (const e of entries) {
      if (e.kind !== "phase") continue;
      phase = e.phase;
      if (phase === "image") steps = new Map();
    }
    if (phase !== "image" || entries.length !== 1 || entries[0].kind !== "raw") return entries;
    return buildEntries(line, steps, at) ?? entries;
  };
  return (line) => {
    const stamp = stampOf(line);
    if (stamp !== null) {
      at = stamp;
      return [];
    }
    if (!line.trim()) return [];
    const entries = read(line);
    if (at !== null)
      for (const e of entries) if (STAMPED.has(e.kind) && e.at === undefined) e.at = at;
    at = null;
    return entries;
  };
}

// An image build's output (images.mjs), written to a run's log (`file`: openLog()'s) by whole
// lines, each step's first one after an `at` line: what times the step in the dashboard.
// BuildKit's own lines say when a step ends, not when it started. `flush()` writes what is
// left once the build ends.
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
      if (rest) file.write(rest);
      rest = "";
    },
  };
}

// Server-sent events: the log so far, then new lines as they are written, until the run ends,
// or until `allowed()` turns false (a sign-out, a repo's `users` narrowed): checked each second
// (`every`, in ms: shorter in the tests). A run that hasn't written a line yet has no file
// (openLog() creates it on its first write): it reads as empty. Any other error ends this
// stream only, through `onError`, never the listener.
export function stream(req, res, run, allowed = () => true, every = 1000, onError = () => {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  const read = reader(agentFor(run.agent));
  let offset = 0;
  let rest = "";
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const pump = () => {
    try {
      next();
    } catch (error) {
      onError(error);
      stop();
    }
  };
  const next = () => {
    if (!allowed()) return stop();
    const size = existsSync(run.logPath) ? statSync(run.logPath).size : 0;
    if (size > offset) {
      const fd = openSync(run.logPath, "r");
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      closeSync(fd);
      offset = size;
      const lines = (rest + buffer.toString("utf8")).split("\n");
      rest = lines.pop();
      const entries = lines.flatMap(read);
      if (entries.length) send("entries", entries);
    }
    if (run.status !== "running") {
      if (rest) send("entries", read(rest));
      send("end", publicRun(run));
      return stop();
    }
  };
  const timer = setInterval(pump, every);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  const stop = () => {
    clearInterval(timer);
    clearInterval(keepAlive);
    res.end();
  };
  req.on("close", stop);
  pump();
}
