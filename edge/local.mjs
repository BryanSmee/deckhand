// /status without a session (#1019): a caller proves it is inside edge's container with a token
// only edge's volume gives, never by where it calls from. A reverse proxy on the host's network
// (or in edge's own network namespace) calls from loopback too, for anyone, and may add no
// forwarding header to say so. The token is derived from the session key, which whoever reads it
// could sign any session with already: nothing new to keep, the same on both copies, and a
// rotated key changes it too.
import { createHmac, timingSafeEqual } from "node:crypto";

export function localToken(key) {
  return createHmac("sha256", key).update("deckhand edge: local /status").digest("base64url");
}

// Whether the request's `Authorization: Bearer …` is `token`.
export function provesLocal(req, token) {
  const sent = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!sent || !token) return false;
  const [a, b] = [Buffer.from(sent), Buffer.from(token)];
  return a.length === b.length && timingSafeEqual(a, b);
}
