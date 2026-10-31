// The listener's port for the runner (#503): what it answers as the orchestrator it still is,
// until it moves out (#506), on the network it shares with the runner (compose.yaml), for:
//
//   POST /runs/:run/tokens              a run's first tokens, once its network or pod exists
//                                       (sandbox-spec.mjs tokenEnv(), which the broker service
//                                       signs): only for a run being started (`pendingTokens`),
//                                       with the claims the orchestrator decided, never the
//                                       runner's
//
// The repos' tarballs and blobs are the github service's now (../github/service.mjs, #502).
//
// Each route names its callers (ROUTES, serviceGuard()), whose service tokens come from the
// broker service and are checked with its keys.
import { createServer } from "node:http";
import { readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { serviceGuard } from "../lib/service-token.mjs";

export const ROUTES = {
  "POST /runs/:run/tokens": ["runner"],
};

const MAX_BODY = 64 * 1024;

// `keys`: the broker service's public keys ({ get(kid) }, broker-service.mjs serviceKeys());
// `bound`: lib/service-token.mjs networkCallers()'s; `pendingTokens`: run → tokens(sandbox) (../runner/client.mjs start()).
export function createServicesHttp({ keys, bound, pendingTokens, log = () => {}, now = Date.now }) {
  const guard = serviceGuard({ service: "orchestrator", keys, routes: ROUTES, bound, now });

  async function handle(req, res) {
    const url = new URL(req.url, "http://listener");
    const run = /^\/runs\/([^/]+)\/tokens$/.exec(url.pathname);
    if (run && req.method === "POST") {
      guard(req);
      const id = decodeURIComponent(run[1]);
      const tokens = pendingTokens.get(id);
      if (!tokens) throw new Refused(404, `${id} isn't being started`);
      const { sandbox } = await readJsonBody(req, MAX_BODY);
      if (!sandbox || typeof sandbox !== "string") throw new Refused(400, "sandbox?");
      return sendJson(res, { env: await tokens(sandbox) });
    }
    // Anything else, from any caller.
    guard(req);
    throw new Refused(404, "no such endpoint");
  }

  const server = createServer((req, res) =>
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof Refused) return sendJson(res, { message: error.message }, error.status);
      log(`Services port: ${req.method} ${req.url}: ${error.stack ?? error}`);
      sendJson(res, { message: "failed" }, 500);
    }),
  );
  return server;
}
