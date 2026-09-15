# Reboot and shut down

The Storage overview's System section shows the pinned pair's versions
(mk-nas and mk-drive, with ZFS and smartctl), says when a restart is
needed, and offers Reboot and Shut down.

**A restart is needed** when `/run/reboot-required` exists: Ubuntu's
unattended upgrades write it after a new kernel or a core library, and list
the packages in `/run/reboot-required.pkgs`. The `power` verb reads both;
nothing is kept.

**What a restart interrupts** is read at the moment of asking, in the same
verb: a running scrub or resilver (from `zpool status`), a running
replication job (SQLite), a SMART self-test on a pool disk (`smartctl -n
standby`, so a sleeping disk stays asleep — it is not testing). The confirm
dialog lists them: scrubs, rebuilds and copies carry on after the restart,
a SMART test has to be started again. It is a warning, not a refusal.

**`system.reboot` and `system.shutdown`** take `confirm` = the box's
hostname, typed. The agent answers first and acts
five seconds later from a transient timer (`systemd-run --on-active=5
--unit=mk-nas-power systemctl reboot|poweroff`), so the reply reaches the
drive before the box goes and the action does not depend on the agent
staying up. While that timer is active a second request is refused. Both
verbs are audited like every call.

**Shut down from outside.** The drive tells the page whether the request
came through Cloudflare (`cf-connecting-ip`); the dialog then says plainly
that nobody can turn the box back on from there — it stays off until
someone presses its power button. There is no Wake-on-LAN.

**Not yet:** whether a newer release is out belongs to *Updates from the
box*.
