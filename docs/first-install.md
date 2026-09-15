# Your first mk-nas, step by step

From a bare small PC to files on the network, in about an hour, most of it
waiting. Written for a small-form-factor PC with an M.2 slot and two drive
bays, and true for any PC with a spare SSD for the OS and two disks for
the data.

## What you need

- **The PC.** A 6th-gen Core i3 or better, 8 GB of RAM (16 GB is
  comfortable), wired Ethernet.
- **An OS disk.** A small NVMe in the M.2 slot, 128 GB or more. It holds
  Ubuntu and nothing else; the data never depends on it.
- **Two data disks** of the same size, one per bay. They become a mirror:
  the size of one, and either can die.
- **A USB stick**, 8 GB or more. Everything on it is erased.
- **A keyboard and a monitor** for the install only. After that the box
  runs headless and everything happens from a browser.

### Check the data disks first

Look up both model numbers (the label, or `lsblk -o NAME,MODEL,SIZE` on any
Linux). A disk that is **SMR** (shingled) works, but a big copy or a disk
replacement onto it can crawl for days. Most 2 TB 2.5-inch laptop disks are
SMR (Seagate ST2000LM015, WD WD20SPZX, Toshiba MQ04ABD200); among 3.5-inch
disks WD Red WD20EFAX is SMR, WD Red Plus, WD20EFRX and Seagate IronWolf are
not. An SMR disk is fine for a first try. Buy CMR when you buy.

Anything on the data disks will be erased when you make the pool, so copy
off what you want to keep.

## 1. Make the stick

On the computer with this repository, from the release you want to run
(the newest: `gh release view`):

```
git checkout v0.4.2 && make iso && git checkout main
```

That downloads Ubuntu Server 24.04 once (cached), checks it, and writes
`install/out/mk-nas-<date>.iso` with that release's mk-nas package and the
mk-drive image it pins — about 4 GB. It needs `xorriso`, `wget`, `fakeroot`, `dpkg-deb`
and Docker (for the drive image).

**Never use `install/out/mk-nas-vm.iso`.** That one is for the test VM: it
installs without asking, onto whatever disk carries the VM's serial, with a
known password.

Write the ISO to the stick **raw** (copying the file onto a formatted stick
does not boot):

- **Linux:** find the stick with `lsblk` (by its size), then
  `sudo dd if=install/out/mk-nas-<date>.iso of=/dev/sdX bs=4M status=progress oflag=sync`.
  Triple-check `sdX`: dd erases whatever you point it at.
- **macOS:** `diskutil list`, `diskutil unmountDisk /dev/diskN`, then
  `sudo dd if=mk-nas-<date>.iso of=/dev/rdiskN bs=4m`.
- **Windows:** balenaEtcher, or Rufus in "DD image" mode.

## 2. Prepare the PC

- Put the NVMe in the M.2 slot, a data disk in each bay, the RAM in.
- Enter the firmware setup (often **F10**, **F2** or **Del** at power-on).
  Make sure **SATA is in AHCI mode**, **USB boot is enabled**, and **UEFI
  boot** is on. Secure Boot can stay on: Ubuntu's ZFS module is signed.
- Plug in the Ethernet cable. The installer wants the network.

## 3. Install

1. Plug in the stick and power on. Open the boot menu (often **F9**, **F12**
   or **Esc**) and pick the USB stick (the UEFI entry).
2. The installer starts by itself after three seconds and asks exactly two
   things, in this order:
   - **Guided storage configuration: which disk is the OS disk.** Keep
     "Use an entire disk". The disk in brackets under it is where Ubuntu
     goes, and **the installer starts on the largest disk — usually a data
     disk, not the NVMe.** Move to the brackets with the arrow keys, press
     Enter, pick the **NVMe** by its size and model, and read the line
     again before you go on. Leave "Set up this disk as an
     LVM group" as it is, no encryption. **Done**, then **Done** on the
     summary (it lists only the NVMe), then **Continue** when it warns that
     the disk will be erased. Only that disk is touched.

     If you are unsure which is which, the safest way is to leave the data
     disks' cables unplugged for the install and connect them afterwards.
   - **Profile setup: who you are.** Your name, the box's name (it becomes
     `<name>.local` on the network — `nas` or something short), a username
     and a password. That login is for ssh and the box's own screen.
