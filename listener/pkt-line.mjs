// Git's pkt-lines (gitprotocol-common): a 4-digit hex length, its own 4 bytes included, then
// the payload; 0000 a flush, 0001 and 0002 delimiters. One reader for the git gateway's pushes
// (git-gateway.mjs) and the GitHub gateway's fetch checks (github-forks.mjs): two parsers in
// security checks would drift apart.

// One pkt-line holding `data` (a string or bytes).
export function pkt(data) {
  const body = Buffer.from(data);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

// A reader of pkt-lines as they stream: push(chunk) calls `onLine(payload)` for each whole line
// (flushes and delimiters left out), up to a line that is cut, held for the next chunk (64 KiB
// at most), or one that isn't a pkt-line, where it stops for good.
export function pktReader(onLine) {
  let held = Buffer.alloc(0);
  let stopped = false;
  function push(chunk) {
    if (stopped) return;
    const buffer = held.length ? Buffer.concat([held, chunk]) : chunk;
    let at = 0;
    while (at + 4 <= buffer.length) {
      const hex = buffer.toString("latin1", at, at + 4);
      if (!/^[0-9a-f]{4}$/i.test(hex)) {
        stopped = true;
        return;
      }
      const length = parseInt(hex, 16);
      if (length < 4) {
        at += 4;
        continue;
      }
      if (at + length > buffer.length) break;
      onLine(buffer.subarray(at + 4, at + length));
      at += length;
    }
    held = Buffer.from(buffer.subarray(at));
  }
  return { push };
}

// The payloads of the pkt-lines in `buffer`, as pktReader() reads them.
export function pktLines(buffer) {
  const lines = [];
  pktReader((line) => lines.push(line)).push(buffer);
  return lines;
}
