// The runner the operator picks (RUNNER, config.mjs): its sandboxes (runner), its images and
// volumes (images) and its short containers (jobs: a pod each on Kubernetes). config.mjs
// refuses an unknown name at start, and so does this, should one get past it.
import { readFileSync } from "node:fs";
import { ConfigError } from "../config.mjs";
import { docker as dockerCli } from "../docker.mjs";
import { createDockerRunner } from "./docker.mjs";
import { createDockerImages } from "./images.mjs";
import { createDockerJobs } from "./jobs.mjs";
import { createKubeApi, inClusterFetch, SERVICE_ACCOUNT } from "./kube-api.mjs";
import { createKubernetesImages } from "./kube-images.mjs";
import { createPullSecret } from "./kube-pull.mjs";
import { createKubernetesRunner } from "./kubernetes.mjs";

// `kubeApi`, `servicesApi`: the tests' (kube-api.mjs createKubeApi() with their fetch), the
// sandboxes' namespace's and the services' (by default the same).
export function createBackend({
  config,
  docker = dockerCli,
  kubeApi,
  servicesApi = kubeApi,
  inboxDir,
  // The broker service's copy of the runs' inboxes and files (inbox.mjs).
  mirror = null,
  log = () => {},
  readNamespace = () => readFileSync(`${SERVICE_ACCOUNT}/namespace`, "utf8").trim(),
  // namespace → the API in it, with the runner's ServiceAccount (the tests' own).
  makeApi = inClusterApis(),
}) {
  if (config.runner === "kubernetes") {
    const { api, services } = kubeApi
      ? { api: kubeApi, services: servicesApi }
      : inCluster(config, readNamespace, makeApi);
    const pullSecret = createPullSecret({ config, api, services });
    const images = createKubernetesImages({ config, api, services, pullSecret, log });
    return {
      runner: createKubernetesRunner({ config, api, services, pullSecret, inboxDir, mirror, log }),
      images,
      // A pod of its own for the one job that needs it, the Antigravity login's refresh
      // (kube-images.mjs runJob()): agents install their way and caches need no chown here.
      jobs: { run: images.runJob },
    };
  }
  if (config.runner !== "docker") {
    throw new Error(`RUNNER: expected docker or kubernetes, got ${config.runner}`);
  }
  return {
    runner: createDockerRunner({ config, docker, inboxDir, mirror, log }),
    images: createDockerImages({ config, docker }),
    jobs: createDockerJobs({ config, docker }),
  };
}

// The API with the runner's ServiceAccount, in the sandboxes' namespace (`api`) and the
// services' (`services`, the same object when they are one): a runner outside the cluster (or
// without a token, automountServiceAccountToken: false) stops at start, saying so.
function inCluster(config, readNamespace, makeApi) {
  try {
    const namespace = config.kubernetes.namespace || readNamespace();
    const api = makeApi(namespace);
    const other = config.kubernetes.servicesNamespace;
    const services = other && other !== namespace ? makeApi(other) : api;
    return { api, services };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new ConfigError(
      `RUNNER: kubernetes, but there is no ServiceAccount at ${SERVICE_ACCOUNT} (${error.path}): the runner runs in the cluster, with its ServiceAccount's token mounted (docs/setup.md, Kubernetes runner)`,
    );
  }
}

// makeApi()'s default: one fetch (the cluster's CA, read once) for every namespace's API.
function inClusterApis() {
  let fetch;
  return (namespace) => createKubeApi({ fetch: (fetch ??= inClusterFetch()), namespace });
}