3. Wait 10–20 minutes. It installs Ubuntu, ZFS, Samba, NFS, Docker, the
   mk-nas agent and the mk-drive stack, then restarts.
4. Pull the stick out when the box restarts. If it boots the stick again,
   nothing happens without your answers — pull it and restart.

The first start after the install takes a few minutes longer: the drive's
image is loaded from what the stick left behind. The screen ends at a
`login:` prompt. You can unplug the keyboard and monitor now.

## After the install: the checklist

Everything from here happens from a laptop or phone on the same network.
The steps below explain each one; this is the order.

1. Pull the stick; wait for the `login:` prompt (a few extra minutes the
   first time). Keyboard and monitor can go.
2. Open `http://<name>.local:8810` and create the admin account (step 4).
3. **Storage → Overview → Set up this NAS**: the mirror, `tank/files` as a
   location, automatic snapshots (step 5).
4. Check that the overview is all green (step 10).
5. Optional: SMB for Finder, Explorer and phones, and your SMB password
   (step 7).
6. Create `tank/settings` and turn on the settings backup (step 8).
7. Reserve the box's address in the router (step 9).
8. From your laptop: `ssh-copy-id`, then `sudo mk-nas health` (step 10).
9. Optional: the drive from outside, in a browser and the iOS app
   (the section after step 10).

Then use it for two weeks and write down what is missing (the last section).

## 4. Open the drive

From any computer or phone on the same network, open

```
http://<the box's name>.local:8810
```

If `.local` names do not work on your network (some Android phones,
older routers), find the box's address in the router's list of devices, or
log in on the box's screen and run `hostname -I`. Then
`http://<address>:8810`.

The first visit asks you to **create the admin account**: your email, a
name, a password of at least 10 characters. That account runs the drive
and sees the **Storage** section.

## 5. Make the pool

**The short way: Storage → Overview → Set up this NAS.** On a box with no pool the
drive offers a set-up that does this step and the next in one flow: it picks the
two free data disks, makes them a mirror named `tank`, makes `tank/files` as a
location of the drive and gives it the automatic snapshots below. You type the
pool's name once. If you use it, skip to step 7. When it says **No free disk**
because the disks carry an old pool, wipe them on the Disks page first (step 1
below). The long way, page by page:

1. **Storage → Disks.** Both data disks should say **Free**. A disk that
   says "Carries ntfs" or similar has old partitions, and one that says
   **"old pool tank-old, not imported"** carries a ZFS pool from another system
   (an old TrueNAS pool, say): **Wipe**, and type its name to confirm. Its
   data is gone then; to keep it, import that pool from the Pools page
   instead. The NVMe says **Operating system**.
2. **Storage → Pools → New pool.** Name it (`tank` is the ZFS custom), pick
   **Mirror**, tick both data disks, type the name to confirm, **Create**.
   The disks are formatted; a few seconds later the pool is **ONLINE**.

Every pool is scrubbed monthly (a full read that finds and fixes silent
damage), and every disk gets a long SMART self-test monthly. Both are
automatic; the Pools page lets you change the scrub schedule.

## 6. Make a place for the files

**Storage → Datasets → New dataset.** For example:

- `tank/files` with **Offer it as a location of this drive** ticked — it
  appears in the drive's sidebar at once. Upload, browse, share links from
  there.
- `tank/photos`, the same way, if you want photos apart.

Then give each one **automatic snapshots** (the clock icon). A sensible
start: 24 hourly, 14 daily, 8 weekly, 6 monthly. A snapshot costs nothing
until files change (and none is taken while nothing changes), and brings back a deleted or overwritten file from
**Storage → Snapshots** (roll back) or from the file's versions in the drive.

## 7. Reach it from Finder, Explorer and phones (optional)

1. **Storage → Shares** (or the globe icon on a dataset): turn on **SMB**
   for the dataset. Tick **Time Machine** on a dataset meant for Mac
   backups. Under **Who can open it**, choose Read or Read and write per
   person; the list starts from what they may see of that folder in the
   drive, and nobody else can open the share.
2. **Settings → Account → Network access**: set your **SMB password**. Each
   person with a drive account sets their own.
