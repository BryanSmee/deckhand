# Cutting a release

A release is a `v*` tag on a commit of `main`, pushed by hand. The release workflow
(`.github/workflows/release-workflow.yml`) does the rest when the tag arrives: every image of its
matrix for `linux/amd64` and `linux/arm64`, tagged `1.2.3`, `1.2` and `latest` (the images drop
the tag's `v`), and the release itself, with the machine driver (`deckhand-machine.mjs`) and the `deckhand` command
(`deckhand.mjs`, from `cli/`) attached, each with its `VERSION` the tag's. Compose's default `DECKHAND_VERSION` is `latest`: the tag is what
a new install pulls.

1. **Ask Deckhand to prepare it**: open a `Release v0.x.0` issue in the release's milestone
   and comment `Deckhand /mode release`. This repository's
   [release mode](../../.deckhand/modes/release.md) uses Claude Opus, as its reviews do.
   It writes an evidence-backed checklist in the issue body, checks the milestone's
   acceptance criteria, docs, screenshots and demo scenario when flows changed, builds the
   docs, and checks CI on `main`. It files gaps as sub-issues, links dependencies where order
   matters, and puts maintainer decisions under `Open questions` (so the issue waits for input).
   It gathers release-specific upgrade steps and breaking `Runs in flight` cases from all
   merged pull requests since the previous release. Configuration and policy are read from
   `main`: the mode must be merged there before its first live trial. A maintainer can use
   `Deckhand /mode policy` on the prepare pull request to inspect the deployed policies;
   its samples are illustrative, not an exhaustive permission test.
2. **Review the draft prepare pull request**: `deploy/helm/deckhand/Chart.yaml`'s `appVersion` set to
   the release as its images are tagged (`1.2.3`), and its `version` bumped too; the release's
   notes in `.github/release-notes/v1.2.3.md` (what changed for operators, linking the
   [upgrade notes](../guides/upgrade-notes.md) they need). A checkout of the tag then installs
   that release's images with the chart's defaults. These are the draft's only two changed
   files; gaps are fixed separately. Both versions use the release's `X.Y.Z`. The mode
   leaves the pull request draft, even when checks pass. Resolve its checklist and questions,
   review the operator actions, then mark it ready and merge it yourself.
3. **The tag, on that pull request's merge commit**, once Checks passed on it:

   ```sh
   git fetch origin
   git tag -a v1.2.3 -m v1.2.3 <merge commit>
   git push origin v1.2.3
   ```

4. **What it published**, once the Release run is done: every image at both architectures, and
   `latest` on the same digest as the release.

   ```sh
   for image in edge orchestrator broker github runner egress models policy sandbox engine engine-podman; do
     docker buildx imagetools inspect "ghcr.io/bryansmee/deckhand-$image:1.2.3" --format '{{json .Manifest}}' |
       jq -r --arg i "$image" '[$i, .digest, ([.manifests[].platform | select(.os == "linux") | .architecture] | join(","))] | @tsv'
     docker buildx imagetools inspect "ghcr.io/bryansmee/deckhand-$image:latest" --format '{{json .Manifest}}' | jq -r .digest
   done
   gh release view v1.2.3 --json assets --jq '.assets[].name'   # deckhand-machine.mjs, deckhand.mjs
   ```

5. **The notes**: the workflow made the release with GitHub's generated notes; replace them with
   the pull request's: `gh release edit v1.2.3 --notes-file .github/release-notes/v1.2.3.md`.
6. **The demo**: upload the updated demo yourself when the release changed its on-screen flow,
   and record the link in the release checklist. Publishing stays with the maintainer.
