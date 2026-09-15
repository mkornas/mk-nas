# Answer the open questions

- 2026-09-12 15:53 — Target hardware (2026-09-12): a small-form-factor office PC is the kind of box to plan for: one M.2 2280 NVMe slot for the OS, 2-3 SATA ports, one or two 3.5/2.5in bays, low-profile PCIe, a small PSU. Proposed: pool = mirror of two disks (fits the ports and bays, matches the UI default); OS on the NVMe; spare small disks are for the phase-5 replace/resilver experiments (a 4-wide raidz1 would need an HBA). Q1+Q2 proposed, Q3 (the replication target) still open.
- 2026-09-12 18:18 — 2026-09-12: Q1 confirmed — OS on the NVMe, data on two SATA disks. Q2 confirmed — mirror of two disks is the UI default. Q3 (the replication target) still open.
- 2026-09-12 18:43 — 2026-09-12: docs/pool-layout.md written for Q1+Q2. Q3 (the replication target) is the only thing left on this card.
- 2026-09-12 21:04 — All three answered: Q1 OS on the NVMe, data on two SATA disks; Q2 mirror of two (docs/pool-layout.md); Q3 another ZFS host (TrueNAS, another mk-nas) is the replication target (docs/replication-target.md). — main @ 7215684 board: phase 3 done
