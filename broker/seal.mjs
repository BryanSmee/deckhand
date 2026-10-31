// What the broker keeps in the store that is a secret (the last run token it signed for a run,
// which a renewal asked again within a minute gets back): sealed with AES-256-GCM, under a key
// derived from its signing key, which only the broker's containers hold (../lib/seal.mjs).
// Every copy derives the same one.
import { sealWith } from "../lib/seal.mjs";

export function createSeal(privateKey) {
  return sealWith(privateKey.export({ type: "pkcs8", format: "der" }), "broker store seal");
}
