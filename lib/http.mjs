// HTTP helpers every service shares: JSON answers, bodies read within a limit, and refusals
// that carry their status.

// API answers are per request and per user: never cached.
export function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

// sendJson() with the status first, as the routes read best.
export const send = (res, status, value) => sendJson(res, value, status);

// The request's body as a Buffer. Past `limit` bytes the request is dropped and the promise
// rejects: nothing larger is held in memory.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) return chunks.push(chunk);
      req.destroy();
      reject(new Error(`body over ${limit} bytes`));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
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
    if (/^body over/.test(error.message)) refuse(413, `The request is over ${limit} bytes.`);
    throw error;
  }
  return parseJson(text);
}
