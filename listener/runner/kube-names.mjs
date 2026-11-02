// Deckhand's names and values as Kubernetes takes them: what the runner (kubernetes.mjs), its
// images (kube-images.mjs) and the pull Secret's copy (kube-pull.mjs) all name their objects
// with, in a module of its own that imports none of theirs.
import { createHash } from "node:crypto";

const hash = (text) => createHash("sha256").update(text).digest("hex");

// An RFC 1123 subdomain: dot-separated labels of letters, digits and inner dashes.
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

// A sandbox, Secret or claim name as Kubernetes takes it (a DNS subdomain): Deckhand's names
// as they are when they are one, else made one (dots too become dashes: a repo named
// `.github` gives "-.github"), with a hash of the original so two never meet.
export function kubeName(name) {
  if (name.length <= 253 && SUBDOMAIN.test(name)) return name;
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 200)
    .replace(/^-+|-+$/g, "");
  return `${clean || "deckhand"}-${hash(name).slice(0, 10)}`;
}

// A label's value (63 characters at most, fewer kinds of them): as it is when it fits, else
// a hash. The value itself goes in an annotation beside it.
export function labelValue(value) {
  const text = String(value);
  return /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(text)
    ? text
    : hash(text).slice(0, 40);
}
