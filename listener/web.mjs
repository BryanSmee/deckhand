// Small HTTP helpers shared by the listener's routes (http.mjs, repos.mjs, broker.mjs,
// setup.mjs).

// API answers are per request and per user: never cached.
export function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

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
  });
}
