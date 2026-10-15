// Runs and their logs, for the dashboard: each run's log file (logs/<run>.log, its first line
// the listener's, then the agent's raw output), the list rebuilt from them after a restart,
// and the entries the dashboard shows for each line. The agent's lines are read through its
// normalize() (agents/), so a log keeps what the agent wrote. Pure, apart from the log files.
import {
  appendFileSync,
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { agentFor } from "./agents/index.mjs";
import { NEEDS_INPUT, replyQuestions } from "./questions.mjs";

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

// Appended synchronously, so a line counted as read (live.lines) is on disk.
export function openLog(path) {
  return { write: (text) => appendFileSync(path, text) };
}

// Rebuilds the list from the log files, so the dashboard survives a listener restart.
// Newest first.
export function loadRuns(logDir) {
  return readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .map((file) => runOf(logDir, file))
    .sort((a, b) => b.startedAt - a.startedAt);
}

function runOf(logDir, file) {
  const logPath = join(logDir, file);
  const lines = readFileSync(logPath, "utf8").split("\n");
  const meta = parse(lines[0])?.type === "listener" ? parse(lines[0]) : {};
  // Logs from before agents had names are Claude Code's.
  const agent = agentFor(meta.agent);
  const result = lastResult(lines, agent);
  const id = file.slice(0, -4);
  return {
    id,
    agent: agent.name,
    key: meta.key ?? id.replace(/-\d+$/, ""),
    kind: meta.kind ?? null,
    title: meta.title ?? null,
    repo: meta.repo ?? null,
    replyTo: meta.replyTo ?? null,
    mode: meta.mode ?? null,
    taskMode: meta.taskMode ?? null,
    reason: meta.reason ?? null,
    // Logs from before runs kept them have none: those runs can't run again.
    items: meta.items ?? null,
    model: meta.model ?? null,
    effort: meta.effort ?? null,
    startedAt: meta.startedAt ?? Number(id.match(/-(\d+)$/)?.[1] ?? 0),
    finishedAt: statSync(logPath).mtimeMs,
    // Unfinished and not ours: the listener restarted during the run.
    status: result ? outcome(result) : "interrupted",
    summary: summaryOf(result),
    questions: questionsOf(result),
    logPath,
  };
}

// A run as the dashboard gets it: without where its log is on disk, its questions (the task
// carries those, board.mjs) nor the comments it ran on (their text is in its log).
export function publicRun(r) {
  const { logPath, questions, items, ...rest } = r;
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

// Runs the listener started itself (conflicts.mjs).
const REASONS = {
  conflict: "Rebasing a pull request in conflict",
};

// The listener's own lines: a run's first line (what it is), notes and delivered comments.
function listenerEntries(e, agent) {
  if (e.event === "note") return [{ kind: "meta", text: e.message }];
  if (e.event === "delivered") {
    const time = new Date(e.at).toISOString().slice(11, 19);
    const text = `New comment delivered to ${agent.displayName} at ${time} UTC: ${e.message}`;
    return [{ kind: "meta", text }];
  }
  const own = e.taskMode && e.taskMode !== "work" ? `Starting the ${e.taskMode} mode` : null;
  const what =
    (REASONS[e.reason] ?? GOING_ON[e.mode] ?? STARTING[e.kind] ?? own ?? "Starting") +
    (e.model ? ` (${e.model}, ${e.effort} effort)` : "");
  return [{ kind: "meta", text: what + (e.message ? `: ${e.message}` : "") }];
}

// The agent's events (its normalize()) → the dashboard's entries.
function agentEntry(e, agent) {
  switch (e.type) {
    case "started":
      // Codex doesn't say its model there: the run's first line does.
      return {
        kind: "meta",
        text: `${agent.displayName} started${e.model ? ` (${e.model})` : ""}`,
      };
    case "text":
      return { kind: "text", text: e.text };
    case "tool":
      return { kind: "tool", name: e.name, text: clip(e.detail, 6, 600) };
    case "toolOutput":
      return { kind: "output", error: e.error, text: clip(e.text, 40, 4000) };
    case "result": {
      const minutes = Math.round(e.durationMs / 6000) / 10;
      return { kind: "result", status: outcome(e), text: e.text, minutes };
    }
  }
  return null;
}

// One log line (the listener's, the agent's, or setup output) → entries for the dashboard.
// `agent`: the run's (agents/), Claude Code for logs from before agents had names.
export function format(line, agent = agentFor()) {
  if (!line.trim()) return [];
  const e = parse(line);
  if (!e) return [{ kind: "raw", text: line }];
  if (e.type === "listener") return listenerEntries(e, agent);
  return agent.normalize(line).flatMap((event) => agentEntry(event, agent) ?? []);
}

// Server-sent events: the log so far, then new lines as they are written, until the run ends,
// or until `allowed()` turns false (a sign-out, a repo's `users` narrowed): checked each second.
export function stream(req, res, run, allowed = () => true) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  const agent = agentFor(run.agent);
  let offset = 0;
  let rest = "";
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const pump = () => {
    if (!allowed()) return stop();
    const size = statSync(run.logPath).size;
    if (size > offset) {
      const fd = openSync(run.logPath, "r");
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      closeSync(fd);
      offset = size;
      const lines = (rest + buffer.toString("utf8")).split("\n");
      rest = lines.pop();
      const entries = lines.flatMap((l) => format(l, agent));
      if (entries.length) send("entries", entries);
    }
    if (run.status !== "running") {
      if (rest) send("entries", format(rest, agent));
      send("end", publicRun(run));
      return stop();
    }
  };
  const timer = setInterval(pump, 1000);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  const stop = () => {
    clearInterval(timer);
    clearInterval(keepAlive);
    res.end();
  };
  req.on("close", stop);
  pump();
}
