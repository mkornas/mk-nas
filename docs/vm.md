# The test VM

The fastest real box there is: Ubuntu Server with ZFS in QEMU, installed by
the same unattended ISO the stick uses, with one OS disk and three data
disks that carry by-id serials (`virtio-mknas-os`, `virtio-mknas-data-1..3`).
Everything that touches a verb, the installer or the package gets tried
here before it is trusted on the real NAS.

## Make it, boot it, remove it

```
make vm          # build the unattended ISO, install it, boot the result (~20 min the first time)
make vm-boot     # boot the installed disks again
HEADLESS=1 install/vm.sh boot   # the same without a window (serial console + monitor on local ports)
make vm-clean    # remove install/out/vm
```

`install/vm.sh install` returns when the VM powers itself off at the end of
the install; `boot` runs until the VM stops. The seed is
`install/autoinstall/user-data.vm`: identity and storage filled in, login
**nasadmin / mk-nas**, hostname `mk-nas-vm`. Never write that seed to a real
stick.

## Reaching it

| What | Where |
| --- | --- |
| mk-drive | http://localhost:8810 |
| ssh | `ssh -p 2222 nasadmin@localhost` (password `mk-nas`; the agent needs `sudo mk-nas …`) |
| serial console (headless) | `nc 127.0.0.1 4445`, logged to `install/out/vm/serial.log` |
| QEMU monitor (headless) | `nc 127.0.0.1 4444` (`screendump /tmp/x.ppm` shows the screen) |
| the host, from inside the VM | `10.0.2.2` (QEMU user networking) |

The drive's admin inside the VM is whoever was created on the first visit.
When nobody remembers the password:
`sudo docker exec -i mk-drive sh -c "echo <new> | node src/cli.ts password <email>"`.

## New code without a reinstall

The agent:

```
make deb
(cd install/out && python3 -m http.server 8000 --bind 127.0.0.1)   # on the host
curl -fsS -o /tmp/mk-nas.deb http://10.0.2.2:8000/mk-nas_<version>_amd64.deb   # in the VM
sudo apt-get install -y /tmp/mk-nas.deb
sudo mk-nas version
```

The same version number reinstalls too; bump `agent/package.json` for a
release so apt sees an upgrade and pulls new dependencies (avahi-daemon
arrived that way in 0.3.0).

The drive:

```
cd ../mk-drive && docker build -t mk-drive:vm --build-arg BUILD_SHA=$(git rev-parse --short HEAD) .
docker save mk-drive:vm | gzip -1 > ../mk-nas/install/out/mk-drive-vm.tgz
# in the VM:
curl -fsS -o /tmp/mk-drive-vm.tgz http://10.0.2.2:8000/mk-drive-vm.tgz
sudo docker load -i /tmp/mk-drive-vm.tgz
sudo sed -i 's|^DRIVE_IMAGE=.*|DRIVE_IMAGE=mk-drive:vm|' /opt/mk-drive/.env
sudo systemctl restart mk-drive
```

`curl http://localhost:8810/api/meta` shows the build sha it runs.

## Driving it from a script

`sshpass` is not on every dev box; the serial console is always there.
A small socket script does: send Ctrl-C (to abort whatever the console was
waiting on), wait for `login:` or a prompt, log in, `stty -echo`, set a
distinctive `PS1`, then send each command followed by `echo <marker>` and
read until the marker. Prefix `sudo` with `echo mk-nas | sudo -S -p ''` so
it never asks on the console, and strip the bracketed-paste escapes
(`\x1b[?2004h`, `\x1b[?2004l`) before matching. The VM's data disks are
virtio, so `smart` and the self-tests answer "smartctl gave no data" there;
everything else is real.

## In CI

`.github/workflows/vm.yml` runs the whole thing nightly on a self-hosted
runner labelled `kvm`: `make deb`, the unattended ISO, the install, a boot,
`/api/meta` saying `nas: true`, and `mk-nas version`, `disks` and `health`
over ssh. The runner needs qemu-system-x86, ovmf, xorriso, sshpass, curl,
node 24, and a writable `install/cache` (the Ubuntu ISO is fetched once).
