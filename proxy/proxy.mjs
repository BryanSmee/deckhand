// Deckhand's egress proxy: the only way out of the sandboxes' network, which is internal (no
// route out). It handles HTTP CONNECT (HTTPS and anything tunnelled) and plain HTTP requests,
// and for each one asks the listener whether the sandbox at that source address may reach
// that host (POLICY_URL, ../listener/egress.mjs decides). Anything else, or a listener that
// doesn't answer, is refused. No dependencies: node:http, node:net, node:dns.
//
// The proxy resolves the name itself and connects to the address it checked, so a name
// can't be pointed at the host or the cloud's metadata service once allowed: loopback,
// link-local and unspecified addresses are always refused, private ones unless the operator
// allowed the host by name or domain (not only through "*", nor a repo's own hosts).
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect, isIP } from "node:net";
import { pathToFileURL } from "node:url";

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
function embeddedV4(bytes) {
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

// "host:443", "[::1]:443" → { host, port }; null when it isn't one.
export function target(authority) {
  const match = /^(?:\[([0-9a-f:.]+)\]|([^:\[\]]+)):(\d{1,5})$/i.exec(authority ?? "");
  const port = Number(match?.[3]);
  if (!match || port < 1 || port > 65535) return null;
  return { host: (match[1] ?? match[2]).toLowerCase().replace(/\.$/, ""), port };
}

// Asks the listener: { allowed, private }. Fails closed.
export function listenerPolicy(url, timeoutMs = 5000) {
  return async (ip, host) => {
    try {
      const query = new URLSearchParams({ ip, host });
      const res = await fetch(`${url}?${query}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { allowed: false };
      const answer = await res.json();
      return { allowed: answer.allowed === true, private: answer.private === true };
    } catch {
      return { allowed: false };
    }
  };
}

class Refused extends Error {}

export function createProxy({
  policy, // (client ip, host) → { allowed, private }
  lookup = (host) => dnsLookup(host, { all: true }),
  blocked = blockedAddress,
  log = () => {},
}) {
  // The address to connect to, or a Refused saying why not.
  async function decide(client, host) {
    const ip = client.replace(/^::ffff:/, "");
    const { allowed, private: privateOk } = await policy(ip, host);
    if (!allowed) {
      log(`refused ${host} for ${ip}`);
      throw new Refused(
        `Deckhand's egress proxy refused ${host}: it is not among the hosts this sandbox may reach. ` +
          "A repository adds hosts with `hosts` in its .deckhand.yaml; the operator with ALLOWED_HOSTS.",
      );
    }
    let addresses;
    try {
      addresses = isIP(host) ? [{ address: host }] : await lookup(host);
    } catch {
      throw new Refused(`Deckhand's egress proxy could not resolve ${host}`, { cause: 502 });
    }
    const usable = addresses.find((a) => !blocked(a.address, privateOk));
    if (!usable) {
      log(`refused ${host} for ${ip}: private address`);
      throw new Refused(
        `Deckhand's egress proxy refused ${host}: it resolves to a private address`,
      );
    }
    return usable.address;
  }

  function refuse(socket, error) {
    const status = error.cause === 502 ? "502 Bad Gateway" : "403 Forbidden";
    const text = error instanceof Refused ? error.message : "Deckhand's egress proxy failed";
    socket.end(
      `HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${text}\n`,
    );
  }

  // CONNECT host:port: a tunnel once allowed.
  async function tunnel(req, client, head) {
    client.on("error", () => {});
    const to = target(req.url);
    if (!to) return refuse(client, new Refused("expected CONNECT host:port"));
    let address;
    try {
      address = await decide(req.socket.remoteAddress, to.host);
    } catch (error) {
      return refuse(client, error);
    }
    let connected = false;
    const upstream = connect(to.port, address, () => {
      connected = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      if (connected) return client.destroy();
      const why = `Deckhand's egress proxy could not reach ${to.host}:${to.port}`;
      refuse(client, new Refused(why, { cause: 502 }));
    });
    client.on("close", () => upstream.destroy());
  }

  // Plain HTTP: the request line holds the absolute URL.
  async function forward(req, res) {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      url = null;
    }
    if (url?.protocol !== "http:") {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("Deckhand's egress proxy: expected an http:// URL or CONNECT\n");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    let address;
    try {
      address = await decide(req.socket.remoteAddress, host);
    } catch (error) {
      res.writeHead(error.cause === 502 ? 502 : 403, { "content-type": "text/plain" });
      return res.end(`${error instanceof Refused ? error.message : "refused"}\n`);
    }
    const headers = { ...req.headers, host: url.host };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("proxy-")) delete headers[name];
    }
    const upstream = httpRequest(
      {
        host: address,
        port: url.port || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers,
        setHost: false,
      },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Deckhand's egress proxy could not reach ${host}\n`);
    });
    req.pipe(upstream);
  }

  const server = createServer(forward);
  server.on("connect", (req, client, head) => {
    tunnel(req, client, head).catch(() => client.destroy());
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.POLICY_URL || "http://listener:8081/egress";
  const port = Number(process.env.PORT ?? 3128);
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  createProxy({ policy: listenerPolicy(url), log }).listen(port, () =>
    log(`Egress proxy on :${port}, asking ${url}`),
  );
}
