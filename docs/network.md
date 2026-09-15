# The box's name and address

`network` reads `ip -j addr` (physical-looking interfaces only: no
loopback, no veth/docker/bridge plumbing), `ip -j route show default`,
`/run/systemd/resolve/resolv.conf`, the link speed from sysfs, whether
avahi runs, and what the agent's own netplan file says per interface.

**Hostname**: `hostnamectl set-hostname`, the `127.0.1.1` line in
`/etc/hosts` renamed (nothing else in that file is touched), then
`systemctl try-restart avahi-daemon` so `<hostname>.local` answers the new
name. avahi-daemon is a dependency of the package and in the installer's
package list. Takes effect at once; no revert needed, it cannot lock anyone
out.

**Address**: one netplan file of our own, `/etc/netplan/90-mk-nas.yaml`
(mode 0600, netplan insists), so it wins over the installer's
`50-cloud-init.yaml` for the interfaces it names and leaves the rest alone.
It is a fixed shape the agent renders and parses itself — `dhcp4: true`, or
`dhcp4: false` + `addresses` + a default route + `nameservers` — so no YAML
library is needed. Applied with `netplan generate` (validation) then
`netplan apply`.

**The revert.** An address change is the one thing that can lock the person
out of the box they are changing it on. `netplan try` was not used: its
behaviour on stdin without a terminal is uncertain. Instead the agent keeps
the previous file content (or the fact that there was none) next to an
expiry in `/var/lib/mk-nas/netplan-pending.json` — 120 s by default,
`revertAfter` 15..3600 — and unless `network.confirm` arrives in time the
old file goes back and netplan applies again. The check runs whenever the
network is read, when the agent starts (so a restart in between does not
lose it), and on the timer's tick as a backstop. A file netplan refuses is
put back at once with netplan's reason as the error. A second change while
one is pending is refused.

Refusals before anything runs: bad interface or host names, an address
without a prefix, a gateway off the subnet, more than three DNS servers,
an unknown interface.

The drive's Storage → Network page confirms first, then shows the new URL
and the `.local` one with a countdown; Keep from wherever the page is open
calls `network.confirm`. The CLI: `mk-nas network`, `network hostname
<name>`, `network set <iface> --dhcp | --address a.b.c.d/nn [--gateway g]
[--dns a,b] [--revert 120]`, `network keep` — with a warning that an ssh
session on that interface will drop. Verified in the VM: a DHCP re-apply
lost the address for a moment while DHCP re-ran and had it back within
seconds; the timed revert removed the file and the address came back; the
keep path left it.
