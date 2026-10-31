// Who asks the broker for service tokens (POST /service-tokens): the service the request
// proves it is, never one it names (../lib/service-token.mjs issueServiceTokens()).
//
//   - with Docker, the network it arrived on: each caller reaches the broker over a network of
//     its own, and the broker's address on it tells which (SERVICE_NETWORKS,
//     networkCallers());
//   - on Kubernetes, the pod's projected service account token, for the broker's audience
//     (`x-deckhand-pod-token`), which the API server reviews (TokenReview): its service
//     account names the caller (SERVICE_ACCOUNTS, `orchestrator=deckhand:deckhand-listener`,
//     namespace:name). The broker's own service account needs `create` on `tokenreviews`
//     (the `system:auth-delegator` ClusterRole).
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { POD_TOKEN_HEADER } from "../lib/broker-client.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { SERVICES } from "../lib/services.mjs";

// The audience a pod's token for the broker carries: one projected for it alone, so a token
// the pod holds for another API (its default one) is never taken.
export const POD_TOKEN_AUDIENCE = "deckhand-broker";
export { POD_TOKEN_HEADER };

const ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

// SERVICE_ACCOUNTS → username (`system:serviceaccount:<namespace>:<name>`) → service.
export function accountCallers(text) {
  const accounts = new Map();
  for (const part of String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const match = /^([\w-]+)=([a-z0-9.-]+):([a-z0-9.-]+)$/.exec(part);
    if (!match || !SERVICES.includes(match[1])) {
      throw new Error(`SERVICE_ACCOUNTS: expected service=namespace:name, got ${part}`);
    }
    accounts.set(`system:serviceaccount:${match[2]}:${match[3]}`, match[1]);
  }
  return accounts;
}

// The API server's TokenReview, with the broker's own service account: → the token's
// username, or null when it isn't valid (or not for the broker's audience).
export function inClusterReview({ host, port, account = ACCOUNT, read = readFileSync } = {}) {
  return (token) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenReview",
        spec: { token, audiences: [POD_TOKEN_AUDIENCE] },
      });
      const req = request(
        {
          host,
          port,
          method: "POST",
          path: "/apis/authentication.k8s.io/v1/tokenreviews",
          ca: read(`${account}/ca.crt`),
          headers: {
            authorization: `Bearer ${read(`${account}/token`, "utf8").trim()}`,
            "content-type": "application/json",
          },
          timeout: 10_000,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (text += d));
          res.on("end", () => {
            if (res.statusCode !== 201 && res.statusCode !== 200) {
              return reject(new Error(`TokenReview: ${res.statusCode}`));
            }
            let status;
            try {
              ({ status } = JSON.parse(text));
            } catch {
              return reject(new Error("TokenReview: not JSON"));
            }
            const audience = status?.audiences?.includes(POD_TOKEN_AUDIENCE);
            resolve(status?.authenticated && audience ? status.user?.username : null);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("TokenReview: timed out")));
      req.on("error", reject);
      req.end(body);
    });
}

// → (req) → the calling service, or null. `networks`: SERVICE_NETWORKS; `accounts`:
// SERVICE_ACCOUNTS, with `review` (inClusterReview()'s).
export function createCallers({ networks, accounts, review }) {
  const byNetwork = networks ? networkCallers(networks) : null;
  const byAccount = accounts ? accountCallers(accounts) : null;
  if (!byNetwork && !byAccount) {
    throw new Error(
      "SERVICE_NETWORKS (Docker: service=subnet) or SERVICE_ACCOUNTS (Kubernetes: service=namespace:name) is needed: no other proof of a caller is taken",
    );
  }
  return {
    // What serviceGuard() checks the network of each call against: on Kubernetes,
    // NetworkPolicies do it.
    bound: byNetwork,
    async callerOf(req) {
      if (byNetwork) return byNetwork(req.socket.localAddress);
      const token = req.headers[POD_TOKEN_HEADER];
      if (typeof token !== "string" || !token) return null;
      const username = await review(token);
      return (username && byAccount.get(username)) ?? null;
    },
  };
}
