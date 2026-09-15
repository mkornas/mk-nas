# Updates from the box

A box finds new mk-nas releases on its own and installs one when a person
says so, from the Storage overview's System section or `mk-nas update`.
Nothing installs by itself, nothing comes from a branch, and nothing
downloaded is believed before the maintainer's signature checks out.

**The check.** The snapshot timer's tick asks GitHub once a day
(`/repos/mkornas/mk-nas/releases/latest`, then that release's
`release.json`); `update.check` asks now. What it found and when is kept
in the agent's database (`update_check`); a failed check keeps the last
release it knew and says why. A release is *available* when it is newer
than what runs and signed.

**The signature.** Releases are signed on the machine that cuts them, not
in CI: `make release` waits for the release workflow and runs
`install/sign-release.sh`, which signs `SHA256SUMS` with an ed25519 ssh key
(`ssh-keygen -Y sign`, namespace `mk-nas-release`) and uploads
`SHA256SUMS.sig`. Whoever controls the GitHub account can publish a
release, but cannot make a box install it. The public key is
`install/release-signers`, shipped in every package as
`/opt/mk-nas/install/release-signers`; `ssh-keygen` is on every Ubuntu, so
the box needs nothing new. `SHA256SUMS` lists the package and
`release.json`; the workflow writes the pinned drive image's checksum into
`release.json` (`driveImageSha256`, from mk-drive's own release), so the
one signature covers all three. Releases before 0.6.0 have no such
checksum and are never installed from the box.

**The install.** `update.install` takes the version the person saw, and
refuses anything but the newest checked release, newer than this one,
signed, with no other install running. It starts `src/update.ts` in a
transient unit of its own (the package restarts the agent), which writes
each step to `update_runs`:

1. download `SHA256SUMS`, `SHA256SUMS.sig`, `release.json` and the package
   into `/var/lib/mk-nas/updates/<version>`, only from the repository's own
   release download URLs;
2. verify the signature, then the package's and `release.json`'s checksums;
3. when the pinned drive image is not on the box, download
   `mk-drive-<drive>.tgz` from mk-drive's release, check it against
   `driveImageSha256`, and put it where `mk-drive.service` loads it from;
4. take the settings backup when one is set up (a failed backup stops the
   install);
5. `apt-get install` the package — the same postinst as by hand — and load
   a waiting image;
6. wait until the installed agent is the new version and running.

A run whose process is gone (the box went down mid-install) is marked
failed the next time anyone looks. The drive restarts during the install
when the pin changed; the System section says so and picks the run up again.

**Rotating the key.** `install/sign-release.sh --new-key` writes a new key
and `install/release-signers`. Boxes trust the key of the package they
run, so a release made with the new file must be signed with the old key
(or installed once with `install/upgrade.sh`) before the new key's
releases install from the box.
