# *Security: drive image pulled by tag, unchecked** compose pulls ghcr.io/mkornas/mk-drive:X.Y.Z when missing (hand installs, pruned images, iso.sh docker pull): pull_policy never, verify the image id from the signed release before up, iso.sh uses the verified tgz

- 2026-09-15 16:08 — pull_policy never; load-image.sh loads only a tgz matching the pinned sha256 (VM: truncated file refused and removed, missing image → stack-up explains, real 0.7.0 tgz loaded); iso.sh uses the verified tgz — main @ f46e739 Security fixes, second batch from the 2026-09-15 audit
