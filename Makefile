# make deb   — the package (install/out/mk-nas_<version>_amd64.deb)
# make iso   — the bootable stick (install/out/mk-nas-<date>.iso)
# make vm    — install that ISO unattended into a QEMU VM with an OS disk and two data disks
# make vm-boot — boot the installed VM again; make vm-clean removes it
# make release VERSION=X.Y.Z — tag a release (install/release.sh); make upgrade HOST=user@box [VERSION=X.Y.Z] — put one on a box
.PHONY: deb iso vm vm-boot vm-clean test release upgrade
deb:
	install/deb.sh
iso:
	install/iso.sh
vm:
	install/iso.sh --unattended install/autoinstall/user-data.vm --out install/out/mk-nas-vm.iso
	install/vm.sh install
	install/vm.sh boot
vm-boot:
	install/vm.sh boot
vm-clean:
	install/vm.sh clean
test:
	cd agent && npm test
release:
	install/release.sh $(VERSION)
upgrade:
	install/upgrade.sh $(HOST) $(VERSION)
