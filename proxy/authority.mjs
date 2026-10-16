// Deckhand's CA, with which the egress proxy terminates TLS for the hosts the listener says
// may be cached (proxy.mjs): sandboxes trust its certificate (ca.crt), never see its key
// (ca.key), which stays in the proxy's volume. Created once, on the first start, and kept
// across restarts. Each host gets a short-lived certificate of its own, kept in memory and
// on disk, made again when it nears its end or the CA changed.
//
// Node can't create certificates: the `openssl` CLI does, as the listener uses the docker
// CLI. No dependencies.
import { execFile } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { atomicWrite, tempPath } from "./atomic.mjs";

const DAY = 24 * 3600 * 1000;
export const CA_DAYS = 3650;
export const HOST_DAYS = 7;
// A host certificate this close to its end is made again.
const RENEW_MS = 2 * DAY;

// Only names and addresses go into a certificate: anything else could change openssl's
// config it is written into.
const NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
export const certifiable = (host) => NAME.test(host) || isIP(host) !== 0;

function runOpenssl(args) {
  return new Promise((resolve, reject) => {
    execFile("openssl", args, (error, _out, err) =>
      error ? reject(new Error(`openssl ${args[0]}: ${err.trim() || error.message}`)) : resolve(),
    );
  });
}

const CA_CONFIG = `[req]
distinguished_name = dn
prompt = no
[dn]
[deckhand_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;

const hostConfig = (host) => `[req]
distinguished_name = dn
prompt = no
[dn]
[deckhand_host]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = ${isIP(host) ? "IP" : "DNS"}:${host}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`;

const KEY = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

export function createAuthority({ dir, openssl = runOpenssl, now = Date.now, log = () => {} }) {
  const caKey = join(dir, "ca.key");
  const caCrt = join(dir, "ca.crt");
  const hostsDir = join(dir, "hosts");
  const temp = (name) => tempPath(dir, name);
  let ca = null; // { pem, x509 }
  const hosts = new Map(); // host → { key, cert, until }
  const making = new Map(); // host → its promise, so concurrent CONNECTs make one

  async function load() {
    const pem = await readFile(caCrt, "utf8");
    await readFile(caKey); // both, or it is made again
    return { pem, x509: new X509Certificate(pem) };
  }

  // The CA, made when there is none. Its key is written first: a crash in between leaves a
  // key without a certificate, which is made again.
  async function ready() {
    if (ca) return ca;
    mkdirSync(hostsDir, { recursive: true });
    try {
      ca = await load();
      return ca;
    } catch {}
    const config = temp("ca.cnf");
    const key = temp("ca.key");
    const crt = temp("ca.crt");
    try {
      await writeFile(config, CA_CONFIG);
      const id = randomBytes(4).toString("hex");
      await openssl([
        "req",
        "-x509",
        ...KEY,
        ...["-keyout", key, "-out", crt, "-days", String(CA_DAYS)],
        ...["-subj", `/CN=Deckhand egress CA ${id}`, "-config", config],
        ...["-extensions", "deckhand_ca"],
      ]);
      await chmod(key, 0o600);
      await rename(key, caKey);
      await rename(crt, caCrt);
    } finally {
      await Promise.all([config, key, crt].map((p) => rm(p, { force: true })));
    }
    // Certificates of a previous CA are of no use.
    hosts.clear();
    ca = await load();
    log(`CA created in ${dir}`);
    return ca;
  }

  // When a certificate issued by this CA ends; null when it isn't one.
  function issued(pem) {
    try {
      const x509 = new X509Certificate(pem);
      if (!x509.checkIssued(ca.x509) || !x509.verify(ca.x509.publicKey)) return null;
      return Date.parse(x509.validTo);
    } catch {
      return null;
    }
  }
  const lasting = (until) => !!until && until - now() > RENEW_MS;

  async function make(host) {
    await ready();
    // Hashed: a host name never becomes a path.
    const path = join(hostsDir, `${createHash("sha256").update(host).digest("hex")}.pem`);
    try {
      const pem = await readFile(path, "utf8");
      const cert = /-----BEGIN CERTIFICATE-----[^]*?-----END CERTIFICATE-----\n?/.exec(pem)?.[0];
      const key = /-----BEGIN PRIVATE KEY-----[^]*?-----END PRIVATE KEY-----\n?/.exec(pem)?.[0];
      const until = cert && key && issued(cert);
      if (lasting(until)) return { key, cert, until };
    } catch {}
    const config = temp("host.cnf");
    const key = temp("host.key");
    const crt = temp("host.crt");
    try {
      await writeFile(config, hostConfig(host));
      await openssl([
        "req",
        "-x509",
        ...KEY,
        ...["-keyout", key, "-out", crt, "-days", String(HOST_DAYS)],
        ...["-subj", `/CN=${host}`, "-config", config, "-extensions", "deckhand_host"],
        ...["-CA", caCrt, "-CAkey", caKey],
      ]);
      const entry = { key: await readFile(key, "utf8"), cert: await readFile(crt, "utf8") };
      entry.until = issued(entry.cert);
      if (!entry.until) throw new Error(`the certificate made for ${host} doesn't verify`);
      await atomicWrite(path, entry.key + entry.cert, { dir, name: "host.pem", mode: 0o600 });
      return entry;
    } finally {
      await Promise.all([config, key, crt].map((p) => rm(p, { force: true })));
    }
  }

  // → { key, cert } (PEM) for `host`.
  async function certFor(host) {
    if (!certifiable(host)) throw new Error(`no certificate for ${host}`);
    const known = hosts.get(host);
    if (known && lasting(known.until)) return known;
    if (!making.has(host)) {
      const pending = make(host)
        .then((entry) => {
          hosts.set(host, entry);
          return entry;
        })
        .finally(() => making.delete(host));
      making.set(host, pending);
    }
    return making.get(host);
  }

  return {
    ready,
    certFor,
    // The CA's certificate (PEM): public, what sandboxes trust. Null until ready().
    certificate: () => ca?.pem ?? null,
  };
}
