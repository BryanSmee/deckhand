// HTTP helpers every service shares: JSON answers, bodies read within a limit, and refusals
// that carry their status.

// API answers are per request and per user: never cached.
export function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

// sendJson() with the status first, as the routes read best.
export const send = (res, status, value) => sendJson(res, value, status);

// What readBody() reads and drops past its limit before it cuts the request.
const MAX_DRAINED = 1024 * 1024;

// The request's body as a Buffer. Past `limit` bytes the promise rejects with a 413 (Refused),
// nothing more held in memory: the rest is read and dropped, so that its client, done sending,
// reads the answer (one whose request is cut while it sends sees a reset instead). Past `drain`
// bytes more, or declared that large, the request is cut at once: its client may see a reset.
export function readBody(req, limit, { drain = MAX_DRAINED } = {}) {
  return new Promise((resolve, reject) => {
    const over = () => new Refused(413, `body over ${limit} bytes`);
    const cut = () => {
      req.destroy();
      reject(over());
    };
    if (Number(req.headers?.["content-length"]) > limit + drain) return cut();
    let chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else if (size > limit + drain) cut();
      else chunks = [];
    });
    req.on("end", () => (size > limit ? reject(over()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
    // Cut short without an error (a client gone): nothing more comes. A no-op after "end".
    req.on("close", () => reject(new Error("connection closed before the body's end")));
  });
}

// A refusal the dashboard shows as it is, with its status (apiRoute()).
export class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const refuse = (status, message) => {
  throw new Refused(status, message);
};

// The text as JSON; anything else is refused (400).
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    refuse(400, "Not JSON.");
  }
}

// The request's body as JSON. One over `limit` bytes is refused as it is (413), one that
// isn't JSON too (400).
export async function readJsonBody(req, limit) {
  let text;
  try {
    text = (await readBody(req, limit)).toString("utf8");
  } catch (error) {
    if (error.status === 413) refuse(413, `The request is over ${limit} bytes.`);
    throw error;
  }
  return parseJson(text);
}
