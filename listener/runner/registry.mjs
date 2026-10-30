// An image registry's HTTP API (the OCI distribution spec), as the Kubernetes runner's images
// need it (kube-images.mjs): whether a tag is there and its digest (a manifest HEAD, in
// place of `docker image inspect`), a repository's tags with when each was built, and
// deleting one. Over fetch, injected so tests play the registry; no client library.
//
// Credentials are a docker config's `auths` (a kubernetes.io/dockerconfigjson Secret's): a
// registry that asks for a bearer token gets one from its realm with them (or anonymously,
// for a public image), one that asks for Basic gets them directly.
import { createHash } from "node:crypto";

// What a manifest HEAD or GET accepts: an image's manifest or a multi-platform index.
const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const INDEXES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

// Docker Hub's names: a reference without a registry host is one of its images.
const HUB = "docker.io";
const HUB_API = "registry-1.docker.io";

// "host[:port]/path[:tag][@digest]" → { host, name, reference }. The first part is a host
// when it has a dot or a port, or is localhost, as Docker reads it; else the image is Docker
// Hub's (library/ for a single name).
export function parseRef(ref) {
  let rest = ref;
  let reference = "latest";
  const at = rest.indexOf("@");
  if (at !== -1) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const slash = rest.indexOf("/");
  const first = slash === -1 ? "" : rest.slice(0, slash);
  const registry = first && (/[.:]/.test(first) || first === "localhost");
  let host = registry ? first : HUB;
  let name = registry ? rest.slice(slash + 1) : rest;
  const colon = name.lastIndexOf(":");
  if (colon !== -1) {
    if (at === -1) reference = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  if (host === HUB && !name.includes("/")) name = `library/${name}`;
  return { host, name, reference };
}

// A docker config's `auths` (a dockerconfigjson's) → host → { username, password }.
export function authsOf(config) {
  const found = {};
  for (const [key, entry] of Object.entries(config?.auths ?? {})) {
    const host = key.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    let { username, password } = entry ?? {};
    if (entry?.auth && !username) {
      const text = Buffer.from(entry.auth, "base64").toString();
      const colon = text.indexOf(":");
      [username, password] = [text.slice(0, colon), text.slice(colon + 1)];
    }
    if (username) found[host === "index.docker.io" ? HUB : host] = { username, password };
  }
  return found;
}

// The parameters of a WWW-Authenticate challenge: `Bearer realm="…",service="…"`.
export function challenge(header) {
  const m = /^(\w+)\s*(.*)$/.exec(header ?? "");
  if (!m) return null;
  const params = {};
  for (const [, k, v] of m[2].matchAll(/(\w+)="([^"]*)"/g)) params[k] = v;
  return { scheme: m[1].toLowerCase(), params };
}

// `auths()`: host → { username, password }, read at each call (the Secret may change).
export function createRegistry({ fetch = globalThis.fetch, auths = async () => ({}) } = {}) {
  const base = (host) => `https://${host === HUB ? HUB_API : host}/v2/`;

  // A request to `host`'s API, authenticated as it asks: `scope` is what a bearer token is
  // asked for ("repository:<name>:pull").
  async function request(host, method, path, { accept, scope } = {}) {
    const url = base(host) + path;
    const headers = accept ? { accept } : {};
    const res = await fetch(url, { method, headers });
    if (res.status !== 401) return res;
    const asked = challenge(res.headers.get("www-authenticate"));
    await res.body?.cancel();
    const creds = (await auths())[host];
    const basic = creds
      ? `Basic ${Buffer.from(`${creds.username}:${creds.password ?? ""}`).toString("base64")}`
      : null;
    let authorization;
    if (asked?.scheme === "bearer" && asked.params.realm) {
      authorization = `Bearer ${await token(asked.params, scope, basic)}`;
    } else if (asked?.scheme === "basic" && basic) {
      authorization = basic;
    } else {
      return new Response(null, { status: 401 });
    }
    return fetch(url, { method, headers: { ...headers, authorization } });
  }

  // A token from the realm the registry names, with the credentials when there are some.
  async function token({ realm, service }, scope, basic) {
    const url = new URL(realm);
    if (service) url.searchParams.set("service", service);
    if (scope) url.searchParams.set("scope", scope);
    const res = await fetch(url, { headers: basic ? { authorization: basic } : {} });
    if (!res.ok) throw new Error(`a token from ${url.host}: HTTP ${res.status}`);
    const answer = await res.json();
    const found = answer.token ?? answer.access_token;
    if (!found) throw new Error(`a token from ${url.host}: none in its answer`);
    return found;
  }

  async function failed(what, res) {
    let message = "";
    try {
      const body = await res.text();
      message = JSON.parse(body).errors?.[0]?.message ?? body;
    } catch {}
    return new Error(`${what}: HTTP ${res.status}${message ? ` (${message.slice(0, 200)})` : ""}`);
  }

  // The manifest's digest, or null when the registry has no such tag (or repository). Not
  // every registry answers a HEAD with the digest: the manifest is read and hashed then.
  async function digest(ref) {
    const { host, name, reference } = parseRef(ref);
    const scope = `repository:${name}:pull`;
    const path = `${name}/manifests/${reference}`;
    const res = await request(host, "HEAD", path, { accept: MANIFESTS, scope });
    if (res.status === 404) return null;
    if (!res.ok) throw await failed(`looking up ${ref}`, res);
    const said = res.headers.get("docker-content-digest");
    if (said) return said;
    const got = await request(host, "GET", path, { accept: MANIFESTS, scope });
    if (got.status === 404) return null;
    if (!got.ok) throw await failed(`reading ${ref}`, got);
    const body = Buffer.from(await got.arrayBuffer());
    return `sha256:${createHash("sha256").update(body).digest("hex")}`;
  }

  // The tags of `repository` ("host/name"), or null when it has none yet (or the registry
  // can't tell).
  async function tags(repository) {
    const { host, name } = parseRef(repository);
    const scope = `repository:${name}:pull`;
    const found = [];
    let path = `${name}/tags/list?n=1000`;
    while (path) {
      const res = await request(host, "GET", path, { scope });
      if (res.status === 404) return found.length ? found : null;
      if (!res.ok) throw await failed(`listing the tags of ${repository}`, res);
      found.push(...((await res.json()).tags ?? []));
      // The next page, when there is one: Link: </v2/<name>/tags/list?…>; rel="next".
      const next = /<\/v2\/([^>]+)>;\s*rel="?next"?/.exec(res.headers.get("link") ?? "");
      path = next ? next[1] : null;
    }
    return found;
  }

  async function json(host, path, scope, accept) {
    const res = await request(host, "GET", path, { accept, scope });
    if (!res.ok) throw await failed(`reading ${host}/${path}`, res);
    return { type: res.headers.get("content-type")?.split(";")[0], body: await res.json() };
  }

  // When the image `ref` was built (its config's `created`), as milliseconds; 0 when it says
  // nothing. A multi-platform index: its first image's.
  async function created(ref) {
    const { host, name, reference } = parseRef(ref);
    const scope = `repository:${name}:pull`;
    let manifest = await json(host, `${name}/manifests/${reference}`, scope, MANIFESTS);
    if (INDEXES.has(manifest.type) || manifest.body.manifests) {
      const first = manifest.body.manifests?.[0]?.digest;
      if (!first) return 0;
      manifest = await json(host, `${name}/manifests/${first}`, scope, MANIFESTS);
    }
    const config = manifest.body.config?.digest;
    if (!config) return 0;
    const { body } = await json(host, `${name}/blobs/${config}`, scope);
    return Date.parse(body.created ?? "") || 0;
  }

  // Deletes the manifest `digest` of `repository`, and with it every tag that points at it;
  // or, given a tag, that tag alone, where the registry can (not every one does). Gone
  // already is fine; a registry that doesn't allow deletes says so.
  async function remove(repository, manifest) {
    const { host, name } = parseRef(repository);
    const res = await request(host, "DELETE", `${name}/manifests/${manifest}`, {
      scope: `repository:${name}:pull,push,delete`,
    });
    if (!res.ok && res.status !== 404)
      throw await failed(`deleting ${repository}@${manifest}`, res);
    await res.body?.cancel();
  }

  return { digest, tags, created, remove };
}
