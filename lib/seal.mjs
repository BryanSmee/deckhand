// What a service keeps in the store that is a secret, sealed with AES-256-GCM under a key only
// that service holds (docs/services.md, Rules: secrets never go in the store but encrypted): the
// broker's last run token (../broker/seal.mjs), the models service's plan logins
// (../models/logins.mjs). `secret`: the bytes the key is derived from; `info`: what it seals,
// so that one secret never gives two services the same key.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export function sealWith(secret, info) {
  const key = Buffer.from(hkdfSync("sha256", secret, "deckhand", info, 32));
  return {
    // In base64, not base64url: random bytes in base64url spell a GitHub token's shape now and
    // then (`ghs_` and 36 letters or digits, once in some 15,000 seals), which the store refuses
    // (../lib/store.mjs), and base64 has no `_`. Node reads either alphabet back (open()).
    seal(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
    },
    // The text, or null: sealed under another key, or not sealed at all.
    open(sealed) {
      try {
        const [iv, tag, data] = String(sealed)
          .split(".")
          .map((p) => Buffer.from(p, "base64"));
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
