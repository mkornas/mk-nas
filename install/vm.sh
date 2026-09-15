#!/usr/bin/env bash
# The NAS in a QEMU VM: UEFI, one 32 GB OS disk and three 8 GB data disks with
# serials, so /dev/disk/by-id has virtio-mknas-os and virtio-mknas-data-1..3 —
# the same shapes the real box has, plus a spare to replace into.
#
#   install/vm.sh install   boot the unattended ISO from install/out/mk-nas-vm.iso; the VM powers off when done
#   install/vm.sh boot      boot the installed disks (the OS disk goes first, so an installed VM never re-runs the ISO)
#   install/vm.sh clean     remove the VM
#
# Ports: http://localhost:8810 → mk-drive, ssh -p 2222 localhost.
# HEADLESS=1 runs without a window: the serial console on tcp 127.0.0.1:4445 (nc), logged to install/out/vm/serial.log,
# the QEMU monitor on 127.0.0.1:4444.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
vm=$here/out/vm
iso=$here/out/mk-nas-vm.iso
ovmf_code=/usr/share/OVMF/OVMF_CODE_4M.fd
ovmf_vars=/usr/share/OVMF/OVMF_VARS_4M.fd
cmd=${1:-boot}

case $cmd in
  clean) rm -rf "$vm"; echo "removed $vm"; exit 0 ;;
  install|boot) ;;
  *) echo "vm.sh: install | boot | clean" >&2; exit 2 ;;
esac
for t in qemu-system-x86_64 qemu-img; do command -v $t >/dev/null || { echo "vm.sh: needs $t (apt install qemu-system-x86 ovmf)" >&2; exit 1; }; done
[[ -r $ovmf_code ]] || { echo "vm.sh: needs $ovmf_code (apt install ovmf)" >&2; exit 1; }

mkdir -p "$vm"
if [[ $cmd == install ]]; then
  [[ -r $iso ]] || { echo "vm.sh: no $iso — run: make vm" >&2; exit 1; }
  rm -f "$vm"/*.qcow2 "$vm/vars.fd" "$vm/serial.log"
  qemu-img create -q -f qcow2 "$vm/os.qcow2" 32G
  qemu-img create -q -f qcow2 "$vm/data1.qcow2" 8G
  qemu-img create -q -f qcow2 "$vm/data2.qcow2" 8G
  qemu-img create -q -f qcow2 "$vm/data3.qcow2" 8G
  cp "$ovmf_vars" "$vm/vars.fd"
fi
[[ -r $vm/os.qcow2 ]] || { echo "vm.sh: no VM yet — run: make vm" >&2; exit 1; }
# the spare: a third data disk, so a member can be pulled and replaced
[[ -r $vm/data3.qcow2 ]] || qemu-img create -q -f qcow2 "$vm/data3.qcow2" 8G

args=(
  -name mk-nas-vm -machine q35,accel=kvm -cpu host -m 4G -smp 2
  -drive if=pflash,format=raw,readonly=on,file="$ovmf_code"
  -drive if=pflash,format=raw,file="$vm/vars.fd"
  -drive file="$vm/os.qcow2",if=none,id=os,format=qcow2 -device virtio-blk-pci,drive=os,serial=mknas-os,bootindex=0
  -drive file="$vm/data1.qcow2",if=none,id=d1,format=qcow2 -device virtio-blk-pci,drive=d1,serial=mknas-data-1
  -drive file="$vm/data2.qcow2",if=none,id=d2,format=qcow2 -device virtio-blk-pci,drive=d2,serial=mknas-data-2
  -drive file="$vm/data3.qcow2",if=none,id=d3,format=qcow2 -device virtio-blk-pci,drive=d3,serial=mknas-data-3
  -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:8810-:8810,hostfwd=tcp:127.0.0.1:2222-:22
  -rtc base=utc
)
[[ $cmd == install ]] && args+=(-drive file="$iso",media=cdrom,if=none,id=cd,format=raw,readonly=on -device ide-cd,drive=cd,bootindex=1)
if [[ ${HEADLESS:-0} == 1 ]]; then
  # headless: the QEMU monitor on a local port, so `echo screendump /tmp/x.ppm | nc 127.0.0.1 4444` shows what is on screen
  # the serial console is also a local TCP port (nc 127.0.0.1 4445 → login prompt) and still logs to serial.log
  args+=(-display none -chardev "socket,id=ser0,host=127.0.0.1,port=4445,server=on,wait=off,logfile=$vm/serial.log" -serial chardev:ser0 -monitor tcp:127.0.0.1:4444,server,nowait)
else
  args+=(-display gtk -serial "file:$vm/serial.log")
fi
exec qemu-system-x86_64 "${args[@]}"