3. Connect:
   - macOS Finder: Go → Connect to Server → `smb://<name>.local`
   - Windows Explorer: `\\<name>.local`
   - iPhone Files: Browse → ⋯ → Connect to Server → `smb://<name>.local`
   - Linux (Files, Déjà Dup backups): `smb://<name>.local/<share>` — the bare
     `smb://<name>/…` fails with "Invalid argument" unless your DNS knows the name

   Sign in with the user name the account page shows and the SMB password.

## 8. Keep the box's settings safe

The data is on the mirror; the box's settings — shares, schedules, SMB
passwords, the drive's accounts — are on the OS disk, which has no twin.

1. **Storage → Datasets → New dataset** `tank/settings`, **not** as a location.
2. **Storage → Copies → This box's settings**: pick `tank/settings`, then
   **Back up now**. From then on it runs daily by itself.

If the NVMe dies: put in a new one, install from the stick again, then
**Storage → Pools → Pools from elsewhere → Import**, then **Copies → This
box's settings → Restore**. The files were never at risk.

## 9. A fixed address (recommended)

Easiest and safest: in your **router**, reserve the box's current address
for it (often called "DHCP reservation" or "static lease"). Nothing on the
box changes.

Or set it on the box: **Storage → Network → Change** on the interface. The
change reverts by itself after two minutes unless you open the drive at the
new address and press **Keep**, so a typo cannot lock you out.

## 10. Check it, and set up your laptop

**On the Storage overview**, nothing should ask for you: the pool
**ONLINE**, every disk with a green shield, the day's ZFS events empty or
routine. A warning on a disk (pending sectors, or a slow scrub later on if
it is SMR) is worth writing down, not fixing today.

**From the computer with this repository**, once:

```
ssh-copy-id <user>@<name>.local            # updates and checks stop asking for the ssh password
ssh <user>@<name>.local sudo mk-nas health   # "OK — every pool online, every disk healthy"
ssh <user>@<name>.local sudo mk-nas version  # the agent's version; the drive's is at the foot of its sidebar
```

`sudo` on the box still asks for its password; that is on purpose.

**What now runs by itself**, with nothing to do: the automatic snapshots
and their pruning (a dataset nothing was written to since its last
snapshot gets no new one, so an idle pool is not written to every hour), a
monthly scrub of every pool, a monthly long SMART self-test of every disk
that supports one (started between 01:00 and 05:00, one disk at a time, a
sleeping disk is left asleep — a disk warm while nothing is copied is often
just running one: the Disks page says so), the daily settings backup, and
Ubuntu's security updates. mk-nas
and the drive never update themselves; see below.

## Reach the drive from outside (optional)

The box works like any NAS at home: SMB and NFS shares, ssh, all on the
local network. From anywhere else you reach **the drive** — in a browser
or in the mk-drive iOS app — and through it your files, share links and,
signed in as the admin, the Storage pages. Nothing else leaves the house.

A Cloudflare Tunnel does it without opening a port on the router. The
tunnel container is already part of the drive's stack and stays off until
it has a token:

1. In Cloudflare's Zero Trust dashboard: **Networks → Tunnels → Create a
   tunnel** (Cloudflared), name it after the box, and choose **Docker** as
   the environment. The page shows a `docker run … --token <token>`
   command: copy only the token, the long string after `--token`.
2. Still in the dashboard, give the tunnel a **public hostname**, for
   example `drive.example.com`, with service **HTTP** → `localhost:8810`.
   Only that. Never add SMB (445), NFS or ssh to a tunnel.
3. In the drive, **Storage → Network → Reach the drive from outside**: paste
   the token and save. The page shows the tunnel connecting, the public
   hostnames Cloudflare gives it, and the last error if it cannot connect.
   Do this from home: the page refuses to change the tunnel when it is
   opened through that tunnel. Or, on the box (`ssh <user>@<name>.local`),
   put the token in the stack's settings and restart the drive:

   ```
   sudo nano /opt/mk-drive/.env        # the line: CLOUDFLARE_TUNNEL_TOKEN=<token>
   sudo systemctl restart mk-drive
   sudo docker ps                      # mk-drive and mk-drive-tunnel, both Up
   ```

   The dashboard shows the connector as connected within seconds. If the
   tunnel container keeps restarting, `sudo docker logs mk-drive-tunnel`
   says why (usually a token copied incompletely).
