// Deckhand's CA, with which the egress proxy terminates TLS for the hosts the orchestrator's
// egress policy says may be cached (proxy.mjs): sandboxes trust its certificate (ca.crt), never see its key
// (ca.key), which stays in the proxy's volume. Created once, on the first start, and kept
// across restarts, for a year: made again a month before its end, which sandboxes pick up at
// their next start (the orchestrator asks the proxy for it at each run). Each host gets a
// short-lived certificate of its own, kept in memory and on disk, made again when it nears its
// end or the CA changed.
//
// The CA can't vouch for the agents' providers (EXCLUDED, its name constraints): the operator's
// credentials go there, and its key, should it leak, mustn't open that traffic. It does vouch
// for GitHub, whose calls the proxy relays to the github service's GitHub gateway: no sandbox
// holds a GitHub token any more, so a leaked key opens none.
//
// Node can't create certificates: the `openssl` CLI does, as the runner uses the docker CLI.
// No dependencies.
import { execFile } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { atomicWrite, tempPath } from "./atomic.mjs";

const DAY = 24 * 3600 * 1000;
export const CA_DAYS = 365;
const HOST_DAYS = 7;
// A host certificate this close to its end is made again; the CA, this close to its own.
const RENEW_MS = 2 * DAY;
const CA_RENEW_MS = 30 * DAY;

// Names (and their subdomains) the CA may never certify: the agents' providers, whose traffic
// would carry the operator's credentials, never decrypted.
export const EXCLUDED = ["anthropic.com", "openai.com", "chatgpt.com"];
// Names a CA from before the GitHub gateway excluded: one that still does is made again, or
// the proxy couldn't relay GitHub's calls (../listener/github-gateway.mjs).
const NO_LONGER_EXCLUDED = ["github.com", "githubusercontent.com"];
export const excluded = (host) =>
  EXCLUDED.some((name) => host === name || host.endsWith(`.${name}`));

// Only names and addresses go into a certificate: anything else could change openssl's
// config it is written into.
const NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
export const certifiable = (host) => (NAME.test(host) && !excluded(host)) || isIP(host) !== 0;

// The DER of the nameConstraints extension's OID (2.5.29.30): a CA from before them lacks it.
const NAME_CONSTRAINTS = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e]);

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
nameConstraints = critical,${EXCLUDED.map((name) => `excluded;DNS:${name}`).join(",")}
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
  let renewing = null; // ready()'s promise while it makes one, so concurrent calls make one
  const hosts = new Map(); // host → { key, cert, until }
  const making = new Map(); // host → its promise, so concurrent CONNECTs make one

  async function load() {
    const pem = await readFile(caCrt, "utf8");
    await readFile(caKey); // both, or it is made again
    return { pem, x509: new X509Certificate(pem) };
  }

  // Whether `found` is still the CA to use: not near its end, and made with the name
  // constraints and lifetime of now (an older one lasted ten years and had none, and a later
  // one excluded GitHub: its names show in the extension's DER, as IA5 strings).
  function current(found) {
    const from = Date.parse(found.x509.validFrom);
    const to = Date.parse(found.x509.validTo);
    const { raw } = found.x509;
    return (
      to - now() > CA_RENEW_MS &&
      to - from <= (CA_DAYS + 1) * DAY &&
      raw.includes(NAME_CONSTRAINTS) &&
      !NO_LONGER_EXCLUDED.some((name) => raw.includes(name))
    );
  }

  // The CA, made when there is none, or when it isn't current() any more.
  async function ready() {
    if (ca && current(ca)) return ca;
    renewing ??= renew().finally(() => (renewing = null));
    return renewing;
  }

  // Its key is written first: a crash in between leaves a key without a certificate, which is
  // made again.
  async function renew() {
    mkdirSync(hostsDir, { recursive: true });
    if (!ca) {
      try {
        const found = await load();
        if (current(found)) {
          ca = found;
          return ca;
        }
        log(`CA in ${dir}: near its end, or without the name constraints of now; making a new one`);
      } catch {}
    } else {
      log(`CA in ${dir}: near its end; making a new one`);
    }
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
      // Its line end too, as openssl wrote it: \r\n on Windows.
      const cert = /-----BEGIN CERTIFICATE-----[^]*?-----END CERTIFICATE-----(\r?\n)?/.exec(
        pem,
      )?.[0];
      const key = /-----BEGIN PRIVATE KEY-----[^]*?-----END PRIVATE KEY-----(\r?\n)?/.exec(
        pem,
      )?.[0];
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
    // A new CA clears `hosts`: their certificates are of no use to sandboxes started since.
    await ready();
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
    // The CA's certificate (PEM): public, what sandboxes trust. Null until ready(); call it
    // first for one that is current.
    certificate: () => ca?.pem ?? null,
  };
}
