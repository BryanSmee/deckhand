// The runner the operator picks (RUNNER, config.mjs): its sandboxes (runner), its images and
// volumes (images) and its short containers (jobs). config.mjs refuses an unknown name at
// start, and so does this, should one get past it.
import { readFileSync } from "node:fs";
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
    const api =
      kubeApi ?? createKubeApi({ namespace: config.kubernetes.namespace || readNamespace() });
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
