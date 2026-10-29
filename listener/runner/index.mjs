// The runner the operator picks (RUNNER, config.mjs): its sandboxes (runner), its images and
// volumes (images) and its short containers (jobs). Docker is the only one so far; config.mjs
// refuses another name at start, and so does this, should one get past it.
import { docker as dockerCli } from "../docker.mjs";
import { createDockerRunner } from "./docker.mjs";
import { createDockerImages } from "./images.mjs";
import { createDockerJobs } from "./jobs.mjs";

export function createBackend({ config, docker = dockerCli, inboxDir, log = () => {} }) {
  if (config.runner !== "docker") {
    throw new Error(`RUNNER: expected docker, got ${config.runner}`);
  }
  return {
    runner: createDockerRunner({ config, docker, inboxDir, log }),
    images: createDockerImages({ config, docker }),
    jobs: createDockerJobs({ config, docker }),
  };
}
