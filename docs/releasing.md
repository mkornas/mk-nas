# Releases and updates

A box runs a **named pair**: one mk-nas release and the one mk-drive
version it pins. Nothing on a box follows a branch, and nothing updates by
itself — an update is the Install button on the box (0.6.0 and newer,
`docs/updates.md`) or one command from another machine.

## The pieces

| Where | What |
| --- | --- |
| `install/mk-drive/version` | The mk-drive version this repo pins, `X.Y.Z`. `deb.sh` stamps it into the stack file (`image: ghcr.io/mkornas/mk-drive:X.Y.Z`); the stick carries that image. |
| `install/mk-drive/sha256` | The sha256 of that version's `mk-drive-X.Y.Z.tgz`, as `sha256sum` writes it, checked on the maintainer's machine when the pin was set (`install/release.sh --drive`). The package carries it, every box loads only an image file that matches it, and the signed `release.json` names it. |
| mk-drive `v*` tag | mk-drive's release workflow: `ghcr.io/mkornas/mk-drive:X.Y.Z` and a GitHub Release with `mk-drive-X.Y.Z.tgz` (the image) and `SHA256SUMS`. Never touches `:latest`, which follows mk-drive's main for its own server. A box never pulls the image from the registry; it comes from the tgz. |
| mk-nas `v*` tag | `.github/workflows/release.yml`: the agent's tests (the pool test as root), `make deb`, and a GitHub Release with `mk-nas_X.Y.Z_amd64.deb`, `release.json` (`{"agent","drive","contract","driveImageSha256"}`) and `SHA256SUMS`. The workflow's `release.json` and `SHA256SUMS` stand in only until the release is signed, which replaces them. |
| `install/release.sh X.Y.Z` | Cuts an mk-nas release (below). `make release VERSION=X.Y.Z`. `install/release.sh --drive X.Y.Z` pins a drive. |
| `install/upgrade.sh user@box [X.Y.Z]` | Puts a release on a box (below). `make upgrade HOST=user@box [VERSION=X.Y.Z]`. |

## Cutting a release

1. **If the drive changed**, release it first, in mk-drive:
   `tools/release.sh 0.2.1`, and wait for its workflow
   (`gh run watch`). Then pin it here:

   ```
   install/release.sh --drive 0.2.1
   ```

   It downloads `mk-drive-0.2.1.tgz` from that release, checks it against
   the release's `SHA256SUMS`, loads it into docker and asks the image
   which drive version it carries (offline, and removed again), and writes
   `install/mk-drive/version` and `install/mk-drive/sha256`. Without docker
   it checks only the checksum and says so. Commit both files, push.
2. **Release mk-nas** from a clean, pushed `main`:

   ```
   make release VERSION=0.4.1
   ```

   It refuses when the pinned drive has no release yet, when that
   drive expects a newer verb contract (`NAS_CONTRACT` in mk-drive) than
   this agent speaks (`CONTRACT` in `agent/src/verbs.ts`), or when the
   drive's release now lists another checksum for its image than
   `install/mk-drive/sha256` (a pin with no `sha256` line yet is checked as
   in step 1 and goes into the release commit). Then it writes the version
   into `agent/package.json`, commits `mk-nas 0.4.1 (pins mk-drive 0.2.1)`,
   tags `v0.4.1` and pushes, waits for the workflow and signs (below);
   `gh release view v0.4.1` shows the result.

Versions: the agent's minor goes up when verbs are added, the patch for
fixes; `CONTRACT` only when a verb changes shape (a drive built for the
new shape then asks for the upgrade).

## Updating a box

On the box itself (0.6.0 and newer): Storage → Overview → System shows a
newer signed release with its notes and **Install**; `mk-nas update install
X.Y.Z` over ssh does the same. Rolling back to an older release is only
possible from another machine.

From another machine with this repository and `gh` signed in (the box
needs no GitHub or registry login):

