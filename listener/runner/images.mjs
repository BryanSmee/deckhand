// The Docker runner's images and volumes: what ../images.mjs asks of the backend to build a
// repo's image, prune its old tags and keep its cache volumes. The logic (tags, hashes,
// pruning, one build per tag) stays there; only the Docker calls are here. Results are
// docker()'s { code, out, err }.
import { join } from "node:path";
import { labelArgs, removeVolume, volumeExists } from "../docker.mjs";

export function createDockerImages({ config, docker }) {
  // The image's id, or null when there is no such image.
  async function id(ref) {
    const { code, out } = await docker(["image", "inspect", "--format", "{{.Id}}", ref]);
    return code === 0 ? out : null;
  }

  // The image's labels ({} without any), or null when there is no such image.
  async function labels(ref) {
    const { code, out } = await docker([
      "image",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      ref,
    ]);
    return code === 0 ? (JSON.parse(out || "null") ?? {}) : null;
  }

  // `dir`: the checkout, the build's context; `dockerfile` in it. `output`: the build's log.
  function build({ dir, dockerfile, tag, labels = {}, output }) {
    return docker(
      [
        "build",
        "--progress",
        "plain",
        // A Dockerfile names its base with `ARG DECKHAND_BASE` / `FROM $DECKHAND_BASE`, so
        // the operator's image name isn't written in every repo.
        "--build-arg",
        `DECKHAND_BASE=${config.image}`,
        ...labelArgs(labels),
        "-t",
        tag,
        "-f",
        join(dir, dockerfile),
        dir,
      ],
      { onData: output },
    );
  }

  // The tags of an image name, newest first, or null when Docker can't tell.
  async function tags(name) {
    const { code, out } = await docker(["image", "ls", "--format", "{{.Tag}}", name]);
    return code === 0 ? out.split("\n").filter((t) => t && t !== "<none>") : null;
  }

  // One that a container still uses refuses to go, and stays. → "deleted", "kept" (in use) or
  // "failed" (../../runner/metrics.mjs).
  async function remove(ref) {
    const { code, err = "" } = await docker(["image", "rm", ref]);
    if (code === 0) return "deleted";
    return /conflict|being used|is using/i.test(err) ? "kept" : "failed";
  }

  return {
    id,
    labels,
    build,
    tags,
    remove,
    volumeExists: (name) => volumeExists(docker, name),
    createVolume: (name, labels = {}) => docker(["volume", "create", ...labelArgs(labels), name]),
    removeVolume: (name) => removeVolume(docker, name),
  };
}
