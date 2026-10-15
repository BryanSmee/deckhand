// The runs' subnets (SANDBOX_SUBNETS): an IPv4 range the operator sets aside, cut into blocks
// of SANDBOX_SUBNET_SIZE, one per run's network (runner/docker.mjs), so Deckhand doesn't draw
// from Docker's default address pools, which the host's other projects share.

// "10.200.0.0/16" → { base, prefix }, base as an unsigned 32-bit number; null when it isn't
// an IPv4 range. Host bits must be zero: "10.200.1.0/16" is a typo for one range or another.
export function parseCidr(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(text).trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  const base = octets.reduce((n, o) => n * 256 + o, 0);
  if (base % 2 ** (32 - prefix) !== 0) return null;
  return { base, prefix };
}

const format = (n, prefix) =>
  `${[24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".")}/${prefix}`;

// Whether two CIDRs share an address. Anything that isn't IPv4 (an IPv6 subnet) doesn't.
export function overlaps(a, b) {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (!x || !y) return false;
  const end = (c) => c.base + 2 ** (32 - c.prefix);
  return x.base < end(y) && y.base < end(x);
}

// The blocks of `subnets` ({ base, prefix, size }) that none of `used` (CIDRs) touches, lowest
// first. Lazy: a /8 holds millions of blocks, and the first free one is usually enough.
export function* freeBlocks({ base, prefix, size }, used = []) {
  const step = 2 ** (32 - size);
  const end = base + 2 ** (32 - prefix);
  const taken = used.map(parseCidr).filter(Boolean);
  let at = base;
  while (at < end) {
    const hit = taken.find((t) => t.base < at + step && at < t.base + 2 ** (32 - t.prefix));
    if (!hit) {
      yield format(at, size);
      at += step;
    } else {
      // Past the network in the way, to the next block boundary.
      const after = hit.base + 2 ** (32 - hit.prefix);
      at = Math.max(at + step, base + Math.ceil((after - base) / step) * step);
    }
  }
}
