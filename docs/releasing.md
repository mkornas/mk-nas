# Releases and updates

A box runs a **named pair**: one mk-nas release and the one mk-drive
version it pins. Nothing on a box follows a branch, and nothing updates by
itself — an update is one command from a laptop.

## The pieces

| Where | What |
| --- | --- |
| `install/mk-drive/version` | The mk-drive version this repo pins, `X.Y.Z`. `deb.sh` stamps it into the stack file (`image: ghcr.io/mkornas/mk-drive:X.Y.Z`); the stick carries that image. |
| mk-drive `v*` tag | mk-drive's release workflow: `ghcr.io/mkornas/mk-drive:X.Y.Z` and a GitHub Release with `mk-drive-X.Y.Z.tgz` (the image) and `SHA256SUMS`. Never touches `:latest`, which follows mk-drive's main for its own server. |
| mk-nas `v*` tag | `.github/workflows/release.yml`: the agent's tests (the pool test as root), `make deb`, and a GitHub Release with `mk-nas_X.Y.Z_amd64.deb`, `release.json` (`{"agent","drive","contract"}`) and `SHA256SUMS`. |
| `install/release.sh X.Y.Z` | Cuts an mk-nas release (below). `make release VERSION=X.Y.Z`. |
| `install/upgrade.sh user@box [X.Y.Z]` | Puts a release on a box (below). `make upgrade HOST=user@box [VERSION=X.Y.Z]`. |

## Cutting a release

1. **If the drive changed**, release it first, in mk-drive:
   `tools/release.sh 0.2.1`, and wait for its workflow
   (`gh run watch`). Then write `0.2.1` into `install/mk-drive/version`
   here, commit, push.
2. **Release mk-nas** from a clean, pushed `main`:

   ```
   make release VERSION=0.4.1
   ```

   It refuses when the pinned drive has no release yet, or when that
   drive expects a newer verb contract (`NAS_CONTRACT` in mk-drive) than
   this agent speaks (`CONTRACT` in `agent/src/verbs.ts`). Then it writes
   the version into `agent/package.json`, commits `mk-nas 0.4.1 (pins
   mk-drive 0.2.1)`, tags `v0.4.1` and pushes. The workflow does the rest;
   `gh release view v0.4.1` shows the result.

Versions: the agent's minor goes up when verbs are added, the patch for
fixes; `CONTRACT` only when a verb changes shape (a drive built for the
new shape then asks for the upgrade).

## Updating a box

From a laptop with this repository and `gh` signed in (the box needs no
GitHub or registry login):

```
make upgrade HOST=nasadmin@nas.local                 # the newest release
make upgrade HOST=nasadmin@nas.local VERSION=0.4.2   # a given one; an older one rolls back
install/upgrade.sh -p 2222 nasadmin@localhost        # the test VM
```

It downloads the release's package and, when the box does not have it
yet, the pinned drive image; verifies both checksums; copies them over
ssh; and on the box — sudo asks for the password once — takes a settings
backup when one is set up, installs the package, brings the drive up on
the pinned image, and waits until `mk-nas version` and the drive's
`/api/meta` answer. The output ends with both versions.

The package's postinst does the box-side work, so a plain
`sudo apt install ./mk-nas_X.Y.Z_amd64.deb` on the box is the same update
by hand, as long as the pinned image is on the box (`docker load -i
mk-drive-X.Y.Z.tgz`) or the box can pull it (`docker login ghcr.io` once).

What an install changes and keeps, and the order that is safe, are in
`docs/upgrading.md`.

## A new stick

Build the ISO from the release tag, so the stick installs exactly that pair:

```
git checkout v0.4.2 && make iso && git checkout main
```

A release does not carry the ISO: at 4 GB it is over GitHub's asset limit.

## Later

Checking for a new release from the box itself, showing it on the Storage
pages with the release notes, and installing it from there (signed, never
from a branch) — the card "Updates from the box" on the board.
