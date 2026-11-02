// The registry's pull Secret on Kubernetes (KUBERNETES_REGISTRY_SECRET), a
// kubernetes.io/dockerconfigjson one: the runner's credentials to push and prune (read in the
// services' namespace, kube-images.mjs), and what pods pull with. A pod only pulls with a
// Secret of its own namespace: when sandboxes have one of their own, the runner keeps a copy
// there, under the same name, and its Role reads no other Secret of the services' namespace.
import { kubeName, labelValue } from "./kube-names.mjs";

// The Secret read again, and its copy checked, after this long.
const SECRET_TTL_MS = 60_000;

const KEY = ".dockerconfigjson";
// The copy's deckhand.role.
const ROLE = "registry";

// `api`: the sandboxes' namespace's; `services`: the services' (the same object, or the same
// namespace, when they are one).
export function createPullSecret({ config, api, services = api, now = Date.now }) {
  const wanted = config.kubernetes.registrySecret;
  const name = wanted ? kubeName(wanted) : null;
  const apart = services.namespace !== api.namespace;
  const owner = labelValue(config.prefix);
  let read = { at: -Infinity, data: null };
  let copied = { at: -Infinity, data: null };

  // Its docker config, base64 as the API gives it.
  async function data() {
    if (now() - read.at < SECRET_TTL_MS) return read.data;
    const found = await services.find(`secrets/${name}`);
    const value = found?.data?.[KEY];
    if (!value) {
      throw new Error(
        `KUBERNETES_REGISTRY_SECRET: no kubernetes.io/dockerconfigjson Secret ${wanted} in the namespace ${services.namespace}`,
      );
    }
    read = { at: now(), data: value };
    return value;
  }

  // The docker config, as text ("{}" without a Secret).
  async function text() {
    if (!name) return "{}";
    return Buffer.from(await data(), "base64").toString();
  }

  // Whether a Secret is the runner's copy: its labels, both.
  const ours = (secret) =>
    secret?.metadata?.labels?.["deckhand.owner"] === owner &&
    secret?.metadata?.labels?.["deckhand.role"] === ROLE;

  // The name for a pod's imagePullSecrets (null without one), its copy in the sandboxes'
  // namespace made, or brought up to date, first. One of that name there that isn't the
  // runner's copy is refused, whatever it holds: the runner neither overwrites nor uses what it
  // didn't make.
  async function forPods() {
    if (!name || !apart) return name;
    const value = await data();
    if (copied.data === value && now() - copied.at < SECRET_TTL_MS) return name;
    const body = (extra = {}) => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        labels: { "deckhand.owner": owner, "deckhand.role": ROLE },
        annotations: { "deckhand.copy-of": `${services.namespace}/${name}` },
        ...extra,
      },
      type: "kubernetes.io/dockerconfigjson",
      data: { [KEY]: value },
    });
    // Another start may make or update it meanwhile (the other copy of the runner, a run
    // starting beside this one, as the queue starts several): a 409 looks again, a few times.
    for (let tries = 0; tries < 3; tries++) {
      const copy = await api.find(`secrets/${name}`);
      try {
        if (!copy) {
          await api.create("secrets", body());
        } else if (!ours(copy)) {
          throw new Error(
            `the Secret ${name} in the namespace ${api.namespace} isn't the runner's copy of KUBERNETES_REGISTRY_SECRET (labelled deckhand.owner: ${owner} and deckhand.role: ${ROLE}): remove it, and the runner makes its own`,
          );
        } else if (copy.data?.[KEY] !== value) {
          await api.replace(
            `secrets/${name}`,
            body({ resourceVersion: copy.metadata.resourceVersion }),
          );
        }
      } catch (error) {
        if (error.status === 409) continue;
        throw error;
      }
      copied = { at: now(), data: value };
      return name;
    }
    throw new Error(
      `the Secret ${name} in the namespace ${api.namespace}, the runner's copy of KUBERNETES_REGISTRY_SECRET, kept changing while it was brought up to date: comment again to retry`,
    );
  }

  return { text, forPods };
}
