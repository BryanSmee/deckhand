// What the broker keeps in the store that is a secret (the last run token it signed for a run,
// which a renewal asked again within a minute gets back): sealed with AES-256-GCM, under a key
// derived from its signing key, which only the broker's containers hold (docs/services.md,
// Rules: secrets never go in the store but encrypted). Every copy derives the same one.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export function createSeal(privateKey) {
  const secret = privateKey.export({ type: "pkcs8", format: "der" });
  const key = Buffer.from(hkdfSync("sha256", secret, "deckhand", "broker store seal", 32));
  return {
    seal(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
    },
    // The text, or null: sealed under another key (a new signing key), or not sealed at all.
    open(sealed) {
      try {
        const [iv, tag, data] = String(sealed)
          .split(".")
          .map((p) => Buffer.from(p, "base64url"));
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
