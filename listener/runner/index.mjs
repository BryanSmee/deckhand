// The runner the operator picks (RUNNER, config.mjs): its sandboxes (runner), its images and
// volumes (images) and its short containers (jobs). config.mjs refuses an unknown name at
// start, and so does this, should one get past it.
import { readFileSync } from "node:fs";
import { ConfigError } from "../config.mjs";
import { docker as dockerCli } from "../docker.mjs";
import { createDockerRunner } from "./docker.mjs";
import { createDockerImages } from "./images.mjs";
import { createDockerJobs } from "./jobs.mjs";
import { createKubeApi, SERVICE_ACCOUNT } from "./kube-api.mjs";
import { createKubernetesImages, createKubernetesRunner } from "./kubernetes.mjs";

// `kubeApi`: the tests' (kube-api.mjs createKubeApi() with their fetch).
export function createBackend({
  config,
  docker = dockerCli,
  kubeApi,
  inboxDir,
  log = () => {},
  readNamespace = () => readFileSync(`${SERVICE_ACCOUNT}/namespace`, "utf8").trim(),
}) {
  if (config.runner === "kubernetes") {
    const api = kubeApi ?? inCluster(config, readNamespace);
    return {
      runner: createKubernetesRunner({ config, api, inboxDir, log }),
      images: createKubernetesImages({ config, api }),
      // No short containers: what needs them (an agent's install, a cache's chown, preview
      // hooks, the Antigravity login's refresh) says so.
      jobs: {},
    };
  }
  if (config.runner !== "docker") {
    throw new Error(`RUNNER: expected docker or kubernetes, got ${config.runner}`);
  }
  return {
    runner: createDockerRunner({ config, docker, inboxDir, log }),
    images: createDockerImages({ config, docker }),
    jobs: createDockerJobs({ config, docker }),
  };
}

// The API with the listener's ServiceAccount: a listener outside the cluster (or without a
// token, automountServiceAccountToken: false) stops at start, saying so.
function inCluster(config, readNamespace) {
  try {
    return createKubeApi({ namespace: config.kubernetes.namespace || readNamespace() });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new ConfigError(
      `RUNNER: kubernetes, but there is no ServiceAccount at ${SERVICE_ACCOUNT} (${error.path}): the listener runs in the cluster, with its ServiceAccount's token mounted (docs/setup.md, Kubernetes runner)`,
    );
  }
}
