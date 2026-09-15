# The box at a glance

mk-dashboard is the deep monitor; the `system` verb is the glance the
Storage overview shows in one row. `system.ts` reads `/proc/stat`,
`meminfo`, `loadavg`, `uptime`, `net/dev`, `diskstats` and
`/sys/class/hwmon` every 5 seconds (`MK_NAS_VITALS_EVERY`) — nothing run,
nothing on disk — and two reads make a sample: CPU percent across cores,
load, memory and swap, per-interface bytes per second, per-disk read and
write bytes per second and busy percent, hwmon temperatures. The history
keeps only the totals per sample (`SamplePoint`) for 30 minutes in memory,
so it starts over with the agent.

Interfaces are the physical-looking ones (not `lo`, `veth*`, `docker*`,
`br-*`, `virbr`, `tap`, `tun`); disks are whole disks by kernel name
(`sd*`, `nvme*n*`, `vd*`, `mmcblk*`), no partitions, loops or zvols. The
verb maps kernel names to by-id names and pools with lsblk and the by-id
links alone — never smartctl on a 5-second path, that wakes a sleeping
disk.

The overview shows tiles: CPU and load, memory and swap, network in and
out, disk read and write with the busiest pool, the hottest sensor and the
uptime, polled while the page is open. The history is there for sparklines;
none are drawn yet.