```
make upgrade HOST=nasadmin@nas.local                 # the newest release
make upgrade HOST=nasadmin@nas.local VERSION=0.4.2   # a given one; an older one rolls back
install/upgrade.sh -p 2222 nasadmin@localhost        # the test VM
```

It downloads the release's package and, unless the box already runs the
very image it loaded from a checked file before, the pinned drive image;
verifies the signature and both checksums; copies them over ssh; and on
the box — sudo asks for the password once — takes a settings
backup when one is set up, installs the package, brings the drive up on
the pinned image, and waits until `mk-nas version` and the drive's
`/api/meta` answer. The output ends with both versions.

The package's postinst does the box-side work, so a plain
`sudo apt install ./mk-nas_X.Y.Z_amd64.deb` on the box is the same update
by hand, as long as the pinned image is on the box or waits for it: copy
`mk-drive-X.Y.Z.tgz` from mk-drive's release to
`/opt/mk-nas/mk-drive-image.tgz` first, and the drive loads it when it
starts, only when it matches the checksum the package carries. The box
never pulls the drive from a registry.

What an install changes and keeps, and the order that is safe, are in
`docs/upgrading.md`.

## A new stick

Build the ISO from the release tag, so the stick installs exactly that pair
(`iso.sh` checks Ubuntu's `SHA256SUMS` against Ubuntu's CD image key in
`install/keys/`, and puts `mk-drive-X.Y.Z.tgz` from mk-drive's release on
the stick after checking it against `install/mk-drive/sha256`):

```
git checkout v0.4.2 && make iso && git checkout main
```

A release does not carry the ISO: at 4 GB it is over GitHub's asset limit.

## Signing

A box installs only a signed release (`docs/updates.md`), and the signature
covers only what the maintainer's machine checked itself. `make release`
signs once the workflow has published: `install/sign-release.sh X.Y.Z`
with the key at `~/.config/mk-nas/release-signing-key` (or
`MK_NAS_SIGNING_KEY`), and refuses to start without it. The script:

1. requires the tag `vX.Y.Z` on GitHub to be the commit it is here;
2. builds the package from that tag in a temporary worktree (`deb.sh` with
   the Node tarball pinned there);
3. downloads CI's package and requires it to be the same: byte-identical
   when this machine's `dpkg-deb` and `xz` match the runner's (Ubuntu
   24.04; `deb.sh` clamps the archive's mtimes to the commit's time), and
   otherwise the same files — every member's content, mode, owner and link
   target, mtimes ignored. Anything else stops it;
4. writes `release.json` from the tag (the agent's version,
   `install/mk-drive/version`, `CONTRACT`, and `install/mk-drive/sha256` as
   `driveImageSha256`) and `SHA256SUMS` over CI's package and that file;
5. signs `SHA256SUMS`, checks the signature against
   `install/release-signers`, and uploads `release.json`, `SHA256SUMS` and
   `SHA256SUMS.sig` over the workflow's.

It needs `gh`, `git`, `python3`, `dpkg-deb`, `fakeroot` and `curl`. A tag
whose `deb.sh` does not yet clamp mtimes and strip group write (before
0.8.1) cannot be signed this way.

Back the key up; losing it means a new one (`install/sign-release.sh
--new-key`) and one more release signed the old way. When the workflow
outlives the wait, sign by hand afterwards with the same script.
`install/upgrade.sh` checks the signature too and refuses an unsigned
release; `--unsigned` installs one after you type `unsigned`, for the time
between the workflow and the signature.

## CI

The workflows check out without keeping the token (`persist-credentials:
false`), pin every action by commit (the tag in a comment; update both
together), and read the repository only, except `release.yml`'s `publish`
job, which creates the release from the `build` job's files and runs
nothing from the checkout. `vm.yml` runs only on `main`, on a self-hosted
runner that must be its own user without the signing key or `gh`
credentials.
