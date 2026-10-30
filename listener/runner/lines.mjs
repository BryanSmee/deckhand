// A sandbox's output, line by line, as both runners read it: Docker's `docker logs --follow
// --timestamps` (docker.mjs) and the Kubernetes API's pod log with `timestamps=true`
// (kubernetes.mjs), which stamp each line the same way.

// The longest line follow() keeps: past it, the line is cut and the rest of it, up to its
// newline, dropped. Unbounded, one line with no newline would grow until the string can't
// (about 512 MB) and throw in the stream's handler, which takes the listener down (#241).
export const MAX_LINE = 1024 * 1024;
export const LINE_CUT = " … (line cut)";

// The RFC 3339 time `docker logs --timestamps` and the pod log's `timestamps=true` start each
// line with, nanoseconds and all.
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d) /;

// Docker keeps a line over 16 KiB as parts of 16384 bytes, and --timestamps stamps each part
// again, inside the line (moby/moby#37681, docker/cli#4941): those stamps go too. A part may
// be a few bytes longer: its json-file driver turns the bytes of a character split between two
// parts into U+FFFDs (with or without --timestamps), so each inner stamp is looked for just
// past the part's 16384 bytes.
const PART = 16384;
const STAMP_MAX = 48; // bytes: "2026-10-29T08:00:00.123456789+02:00 " and some
const SLACK = 64; // bytes a part may grow by
const INNER = new RegExp(STAMP.source.slice(1));

const stampAt = (bytes, at) => STAMP.exec(bytes.subarray(at, at + STAMP_MAX).toString("latin1"));

// A line of `docker logs --timestamps`, as bytes → the line as written, and when (ms), or
// null for a line without the stamp. On bytes: a part may end inside a character.
export function unstamped(bytes) {
  const m = stampAt(bytes, 0);
  if (!m) return [bytes.toString("utf8"), null];
  // Date.parse() takes milliseconds, not Docker's nanoseconds.
  const at = Date.parse(m[1] + (m[2] ?? "").slice(0, 4) + m[3]);
  const parts = [];
  let from = m[0].length;
  while (from + PART < bytes.length) {
    const window = bytes.subarray(from + PART, from + PART + SLACK + STAMP_MAX);
    const inner = INNER.exec(window.toString("latin1"));
    if (!inner || inner.index > SLACK) break;
    const end = from + PART + inner.index;
    parts.push(bytes.subarray(from, end));
    from = end + inner[0].length;
  }
  parts.push(bytes.subarray(from));
  return [Buffer.concat(parts).toString("utf8"), Number.isNaN(at) ? null : at];
}

// The most bytes a line of MAX_LINE takes with its stamps.
const ROOM = MAX_LINE + (Math.ceil(MAX_LINE / PART) + 1) * STAMP_MAX;

// → push(chunk): bytes as they come, `each(line, at)` called with each whole line, decoded
// once whole (unstamped()), and when it was written (ms, or null). Only whole lines count: one
// cut short when the stream ends is dropped, and read again, whole, by the next follow(). A
// line over MAX_LINE is cut there (LINE_CUT) and the rest of it, up to its newline, dropped:
// it still counts as one line, the same for the next follow().
export function splitLines(each) {
  let rest = [];
  let size = 0;
  let cut = false; // the current line was cut: dropped up to its newline
  // `over`: it went past ROOM, and was cut there.
  const emit = (stamped, over = false) => {
    const [line, at] = unstamped(stamped);
    each(over || line.length > MAX_LINE ? line.slice(0, MAX_LINE) + LINE_CUT : line, at);
  };
  const take = () => {
    const line = Buffer.concat(rest);
    rest = [];
    size = 0;
    return line;
  };
  // A chunk is at most a pipe's or a socket's buffer: `rest` stays near ROOM.
  const add = (part) => {
    if (cut || !part.length) return;
    rest.push(part);
    size += part.length;
    if (size <= ROOM) return;
    emit(take(), true);
    cut = true;
  };
  return (chunk) => {
    let from = 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, from)) {
      add(chunk.subarray(from, i));
      if (cut) take();
      else emit(take());
      cut = false;
      from = i + 1;
    }
    add(chunk.subarray(from));
  };
}
