// The listener's port for the runner (#503): what it answers as the orchestrator and the github
// service it still is, until they move out (#506, #502), on the network it shares with the
// runner (compose.yaml), for:
//
//   POST /runs/:run/tokens              a run's first tokens, once its network or pod exists
//                                       (sandbox-spec.mjs tokenEnv(), which the broker service
//                                       signs): only for a run being started (`pendingTokens`),
//                                       with the claims the orchestrator decided, never the
//                                       runner's
//   GET  /tarballs/:owner/:repo[/:ref]  a repo's files at a ref (its default branch without one),
//                                       GitHub's tarball streamed:
//                                       build contexts and preview hooks start from it, and the
//                                       runner holds no GitHub token
//   GET  /blobs/:owner/:repo?path&ref   a file's blob id (at `ref`, else its default branch),
//                                       which a repo image's tag hashes
//
// Each route names its callers (ROUTES, serviceGuard()), whose service tokens come from the
// broker service and are checked with its keys.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { repoAllowed } from "./config.mjs";
import { repoPath } from "./repo-config.mjs";

export const ROUTES = {
  "POST /runs/:run/tokens": ["runner"],
  "GET /tarballs/:owner/:repo": ["runner"],
  "GET /blobs/:owner/:repo": ["runner"],
  "GET /tarballs/:owner/:repo/:ref": ["runner"],
};

const MAX_BODY = 64 * 1024;

// What GitHub names a repository's owner and name, and a ref: decoded, nothing that would make
// the API path another one (`..`, `?`, a `/` in a name).
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const validName = (name) => NAME.test(name) && name !== "." && name !== "..";
const validRef = (ref) =>
  /^[A-Za-z0-9_./-]{1,250}$/.test(ref) &&
  ref.split("/").every((part) => part && part !== "." && part !== "..");

// `keys`: the broker service's public keys ({ get(kid) }, broker-service.mjs serviceKeys());
// `bound`: lib/service-token.mjs networkCallers()'s; `github(repo, method, path)`: the App's
// calls (github.mjs); `pendingTokens`: run → tokens(sandbox) (../runner/client.mjs start()).
export function createServicesHttp({
  config,
  keys,
  bound,
  github,
  pendingTokens,
  log = () => {},
  now = Date.now,
}) {
  const guard = serviceGuard({ service: "orchestrator", keys, routes: ROUTES, bound, now });
  // The github service's: a token for its own audience.
  const githubGuard = serviceGuard({ service: "github", keys, routes: ROUTES, bound, now });

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
    const tarball = /^\/tarballs\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (tarball && req.method === "GET") {
      githubGuard(req);
      let owner, name, ref;
      try {
        [owner, name, ref] = tarball.slice(1).map((part) => part && decodeURIComponent(part));
      } catch {
        throw new Refused(400, "not a repository");
      }
      if (!validName(owner) || !validName(name) || (ref !== undefined && !validRef(ref))) {
        throw new Refused(400, "not a repository and a ref");
      }
      const repo = `${owner}/${name}`;
      // The repos the operator lets through, as for a run.
      if (!repoAllowed(config, repo)) throw new Refused(403, `${repo} isn't allowed`);
      const path = `/repos/${repo}/tarball${ref === undefined ? "" : `/${encodeURIComponent(ref)}`}`;
      const answer = await github(repo, "GET", path);
      if (!answer.ok)
        throw new Refused(answer.status === 404 ? 404 : 502, `GitHub: ${answer.status}`);
      res.writeHead(200, { "content-type": "application/gzip" });
      return pipeline(Readable.fromWeb(answer.body), res);
    }
    const blob = /^\/blobs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (blob && req.method === "GET") {
      githubGuard(req);
      let owner, name;
      try {
        [owner, name] = blob.slice(1).map(decodeURIComponent);
      } catch {
        throw new Refused(400, "not a repository");
      }
      const path = url.searchParams.get("path") ?? "";
      const ref = url.searchParams.get("ref");
      if (
        !validName(owner) ||
        !validName(name) ||
        !repoPath(path) ||
        (ref !== null && !validRef(ref))
      ) {
        throw new Refused(400, "not a repository, a path and a ref");
      }
      const repo = `${owner}/${name}`;
      if (!repoAllowed(config, repo)) throw new Refused(403, `${repo} isn't allowed`);
      const where = `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
      const answer = await github(
        repo,
        "GET",
        ref === null ? where : `${where}?ref=${encodeURIComponent(ref)}`,
        null,
        [404],
      );
      if (answer.status === 404) throw new Refused(404, `no ${path} in ${repo}`);
      if (!answer.ok) throw new Refused(502, `GitHub: ${answer.status}`);
      const file = await answer.json();
      if (file?.type !== "file") throw new Refused(404, `${path} of ${repo} is not a file`);
      return sendJson(res, { sha: file.sha });
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
