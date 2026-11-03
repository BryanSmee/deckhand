// The runs' screenshots, served to anyone (GET /shots/<folder>/<file>, #609): passed on to the
// broker, which keeps them (../broker/files.mjs), with edge's service token. Public, like any
// image in a GitHub comment: the folder's random name is the only protection. The orchestrator
// stays out of it. The broker's answer streams through as it comes: a reader holds a part of
// the file at a time, here and at the broker, never all of it.
import { Readable } from "node:stream";
import { IMAGE_TYPES, SHOT_PATH } from "../lib/shots.mjs";

// The broker away for longer: a 503, the browser asks again.
const WAIT_MS = 5000;

// `client`: lib/service-client.mjs serviceClient()'s for the broker, with edge's token.
export function createShots({ client, log = () => {} }) {
  // A path that isn't a screenshot's name is a 404, never passed on.
  async function serve(req, res) {
    const match = SHOT_PATH.exec(req.url.split("?")[0]);
    if (!match) return res.writeHead(404).end();
    const [, folder, name, type] = match;
    // A reader gone: the broker's answer stops too.
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    let answer;
    try {
      answer = await client.request("GET", `/shots/${folder}/${name}`, {
        signal: gone.signal,
        waitMs: WAIT_MS,
      });
    } catch (error) {
      if (gone.signal.aborted) return;
      log(`The broker: a screenshot (${error.message})`);
      return res.writeHead(503, { "retry-after": "5" }).end();
    }
    if (answer.status !== 200) {
      await answer.body?.cancel().catch(() => {});
      if (answer.status === 404) return res.writeHead(404).end();
      log(`The broker: a screenshot, ${answer.status}`);
      return res.writeHead(502).end();
    }
    const length = answer.headers.get("content-length");
    res.writeHead(200, {
      "content-type": IMAGE_TYPES[type],
      ...(length !== null && { "content-length": length }),
      // As the orchestrator served them: a reply links to each one once.
      "cache-control": "public, max-age=31536000, immutable",
    });
    if (!answer.body) return res.end();
    // Cut short at the broker (gone meanwhile): cut short here too, never a whole-looking file.
    Readable.fromWeb(answer.body)
      .on("error", () => res.destroy())
      .pipe(res);
  }

  return { serve };
}
