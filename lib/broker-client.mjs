// Calling the broker service (#505) from another service (the listener, the egress proxy): its
// service tokens, asked for at start and renewed (service-token.mjs serviceTokens()), and
// calls that carry them. Over node:http with an agent of its own: an HTTP_PROXY in the
// service's environment (for its own calls out) never takes the broker's.
import { readFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { serviceTokens } from "./service-token.mjs";

// The header a Kubernetes pod's projected token goes in, for the broker to review
// (../broker/callers.mjs).
export const POD_TOKEN_HEADER = "x-deckhand-pod-token";

// `url`: the broker's (BROKER_SERVICE_URL); `audiences`: the services the caller calls, whose
// tokens it asks for; `podTokenFile`: on Kubernetes, the pod's token projected for the broker,
// read for each request (the kubelet renews it).
export function createBrokerCaller({
  url,
  audiences = ["broker"],
  podTokenFile = null,
  log = () => {},
  timeoutMs = 30_000,
  read = readFileSync,
}) {
  const base = new URL(url);
  const secure = base.protocol === "https:";
  const agent = secure ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });

  // One request: → { status, headers, body (a Buffer), json() }. `body`: a Buffer or text, an
  // object sent as JSON, or a stream sent as it comes (a sandbox's upload the listener relays:
  // the broker counts it against the run's cap while it comes).
  function request(method, path, { body, headers = {}, timeout = timeoutMs, signal } = {}) {
    const stream = typeof body?.pipe === "function";
    const json =
      body !== undefined && !stream && !Buffer.isBuffer(body) && typeof body !== "string";
    const data = json ? JSON.stringify(body) : stream ? undefined : body;
    return new Promise((resolve, reject) => {
      const to = new URL(path, base);
      const req = (secure ? httpsRequest : httpRequest)(
        to,
        {
          method,
          agent,
          signal,
          timeout,
          headers: {
            ...(json && { "content-type": "application/json" }),
            ...(data !== undefined && { "content-length": Buffer.byteLength(data) }),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            const bytes = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: bytes,
              json: () => JSON.parse(bytes.toString("utf8") || "null"),
            });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`the broker didn't answer ${method} ${path}`)));
      req.on("error", reject);
      if (stream) body.on("error", (error) => req.destroy(error)).pipe(req);
      else req.end(data);
    });
  }

  const podToken = () => (podTokenFile ? read(podTokenFile, "utf8").trim() : null);

  const tokens = serviceTokens({
    audiences,
    log,
    request: async (wanted) => {
      const pod = podToken();
      const res = await request("POST", "/service-tokens", {
        body: { audiences: wanted },
        headers: pod ? { [POD_TOKEN_HEADER]: pod } : {},
      });
      if (res.status !== 200) {
        throw new Error(`the broker refused service tokens: ${res.status} ${res.body}`);
      }
      return res.json().tokens;
    },
  });

  // Asked for again until the broker answers: a service starts whether it is up or not, and
  // its calls to the broker wait for them (header()).
  let started = null;
  function start() {
    started ??= (async () => {
      for (let delay = 1000; ; delay = Math.min(delay * 2, 30_000)) {
        try {
          await tokens.start();
          if (delay > 1000) log("Broker: service tokens received");
          return;
        } catch (error) {
          log(`Broker: no service token yet (${error.message}), asking again`);
          await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
        }
      }
    })();
    return started;
  }

  // A call to the broker with this service's token.
  async function call(method, path, options = {}) {
    const authorization = await tokens.header("broker");
    return request(method, path, {
      ...options,
      headers: { ...options.headers, authorization },
    });
  }

  return {
    url: base.href.replace(/\/$/, ""),
    start,
    stop: () => tokens.stop(),
    header: () => tokens.header("broker"),
    request,
    call,
  };
}