4. Open `https://drive.example.com` and sign in with your drive account.
   In the iOS app, use the same address, email and password.

To switch it off, empty or delete that line and restart the drive again;
the tunnel container goes away. The token survives upgrades (the `.env`
is yours; the package never rewrites it), only root can read the file, and
the settings backup keeps a copy. **Turn off** on the Network page does the
same as emptying the line.

Nothing to change in the drive's settings: the password form is on by
default (leave `DRIVE_PASSWORD_LOGIN` as it is — `lan` would refuse sign-ins
from outside, the app's included). Uploads of any size work; the drive
sends them in pieces under Cloudflare's 100 MB request limit.

Worth knowing:

- **The admin account manages the NAS from anywhere**, so give it a long,
  unique password. **Settings → Devices** lists every signed-in session,
  **Settings → Activity** every sign-in.
- **The iOS app** signs in once with your password and then uses an app
  password made for that phone, revocable on its own. An app password
  reaches files only, never the Storage pages or account settings — manage
  the NAS from outside in the browser.
- **SMB from outside** does not go through a tunnel. If you want Finder or
  Files on SMB away from home, put Tailscale on the box and the device.
- **Updates** (`make upgrade`) keep working the same way, over ssh from
  the computer with this repository at home. The tunnel's image is pinned
  by the mk-nas release like the drive's, and updates with it.
- If an mk-drive with a tunnel already runs elsewhere (another server), give the
  NAS its own hostname, or move the existing hostname to the NAS once the
  files live there. The NAS's drive has its own accounts.

## Living with it

- **Health:** the Storage overview says when anything needs you — a disk
  failing, a pool degraded, a scrub that found errors — and shows what ZFS
  reported in the last day. With mk-dashboard running, the same problems
  arrive as alerts. That is optional: on a dashboard on another machine,
  put a long random token in the drive's settings and restart it
  (`sudo nano /opt/mk-drive/.env`, the line
  `DRIVE_NAS_MONITOR_TOKEN=<openssl rand -hex 32>`, then
  `sudo systemctl restart mk-drive`), and give the dashboard the drive's
  address and the same token (`DASH_NAS_URL`, `DASH_NAS_TOKEN`). The token
  reads health only and opens nothing else; without the line the route
  does not exist.
- **Ubuntu updates:** security updates install themselves. Once a month,
  or when the overview asks for it, over ssh:
  `sudo apt update && sudo apt upgrade`, then reboot if a new kernel came.
- **mk-nas and the drive:** they update together, as a release. From the
  computer with this repository: `make upgrade HOST=<user>@<name>.local`.
  It backs up the settings, installs the newest release and brings the
  drive up on the version that release was made with; it prints both
  versions when it is done. `VERSION=<older>` rolls back the same way
  (`docs/releasing.md`). The box never updates mk-nas or the drive by
  itself.
- **From a shell:** `ssh <user>@<name>.local`, then `sudo mk-nas health`,
  `sudo mk-nas pools`, `sudo mk-nas --help`. It completes with Tab.

## When something is off

| What you see | Look at |
| --- | --- |
| The drive does not open on port 8810 | Give the first start five minutes. Then on the box: `systemctl status mk-drive`, `sudo docker ps`, `journalctl -u mk-drive -n 50` |
| "The NAS agent did not answer" on a Storage page | `systemctl status mk-nasd`, `journalctl -u mk-nasd -n 50` |
| `docker compose pull` says denied | `sudo docker login ghcr.io` with a token that can read packages |
| A data disk is not listed | BIOS SATA mode (AHCI), the cable, `lsblk` on the box |
| A disk says **FAILING** or pending sectors | Storage → Disks → the disk → a long self-test; plan a replacement. Replace from the Pools page, next to the disk |
| Pool **DEGRADED** | The pool still works. Pools page: what ZFS says, and **Replace…** next to the missing disk |
| Forgot the drive's admin password | On the box: `sudo docker exec -it mk-drive node src/cli.ts password <email>` |
| Every call the agent made | `sudo tail -f /var/log/mk-nas/audit.jsonl` |

## The first two weeks

This is Phase 0 on the board: use it for real and write down what is
missing, awkward or surprising — a card on the board, or a line in
`notes/ideas.md`. That list decides what gets built next.
