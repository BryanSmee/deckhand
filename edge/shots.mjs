// The runs' screenshots, served to anyone (GET /shots/<folder>/<file>, #609): passed on to the
// broker, which keeps them (../broker/files.mjs), with edge's service token. Public, like any
// image in a GitHub comment: the folder's random name is the only protection. The orchestrator
// stays out of it.
import { IMAGE_TYPES, SHOT_PATH } from "../lib/shots.mjs";

// `caller`: lib/broker-client.mjs createBrokerCaller()'s, with the broker's audience.
export function createShots({ caller, log = () => {} }) {
  // A path that isn't a screenshot's name is a 404, never passed on.
  async function serve(req, res) {
    const match = SHOT_PATH.exec(req.url.split("?")[0]);
    if (!match) return res.writeHead(404).end();
    const [, folder, name, type] = match;
    let answer;
    try {
      answer = await caller.call("GET", `/shots/${folder}/${name}`);
    } catch (error) {
      log(`The broker: a screenshot (${error.message})`);
      return res.writeHead(503, { "retry-after": "5" }).end();
    }
    if (answer.status === 404) return res.writeHead(404).end();
    if (answer.status !== 200) {
      log(`The broker: a screenshot, ${answer.status}`);
      return res.writeHead(502).end();
    }
    res.writeHead(200, {
      "content-type": IMAGE_TYPES[type],
      // As the orchestrator served them: a reply links to each one once.
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(answer.body);
  }

  return { serve };
}
