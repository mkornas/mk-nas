# *The stick carries the mk-drive image** make iso saves ghcr.io/mkornas/mk-drive (or DRIVE_IMAGE) with docker save into /mk-nas/mk-drive-image.tgz; install.sh copies it, mk-drive.service loads it before the first compose up; the image stays private on ghcr and updates need docker login on the NAS

- 2026-09-12 19:35 — Done: iso.sh saves the image (137 MB gz) into /mk-nas/install, install.sh copies it, load-image.sh runs from mk-drive.service ExecStartPre. Verified the file lands on the test ISO; a full reinstall was not rerun. — main @ ce2a7f5 The stick carries the mk-drive image
