// The Kubernetes API, as the Kubernetes runner (kubernetes.mjs) calls it: in the cluster, with
// the runner's ServiceAccount (its token and the cluster's CA under SERVICE_ACCOUNT), over
// node:https. No client library, no kubectl. `fetch` is injected so tests play the API; the
// default one is inClusterFetch().
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { Readable } from "node:stream";

export const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

// An answer the API gave with an error status: `status` tells 404 (not found) and 409
// (already there) apart from the rest.
export class KubeError extends Error {
  constructor(what, status, message) {
    super(`${what}: ${message || `HTTP ${status}`}`);
    this.status = status;
  }
}

// A fetch() over node:https that trusts the cluster's CA, which the global fetch can't be
// told about. Answers a Response, its body a stream (a pod's log, followed).
export function inClusterFetch({ ca = readFileSync(`${SERVICE_ACCOUNT}/ca.crt`) } = {}) {
  return (url, { method = "GET", headers = {}, body, signal } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(url, { method, headers, ca, signal }, (res) => {
        const empty = [101, 204, 205, 304].includes(res.statusCode);
        const head = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          for (const one of [v].flat()) if (one !== undefined) head.append(k, String(one));
        }
        if (empty) res.resume();
        resolve(
          new Response(empty ? null : Readable.toWeb(res), {
            status: res.statusCode,
            headers: head,
          }),
        );
      });
      // A connection that died without a word (a lost node, an API server replaced) shows
      // as one: a followed log otherwise waits on it forever.
      req.on("socket", (socket) => socket.setKeepAlive(true, 30_000));
      req.on("error", reject);
      req.end(body);
    });
}

// The API server's URL from the variables Kubernetes sets in every pod. An IPv6 host (a
// single-stack or IPv6-first cluster) goes in brackets, as a URL needs.
export function apiBase(env = process.env) {
  const host = env.KUBERNETES_SERVICE_HOST ?? "";
  return `https://${host.includes(":") ? `[${host}]` : host}:${env.KUBERNETES_SERVICE_PORT}`;
}

// `base`: the API server's URL; `token()`: the bearer token, read at each call, as the
// kubelet rotates it; `namespace`: the one relative paths are in (the runner has one API per
// namespace, index.mjs: the sandboxes' and the services'); `timeoutMs`: how long a call (not
// a stream, whose caller says when to stop) waits for its whole answer.
export function createKubeApi({
  fetch = inClusterFetch(),
  base = apiBase(),
  token = () => readFileSync(`${SERVICE_ACCOUNT}/token`, "utf8").trim(),
  namespace,
  timeoutMs = 30_000,
}) {
  const ns = `/api/v1/namespaces/${namespace}`;

  // `path`: under the namespace when it starts with a resource ("pods", "secrets"…), else from
  // the root. `query`: an object of parameters.
  function url(path, query = {}) {
    const full = path.startsWith("/") ? path : `${ns}/${path}`;
    const q = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null),
    ).toString();
    return `${base}${full}${q ? `?${q}` : ""}`;
  }

  // The answer, or a KubeError naming `method path` and the API's own message.
  async function call(method, path, { query, body, signal } = {}) {
    const headers = { authorization: `Bearer ${token()}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (res.ok) return res;
    let message = "";
    try {
      const text = await res.text();
      message = JSON.parse(text).message ?? text;
    } catch {}
    throw new KubeError(`${method} ${path}`, res.status, message);
  }

  // call()'s answer, read whole as JSON within `timeoutMs`: a connection that hangs is an
  // error the caller can retry (kubernetes.mjs look()), not a wait without end.
  async function answer(method, path, options = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await call(method, path, { ...options, signal });
      if (method === "DELETE") return await res.body?.cancel();
      return res.status === 204 ? null : await res.json();
    } catch (error) {
      if (!signal.aborted) throw error;
      throw new KubeError(`${method} ${path}`, 0, `no answer in ${timeoutMs / 1000} s`);
    }
  }

  return {
    namespace,
    get: (path, query) => answer("GET", path, { query }),
    // null for a 404: "is it there?" is a question the runner asks often.
    find: async (path, query) => {
      try {
        return await answer("GET", path, { query });
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    create: (path, body) => answer("POST", path, { body }),
    // The whole object, in place (its metadata.resourceVersion, when set, guards the change).
    replace: (path, body) => answer("PUT", path, { body }),
    // False when it was gone already.
    remove: async (path, query) => {
      try {
        await answer("DELETE", path, { query });
        return true;
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    },
    // The answer itself, its body read as it comes (a followed log), until `signal` aborts:
    // no time limit of its own.
    stream: (path, query, signal) => call("GET", path, { query, signal }),
  };
}
