// The registry's pull Secret on Kubernetes (KUBERNETES_REGISTRY_SECRET), a
// kubernetes.io/dockerconfigjson one: the runner's credentials to push and prune (read in the
// services' namespace, kube-images.mjs), and what pods pull with. A pod only pulls with a
// Secret of its own namespace: when sandboxes have one of their own, the runner keeps a copy
// there, under the same name, and its Role reads no other Secret of the services' namespace.
import { kubeName, labelValue } from "./kubernetes.mjs";

// The Secret read again, and its copy checked, after this long.
const SECRET_TTL_MS = 60_000;

const KEY = ".dockerconfigjson";

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

  // The name for a pod's imagePullSecrets (null without one), its copy in the sandboxes'
  // namespace made, or brought up to date, first. One there that isn't the runner's copy is
  // left alone, and refused when it differs: the runner never overwrites what it didn't make.
  async function forPods() {
    if (!name || !apart) return name;
    const value = await data();
    if (copied.data === value && now() - copied.at < SECRET_TTL_MS) return name;
    const body = (extra = {}) => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        labels: { "deckhand.owner": owner, "deckhand.role": "registry" },
        annotations: { "deckhand.copy-of": `${services.namespace}/${name}` },
        ...extra,
      },
      type: "kubernetes.io/dockerconfigjson",
      data: { [KEY]: value },
    });
    const copy = await api.find(`secrets/${name}`);
    if (!copy) {
      await api.create("secrets", body()).catch((error) => {
        // Made meanwhile, by the other copy of the runner: checked at the next start.
        if (error.status !== 409) throw error;
      });
    } else if (copy.data?.[KEY] !== value) {
      if (copy.metadata?.labels?.["deckhand.owner"] !== owner) {
        throw new Error(
          `the Secret ${name} in the namespace ${api.namespace} isn't the runner's copy of KUBERNETES_REGISTRY_SECRET and differs from it: remove it, and the runner makes its own`,
        );
      }
      await api.replace(
        `secrets/${name}`,
        body({ resourceVersion: copy.metadata.resourceVersion }),
      );
    }
    copied = { at: now(), data: value };
    return name;
  }

  return { text, forPods };
}
