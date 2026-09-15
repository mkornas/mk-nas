# Decision: a mirror of two disks, the OS on its own SSD

Decided 2026-09-12: a mirror, as the default the UI offers.

- **The pool is a mirror of two disks.** Half the raw space, one disk of
  safety, the simplest resilver, and it fits a small-form-factor office PC
  with two or three SATA ports and two drive bays. raidz1 and raidz2 stay
  supported by `pool.create` for boxes with more ports; the UI's default is
  the mirror.
- **The OS lives on a separate small SSD** (an NVMe, say). The pool never
  depends on it: reinstall from the stick, `pool.import`, and the data is
  back.
- Disks are addressed by `/dev/disk/by-id`; a pool member is never touched
  by the installer, whose storage step only ever formats the disk picked as
  the OS disk.
- Spare small disks are for phase 5 (pull one, replace, watch the resilver),
  not for a wider raidz that would need an HBA the box cannot cool.
