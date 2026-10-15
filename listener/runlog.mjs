// Runs and their logs, for the dashboard: each run's log file (logs/<run>.log, its first line
// the listener's, then the sandbox's stream-json), the list rebuilt from them after a restart,
// and the entries the dashboard shows for each line. Pure, apart from the log files.
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

// Starts the final message of a run that stopped to ask the maintainer (../prompts/sandbox.md).
export const NEEDS_INPUT = "<!-- needs-input -->";

// "ok", "needs-input" or "error" for a stream-json `result` event (null: no result).
export function outcome(result) {
  if (!result || result.is_error) return "error";
  return (result.result ?? "").trimStart().startsWith(NEEDS_INPUT) ? "needs-input" : "ok";
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
  const result = lines.map(parse).findLast((e) => e?.type === "result");
  const id = file.slice(0, -4);
  return {
    id,
    key: meta.key ?? id.replace(/-\d+$/, ""),
    kind: meta.kind ?? null,
    title: meta.title ?? null,
    repo: meta.repo ?? null,
    replyTo: meta.replyTo ?? null,
    mode: meta.mode ?? null,
    taskMode: meta.taskMode ?? null,
    model: meta.model ?? null,
    effort: meta.effort ?? null,
    startedAt: meta.startedAt ?? Number(id.match(/-(\d+)$/)?.[1] ?? 0),
    finishedAt: statSync(logPath).mtimeMs,
    // Unfinished and not ours: the listener restarted during the run.
    status: result ? outcome(result) : "interrupted",
    summary: summaryOf(result),
    logPath,
  };
}

// A run as the dashboard gets it: without where its log is on disk.
export function publicRun(r) {
  const { logPath, ...rest } = r;
  return rest;
}

// The first line of a run's reply, for the dashboard: what the run ended with. Headings
// ("## Needs your input") say less than the sentence under them.
export function summaryOf(result) {
  const lines = (result?.result ?? "").replace(NEEDS_INPUT, "").split("\n");
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

// The listener's own lines: a run's first line (what it is), notes and delivered comments.
function listenerEntries(e) {
  if (e.event === "note") return [{ kind: "meta", text: e.message }];
  if (e.event === "delivered") {
    const time = new Date(e.at).toISOString().slice(11, 19);
    return [{ kind: "meta", text: `New comment delivered to Claude at ${time} UTC: ${e.message}` }];
  }
  const own = e.taskMode && e.taskMode !== "work" ? `Starting the ${e.taskMode} mode` : null;
  const what =
    (GOING_ON[e.mode] ?? STARTING[e.kind] ?? own ?? "Starting") +
    (e.model ? ` (${e.model}, ${e.effort} effort)` : "");
  return [{ kind: "meta", text: what + (e.message ? `: ${e.message}` : "") }];
}

// Claude's text, and its tool calls with what they are about.
function assistantEntries(e) {
  return (e.message?.content ?? []).flatMap((c) => {
    if (c.type === "text") return [{ kind: "text", text: c.text }];
    if (c.type !== "tool_use") return [];
    const i = c.input ?? {};
    const detail =
      i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? i.prompt ?? i.query;
    const text = detail ?? (Object.keys(i).length ? JSON.stringify(i) : "");
    return [{ kind: "tool", name: c.name, text: clip(text, 6, 600) }];
  });
}

// What the tools gave back.
function userEntries(e) {
  return (e.message?.content ?? [])
    .filter((c) => c.type === "tool_result")
    .map((c) => {
      const text = Array.isArray(c.content)
        ? c.content.map((p) => p.text ?? "").join("\n")
        : (c.content ?? "");
      return { kind: "output", error: !!c.is_error, text: clip(text, 40, 4000) };
    });
}

// Each stream-json event type's entries; other types show nothing.
const ENTRIES = {
  listener: listenerEntries,
  system: (e) =>
    e.subtype === "init" ? [{ kind: "meta", text: `Claude started (${e.model})` }] : [],
  assistant: assistantEntries,
  user: userEntries,
  result: (e) => [
    {
      kind: "result",
      status: outcome(e),
      text: e.result ?? "",
      minutes: Math.round((e.duration_ms ?? 0) / 6000) / 10,
    },
  ],
};

// One log line (stream-json, or setup output) → entries for the dashboard.
export function format(line) {
  if (!line.trim()) return [];
  const e = parse(line);
  if (!e) return [{ kind: "raw", text: line }];
  return Object.hasOwn(ENTRIES, e.type) ? ENTRIES[e.type](e) : [];
}

// Server-sent events: the log so far, then new lines as they are written, until the run ends.
export function stream(req, res, run) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  let offset = 0;
  let rest = "";
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const pump = () => {
    const size = statSync(run.logPath).size;
    if (size > offset) {
      const fd = openSync(run.logPath, "r");
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      closeSync(fd);
      offset = size;
      const lines = (rest + buffer.toString("utf8")).split("\n");
      rest = lines.pop();
      const entries = lines.flatMap(format);
      if (entries.length) send("entries", entries);
    }
    if (run.status !== "running") {
      if (rest) send("entries", format(rest));
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
