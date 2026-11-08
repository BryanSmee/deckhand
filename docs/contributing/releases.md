# Cutting a release

A release is a `v*` tag on a commit of `main`, pushed by hand. The release workflow
(`.github/workflows/release-workflow.yml`) does the rest when the tag arrives: every image of its
matrix for `linux/amd64` and `linux/arm64`, tagged `1.2.3`, `1.2` and `latest` (the images drop
the tag's `v`), and the release itself, with the machine driver (`deckhand-machine.mjs`, its
`VERSION` the tag's) attached. Compose's default `DECKHAND_VERSION` is `latest`: the tag is what
a new install pulls.

1. **A pull request that prepares it**: `deploy/helm/deckhand/Chart.yaml`'s `appVersion` set to
   the release as its images are tagged (`1.2.3`), and its `version` bumped too; the release's
   notes in `.github/release-notes/v1.2.3.md` (what changed for operators, linking the
   [upgrade notes](../guides/upgrade-notes.md) they need). A checkout of the tag then installs
   that release's images with the chart's defaults.
2. **The tag, on that pull request's merge commit**, once Checks passed on it:

   ```sh
   git fetch origin
   git tag -a v1.2.3 -m v1.2.3 <merge commit>
   git push origin v1.2.3
   ```

3. **What it published**, once the Release run is done: every image at both architectures, and
   `latest` on the same digest as the release.

   ```sh
   for image in edge orchestrator broker github runner egress models policy sandbox engine engine-podman; do
     docker buildx imagetools inspect "ghcr.io/bryansmee/deckhand-$image:1.2.3" --format '{{json .Manifest}}' |
       jq -r --arg i "$image" '[$i, .digest, ([.manifests[].platform | select(.os == "linux") | .architecture] | join(","))] | @tsv'
     docker buildx imagetools inspect "ghcr.io/bryansmee/deckhand-$image:latest" --format '{{json .Manifest}}' | jq -r .digest
   done
   gh release view v1.2.3 --json assets --jq '.assets[].name'   # deckhand-machine.mjs
   ```

4. **The notes**: the workflow made the release with GitHub's generated notes; replace them with
   the pull request's: `gh release edit v1.2.3 --notes-file .github/release-notes/v1.2.3.md`.
