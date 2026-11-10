// Git's pkt-lines (gitprotocol-common): a 4-digit hex length, its own 4 bytes included, then
// the payload; 0000 a flush, 0001 and 0002 delimiters. One reader for the git gateway's pushes
// (git-gateway.mjs), the GitHub gateway's fetch checks (github-forks.mjs) and the answers it
// counts (packIn()): two parsers in security checks would drift apart.

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

// What a pack request's answer says, read pkt-line by pkt-line from its start: whether it
// carries the pack (protocol v2's "packfile" section line, v0's pack on side-band 1 or bare
// after the acknowledgments), or GitHub's error ("ERR …", side-band 3: an object it doesn't
// have, say). Neither: a round of negotiation, or ls-refs. Whole lines only, so a ref named
// …packfile is no pack. Read until one of them, within its first MAX_PACK_SCAN bytes.
const MAX_PACK_SCAN = 1024 * 1024;
export function packIn() {
  let held = Buffer.alloc(0);
  let seen = 0;
  // null while reading; "pack", "error", or "unknown" for what isn't pkt-lines.
  let said = null;
  function line(payload) {
    if (payload.toString("latin1") === "packfile\n") return "pack";
    if (payload.subarray(0, 4).toString("latin1") === "ERR ") return "error";
    if (payload[0] === 1 && payload.subarray(1, 5).toString("latin1") === "PACK") return "pack";
    if (payload[0] === 3) return "error";
    return null;
  }
  return {
    push(chunk) {
      if (said || seen > MAX_PACK_SCAN) return;
      seen += chunk.length;
      held = Buffer.concat([held, chunk]);
      while (!said && held.length >= 4) {
        const head = held.subarray(0, 4).toString("latin1");
        if (head === "PACK") return void (said = "pack");
        if (!/^[0-9a-f]{4}$/i.test(head)) return void (said = "unknown");
        const length = parseInt(head, 16);
        // A flush, delimiter or response-end packet: no payload.
        if (length < 4) {
          held = held.subarray(4);
          continue;
        }
        if (held.length < length) return;
        said = line(held.subarray(4, length));
        held = held.subarray(length);
      }
    },
    found: () => said === "pack",
    failed: () => said === "error",
  };
}
