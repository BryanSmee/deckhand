// The egress proxy's requests through its cache (proxy.mjs decides which go here, cache.mjs
// is the store): a GET answered from disk when fresh, revalidated when stale, else downloaded,
// streamed to the client and stored as it comes when it may be. No dependencies.
import { conditional, fits, isFresh, notModified, storable } from "./cache.mjs";

const VALIDATORS = ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since"];

// → cached(req, res, to, use), `use` being requestUse()'s ("use" or "revalidate"). `send`
// and `unreachable` are the proxy's: a request on to the host, and the answer when it fails.
export function createCachedPath({ cache, send, unreachable, now = Date.now }) {
  async function cached(req, res, to, use) {
    const key = cache.key(to.url.href, req.headers["accept-encoding"], req.headers.accept);
    let entry = await cache.get(key);
    // Kept for requests without the headers it varies on: one sending them goes on as is.
    if (entry && !fits(req, entry.meta.headers)) {
      await entry.file.close();
      return passThrough(req, res, to);
    }
    if (entry && use === "use" && isFresh(entry.meta, now()))
      return serve(req, res, key, entry, "hit");
    // A client checking its own copy, with nothing here to check it against: as before.
    if (!entry && conditional(req)) return passThrough(req, res, to);
    const upstream = send(to, "GET", revalidating(to.headers, entry), async (answer) => {
      if (entry && answer.statusCode === 304) {
        answer.resume();
        const meta = await cache.refresh(key, entry.meta, answer.headers);
        return serve(req, res, key, { ...entry, meta }, "revalidated");
      }
      await entry?.file.close();
      entry = null;
      download(req, res, key, to, answer);
    });
    upstream.on("error", async (error) => {
      await entry?.file.close();
      unreachable(res, to.host, error);
    });
    upstream.end();
  }

  // The client's validators replaced by the kept entry's, if any: a 304 is about our copy.
  function revalidating(requestHeaders, entry) {
    const headers = { ...requestHeaders };
    for (const name of VALIDATORS) delete headers[name];
    if (entry?.meta.headers.etag) headers["if-none-match"] = entry.meta.headers.etag;
    if (entry?.meta.headers["last-modified"]) {
      headers["if-modified-since"] = entry.meta.headers["last-modified"];
    }
    return headers;
  }

  // The host's answer to the client, and to disk as it comes when it may be kept.
  function download(req, res, key, to, answer) {
    const keep = storable(answer.statusCode, answer.headers, cache.limit, req);
    // What was kept is no longer what the host answers.
    if (!keep && cache.has(key)) cache.remove(key);
    const writer = keep
      ? cache.writer(key, { url: to.url.href, status: answer.statusCode, headers: answer.headers })
      : null;
    res.writeHead(answer.statusCode, { ...answer.headers, "x-deckhand-cache": "miss" });
    let ended = false;
    answer.on("data", (chunk) => writer?.write(chunk));
    answer.on("end", () => {
      ended = true;
      writer?.commit(answer.headers["content-length"]);
    });
    answer.on("error", () => writer?.abort());
    // A client gone mid-download: the rest isn't fetched, nothing is kept.
    res.on("close", () => {
      if (ended) return;
      writer?.abort();
      answer.destroy();
    });
    answer.pipe(res);
  }

  function passThrough(req, res, to) {
    const upstream = send(to, req.method, to.headers, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", (error) => unreachable(res, to.host, error));
    upstream.end();
  }

  // A kept answer, or a 304 when it matches the client's own validators.
  function serve(req, res, key, { meta, file }, how) {
    cache.touch(key, meta);
    const headers = { ...meta.headers, "x-deckhand-cache": how };
    if (notModified(req, meta.headers)) {
      file.close();
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(meta.status, { ...headers, "content-length": meta.size });
    const body = file.createReadStream();
    body.on("error", () => res.destroy());
    body.pipe(res);
  }

  return cached;
}
