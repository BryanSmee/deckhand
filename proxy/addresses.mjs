// Which addresses the egress proxy may connect to (proxy.mjs): never loopback, link-local,
// multicast or unspecified ones, the cloud's metadata service among them; private ones, and
// those of the networks the proxy is on (ownSubnets()), only when the operator allowed the
// host by name. IPv6 forms of an IPv4 address are checked as that address. No dependencies.
import { isIP } from "node:net";

function v4(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 ? parts : null;
}

// An IPv6 address as its 16 bytes, whatever way it is written (compressed or not, hex or
// dotted IPv4 tail, zone id); null when it isn't one. Strings can't be compared reliably:
// `::ffff:a9fe:a9fe` is `::ffff:169.254.169.254`.
export function v6Bytes(address) {
  const ip = address.replace(/%.*$/, "");
  if (isIP(ip) !== 6) return null;
  const [head, tail] = ip.split("::");
  const groups = (part) => (part ? part.split(":") : []);
  const words = (list) =>
    list.flatMap((group) => {
      if (!group.includes(".")) return [parseInt(group, 16)];
      const [a, b, c, d] = v4(group);
      return [(a << 8) | b, (c << 8) | d];
    });
  const before = words(groups(head));
  const after = words(groups(tail));
  const all =
    tail === undefined
      ? before
      : [...before, ...Array(8 - before.length - after.length).fill(0), ...after];
  return all.flatMap((word) => [word >> 8, word & 0xff]);
}

// The IPv4 address an IPv6 one stands for: IPv4-mapped (`::ffff:0:0/96`), IPv4-translated
// (`::ffff:0:0:0/96`), IPv4-compatible (`::/96`, so `::` and `::1` too), NAT64
// (`64:ff9b::/96`) and 6to4 (`2002::/16`, the address in its next 4 bytes), which all reach
// that IPv4 address through a translator or relay; null otherwise.
export function embeddedV4(bytes) {
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6).join(".");
  const prefix = bytes.slice(0, 12).join(",");
  const mapped = "0,0,0,0,0,0,0,0,0,0,255,255";
  const translated = "0,0,0,0,0,0,0,0,255,255,0,0";
  const compatible = "0,0,0,0,0,0,0,0,0,0,0,0";
  const nat64 = "0,100,255,155,0,0,0,0,0,0,0,0";
  return [mapped, translated, compatible, nat64].includes(prefix)
    ? bytes.slice(12).join(".")
    : null;
}

// Whether the proxy refuses to connect to `address`. `privateOk`: the operator allowed the
// host by name, so a LAN or Docker address is what they meant.
export function blockedAddress(address, privateOk) {
  let ip = address.toLowerCase();
  const bytes = v6Bytes(ip);
  if (bytes) ip = embeddedV4(bytes) ?? ip;
  if (isIP(ip) === 4) {
    const [a, b] = v4(ip);
    if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return true;
    // Benchmarking (198.18/15): no one's address on the internet.
    if (a === 198 && (b === 18 || b === 19)) return true;
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b < 128);
    return isPrivate && !privateOk;
  }
  if (bytes) {
    const [a, b] = bytes;
    // Multicast, link-local (fe80::/10) and the deprecated site-local (fec0::/10).
    if (a === 0xff || (a === 0xfe && b >= 0x80)) return true;
    // Unique local (fc00::/7), and NAT64's local-use prefix (64:ff9b:1::/48), which a
    // network's own translator maps to IPv4 addresses we can't see.
    const isPrivate = (a & 0xfe) === 0xfc || bytes.slice(0, 6).join(",") === "0,100,255,155,0,1";
    return isPrivate && !privateOk;
  }
  return true;
}

// An address as { family, bytes }, an IPv6 form of an IPv4 one as that IPv4 address; null
// when it isn't one.
function parsed(address) {
  let ip = address.toLowerCase();
  const bytes = v6Bytes(ip);
  if (bytes) ip = embeddedV4(bytes) ?? ip;
  if (isIP(ip) === 4) return { family: 4, bytes: v4(ip) };
  return bytes ? { family: 6, bytes } : null;
}

// The subnets of the networks the proxy is on (os.networkInterfaces()'s shape), loopback
// aside: { family, bytes, prefix }. Each run's network is one, and the compose network the
// listener is on another: Deckhand's own sandboxes, engines and listener, whatever range the
// operator or Docker gave them.
export function ownSubnets(interfaces) {
  const out = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const { cidr, internal } of list ?? []) {
      if (internal || !cidr) continue;
      const [address, prefix] = cidr.split("/");
      const at = parsed(address);
      if (at) out.push({ ...at, prefix: Number(prefix) });
    }
  }
  return out;
}

// Whether `address` is inside one of `subnets` (ownSubnets()).
export function inSubnets(address, subnets) {
  const at = parsed(address);
  if (!at) return false;
  return subnets.some(({ family, bytes, prefix }) => {
    if (family !== at.family) return false;
    const whole = Math.floor(prefix / 8);
    for (let i = 0; i < whole; i++) if (bytes[i] !== at.bytes[i]) return false;
    const bits = prefix % 8;
    if (!bits) return true;
    const mask = (0xff << (8 - bits)) & 0xff;
    return (bytes[whole] & mask) === (at.bytes[whole] & mask);
  });
}
