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

// The ranges a run's network may be drawn from: RFC 1918's and CGNAT's (100.64/10), which the
// egress proxy refuses unless a host is granted by name (proxy/addresses.mjs). A public range
// would let a research run (any public host) reach another run's sandbox, its engine or the
// listener by pointing a name at it.
export const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];

// Whether the CIDR `text` lies whole inside one of PRIVATE_RANGES.
export function privateRange(text) {
  const c = parseCidr(text);
  if (!c) return false;
  return PRIVATE_RANGES.map(parseCidr).some(
    (r) =>
      c.prefix >= r.prefix &&
      Math.floor(c.base / 2 ** (32 - r.prefix)) === r.base / 2 ** (32 - r.prefix),
  );
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

// Whether the IPv4 `address` (or IPv4-mapped IPv6, as Node gives a dual-stack socket's) lies in
// the CIDR `range` ({ base, prefix }, parseCidr()'s).
export function inCidr(address, { base, prefix }) {
  const match = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(address ?? "");
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const n = octets.reduce((a, o) => a * 256 + o, 0);
  return Math.floor(n / 2 ** (32 - prefix)) === base / 2 ** (32 - prefix);
}
