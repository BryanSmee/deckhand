// Webhook bodies read before their signature can be checked: anyone can send one to the public
// port, so who may hold a place, and for how long, is limited here (http.mjs, docs/security.md).

// A client's address for its share of places: IPv4 as is, IPv6 by its /64 (one host usually
// has a whole /64 to pick addresses from).
export function sourceOf(address = "") {
  const a = address.replace(/^::ffff:(?=\d+\.)/, "");
  if (!a.includes(":")) return a;
  const [head, tail = ""] = a.split("::");
  const left = head ? head.split(":") : [];
  const right = a.includes("::") && tail ? tail.split(":") : [];
  const groups = [
    ...left,
    ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
    ...right,
  ];
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

// At most `total` places, `share` of them per source. A source past its share, or a full
// listener, takes the place of the oldest reader (its own first) once that one has had
// `graceMs`: GitHub sends a body in milliseconds, so the readers that old are slow ones, and a
// delivery still gets in behind a reverse proxy, where every delivery has the proxy's address.
// `take(source, drop)`: a function releasing the place, or null when there is none; `drop()`
// is called when another delivery takes it.
export function createSlots({ total, share, graceMs, now = Date.now }) {
  const held = new Set();

  function evict(slots) {
    const oldest = slots.reduce((a, b) => (b.since < a.since ? b : a));
    if (now() - oldest.since < graceMs) return false;
    held.delete(oldest);
    oldest.drop();
    return true;
  }

  function take(source, drop) {
    const mine = [...held].filter((s) => s.source === source);
    if (mine.length >= share && !evict(mine)) return null;
    if (held.size >= total && !evict([...held])) return null;
    const slot = { source, since: now(), drop };
    held.add(slot);
    return () => held.delete(slot);
  }

  return { take, size: () => held.size };
}

// The request's body as a Buffer, rejecting past `limit` bytes, after `idleMs` without a chunk
// or `totalMs` in all: the request is then dropped. GitHub sends its body at once.
export function readDelivery(req, { limit, idleMs, totalMs }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(idle);
      clearTimeout(total);
    };
    // Once the body is in, the connection is the answer's: nothing to drop.
    const fail = (error) => {
      if (done) return;
      finish();
      req.destroy();
      reject(error);
    };
    const idle = setTimeout(() => fail(new Error(`no data for ${idleMs} ms`)), idleMs);
    const total = setTimeout(() => fail(new Error(`body not received in ${totalMs} ms`)), totalMs);
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) return fail(new Error(`body over ${limit} bytes`));
      chunks.push(chunk);
      idle.refresh();
    });
    req.on("end", () => {
      finish();
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
    // Cut short without an error (a client gone, or its place taken): nothing more comes.
    req.on("close", () => fail(new Error("connection closed before the body's end")));
  });
}
