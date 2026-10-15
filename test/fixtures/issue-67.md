## Problem

#36 refuses a read-write mount when a sandbox could rewrite a directory between the granted root and the mounted path. Another sandbox with a read-write mount could otherwise swap a directory for a symlink between the last check and `docker run`.

`rewritableParent` (`listener/grants.mjs:142-157`) walks up only to `top`, the outermost root in **this repo's** grant (used around `:228-232`). Roots granted to other repos, and directories above the root, aren't checked.

Example:

- Repo A is granted `/nfs/work/api` read-write. Repo B is granted `/nfs/work` read-write, and `/nfs/work` is writable by uid 1000.
- A's check looks at nothing above `/nfs/work/api`, so it passes.
- B's sandbox keeps renaming `/nfs/work/api` and putting a symlink to `/` in its place.
- Sooner or later one of A's runs loses the race between `recheckMounts` and `docker run`, and gets host paths read-write.

A sandbox running as root (see the images sub-issue) widens this further.

## Proposal

Check every directory from `/` down to the mounted path's parent, not only from this repo's root. Alternatively, check every directory under any read-write root in the whole grants file. The first is simpler and also covers writable directories above any root.

## Acceptance criteria

- [ ] With a temp dir and an injected `stat`: a read-write mount under a directory that a sandbox can write through another repo's root is refused. Tested.
- [ ] Today's accepted layouts are still accepted. Tested.
- [ ] `docs/security.md` (Host mounts, "Between the check and the mount") matches.

## Open questions

None.
