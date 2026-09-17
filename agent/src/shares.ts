/**
 * Shares and SMB users. The database holds the definitions; this file
 * turns them into /etc/samba/smb.conf and an exports file, whole, on every
 * change, and reloads the daemons. Nothing is edited in place, so what the
 * daemons run is always exactly what the database says. Generation is pure
 * (tests feed it rows); `apply` writes and reloads.
 */
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { Share, ShareSetArgs, SmbAccess, SmbUser } from '../../shared/types.ts';
import type { Db, StoredShare } from './db.ts';
import { BadArgs, datasetName } from './names.ts';
import { must, type Runner } from './run.ts';
import { listDatasets } from './zfs.ts';

export interface ShareConfig {
  smbConf: string;
  exportsFile: string;
  /** The group every SMB user joins; `valid users = @group`. */
  smbGroup: string;
  /** Files written over SMB or NFS belong to this uid/gid (the drive's container user), like files made in the browser. */
  ownerUid: number;
  ownerGid: number;
  hostname: string;
}

/** Samba's own rules for a user name, kept tight: what an email's local part looks like after lower-casing. */
export function smbUserName(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9._-]{0,31}$/.test(v) || v === 'root') throw new BadArgs('name: not an SMB user name');
  return v;
}

/** A host, a CIDR, a wildcard host, or * — the shapes exports(5) takes, with nothing that could be an option. */
export function nfsClient(v: unknown): string {
  if (typeof v !== 'string' || v === '' || !/^[A-Za-z0-9*][A-Za-z0-9.*:/-]{0,79}$/.test(v) || v.includes('('))
    throw new BadArgs(`nfsClients: "${String(v)}" is not a host, a network or *`);
  return v;
}

/** Section names smb.conf keeps for itself: a share called [global] would set every share's defaults. Samba compares them without case. */
const RESERVED = ['global', 'homes', 'printers'];

/** The SMB name of a dataset's share (its last component), refused when smb.conf would read it as something else. */
export function smbShareName(dataset: string): string {
  const name = dataset.split('/').pop()!;
  if (RESERVED.includes(name.toLowerCase())) throw new BadArgs(`${dataset}: Samba keeps the name "${name}" for itself; share a dataset with another name`);
  return name;
}

/** A share's SMB list as share.set takes it: known user names, one entry each, read or write. */
export function smbAccessOf(v: unknown): SmbAccess[] {
  if (!Array.isArray(v) || v.length > 200) throw new BadArgs('smbAccess must be a list of { user, level }');
  const seen = new Set<string>();
  return v.map((e) => {
    const { user, level } = (e ?? {}) as { user?: unknown; level?: unknown };
    const name = smbUserName(user);
    if (level !== 'read' && level !== 'write') throw new BadArgs(`smbAccess: ${name} needs level read or write`);
    if (seen.has(name)) throw new BadArgs(`smbAccess: ${name} is listed twice`);
    seen.add(name);
    return { user: name, level };
  });
}

export function smbConf(shares: Share[], cfg: ShareConfig, ownerName: string, ownerGroup: string): string {
  const out: string[] = [
    '# Written by mk-nasd from its database. Edits here are lost on the next change; use the drive.',
    '[global]',
    `   server string = ${cfg.hostname}`,
    '   workgroup = WORKGROUP',
    '   server role = standalone server',
    '   security = user',
    '   map to guest = never',
    '   passdb backend = tdbsam',
    '   log file = /var/log/samba/log.%m',
    '   max log size = 1000',
    '   logging = file',
    '   server min protocol = SMB2',
    '   smb encrypt = desired',
    '   load printers = no',
    '   printing = bsd',
    '   printcap name = /dev/null',
    '   disable spoolss = yes',
    '   vfs objects = catia fruit streams_xattr',
    '   fruit:metadata = stream',
    '   fruit:model = MacSamba',
    '   fruit:nfs_aces = no',
    '   fruit:veto_appledouble = no',
    '   fruit:wipe_intentionally_left_blank_rfork = yes',
    '   fruit:delete_empty_adfiles = yes',
    '   ea support = yes',
    '',
  ];
  for (const s of shares) {
    if (!s.smb || !s.mountpoint) continue;
    // who may open it: the share's own list (read only, writers on the write list), or, for a share from before lists, the
    // whole SMB group; a list with nobody on it leaves the share out, since an empty valid users would let everyone in
    let access: string[];
    if (s.smbAccess === null) access = ['   read only = no', `   valid users = @${cfg.smbGroup}`];
    else {
      if (s.smbAccess.length === 0) continue;
      const writers = s.smbAccess.filter((a) => a.level === 'write').map((a) => a.user);
      access = [
        '   read only = yes',
        `   valid users = ${s.smbAccess.map((a) => a.user).join(' ')}`,
        ...(writers.length ? [`   write list = ${writers.join(' ')}`] : []),
      ];
    }
    out.push(
      `[${s.name}]`,
      `   path = ${s.mountpoint}`,
      '   browseable = yes',
      ...access,
      `   force user = ${ownerName}`,
      `   force group = ${ownerGroup}`,
      '   create mask = 0664',
      '   directory mask = 0775',
      '   veto files = /.mk-drive/.zfs/',
      ...(s.timeMachine ? ['   fruit:time machine = yes'] : []),
      '',
    );
  }
  return out.join('\n');
}

export function exportsFile(shares: Share[], cfg: ShareConfig): string {
  const out: string[] = ['# Written by mk-nasd from its database. Edits here are lost on the next change; use the drive.'];
  for (const s of shares) {
    if (!s.nfs || !s.mountpoint) continue;
    // no fallback to "the private networks": a share names who may mount it. One stored before share.set asked for a list
    // is exported to nobody until someone adds hosts to it
    if (s.nfsClients.length === 0) {
      out.push(`# ${s.mountpoint}: NFS is on but no hosts or networks are allowed yet, so it is not exported`);
      continue;
    }
    out.push(
      `${s.mountpoint} ${s.nfsClients.map((c) => `${c}(rw,sync,no_subtree_check,all_squash,anonuid=${cfg.ownerUid},anongid=${cfg.ownerGid})`).join(' ')}`,
    );
  }
  return out.join('\n') + '\n';
}

/** Samba wants names, not numbers: the owner's user and group by id. */
async function ownerNamesOf(run: Runner, uid: number, gid: number): Promise<{ user: string; group: string }> {
  const user = (await must(run, ['getent', 'passwd', String(uid)])).split(':')[0]?.trim();
  if (!user) throw new Error(`no user with uid ${uid}`);
  const group = (await must(run, ['getent', 'group', String(gid)])).split(':')[0]?.trim();
  if (!group) throw new Error(`no group with gid ${gid}`);
  return { user, group };
}

async function writeAtomically(file: string, text: string): Promise<void> {
  const tmp = `${file}.mk-nas-tmp`;
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, file);
}

/** Every stored share with its current mountpoint from ZFS (a share whose dataset went away keeps a null mountpoint and is skipped in the configs). */
export async function listShares(run: Runner, db: Db): Promise<Share[]> {
  // rows can come from a restored database: a name or an NFS client that share.set would refuse never reaches smb.conf or
  // the exports (a client like *(rw,no_root_squash) would hand out root over NFS); such a share is left out and logged
  const names = new Set<string>();
  const stored = db.shares().filter((s) => {
    try {
      datasetName(s.dataset);
      s.nfsClients.forEach(nfsClient);
      if (s.smbAccess !== null) smbAccessOf(s.smbAccess);
      if (s.smb) {
        const name = smbShareName(s.dataset).toLowerCase();
        if (names.has(name)) throw new BadArgs(`another share is already called "${name}"`);
        names.add(name);
      }
      return true;
    } catch (e) {
      console.error(`share ${JSON.stringify(s.dataset)} skipped: ${(e as Error).message}`);
      return false;
    }
  });
  if (stored.length === 0) return [];
  const datasets = await listDatasets(run);
  return stored.map((s) => ({ ...s, mountpoint: datasets.find((d) => d.name === s.dataset)?.mountpoint ?? null }));
}

/** One at a time: two changes at once would otherwise write through the same temporary file, and the older list could land last. */
let applying: Promise<unknown> = Promise.resolve();

/** Regenerate both files from the database and reload; daemons come up when the first share of their kind appears. */
export function apply(run: Runner, db: Db, cfg: ShareConfig): Promise<Share[]> {
  const next = applying.then(() => applyNow(run, db, cfg));
  applying = next.catch(() => {});
  return next;
}

async function applyNow(run: Runner, db: Db, cfg: ShareConfig): Promise<Share[]> {
  const shares = await listShares(run, db);
  const owner = await ownerNamesOf(run, cfg.ownerUid, cfg.ownerGid);
  await writeAtomically(cfg.smbConf, smbConf(shares, cfg, owner.user, owner.group));
  await writeAtomically(cfg.exportsFile, exportsFile(shares, cfg));
  const anySmb = shares.some((s) => s.smb && s.mountpoint);
  const anyNfs = shares.some((s) => s.nfs && s.mountpoint && s.nfsClients.length);
  if (anySmb) {
    await must(run, ['systemctl', 'enable', '--now', 'smbd']);
    await must(run, ['smbcontrol', 'all', 'reload-config']);
  } else {
    await run(['systemctl', 'disable', '--now', 'smbd']);
  }
  if (anyNfs) {
    await must(run, ['systemctl', 'enable', '--now', 'nfs-server']);
    await must(run, ['exportfs', '-ra']);
  } else {
    await run(['exportfs', '-ra']);
    await run(['systemctl', 'disable', '--now', 'nfs-server']);
  }
  return shares;
}

/**
 * On the agent's start: both files as this version writes them, so a rule that changed in an upgrade (NFS with no hosts
 * exported to nobody) takes effect without waiting for someone to change a share. Nothing happens when the files are
 * already right, or while a shared dataset is not mounted (it would drop out of the files until the next change).
 */
export async function reapply(run: Runner, db: Db, cfg: ShareConfig): Promise<boolean> {
  const shares = await listShares(run, db);
  if (shares.length === 0 || shares.some((s) => !s.mountpoint)) return false;
  const owner = await ownerNamesOf(run, cfg.ownerUid, cfg.ownerGid);
  const current = async (file: string) => readFile(file, 'utf8').catch(() => null);
  if ((await current(cfg.smbConf)) === smbConf(shares, cfg, owner.user, owner.group) && (await current(cfg.exportsFile)) === exportsFile(shares, cfg))
    return false;
  await apply(run, db, cfg);
  return true;
}

export async function setShare(run: Runner, db: Db, cfg: ShareConfig, a: ShareSetArgs): Promise<Share> {
  const dataset = datasetName(a.dataset);
  const [d] = await listDatasets(run, dataset);
  if (!d || d.name !== dataset) throw new BadArgs(`${dataset}: no such dataset`);
  if (!d.mountpoint) throw new BadArgs(`${dataset}: not mounted, nothing to share`);
  const before = db.share(dataset);
  const bool = (v: unknown, fallback: boolean, what: string): boolean => {
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') throw new BadArgs(`${what} must be true or false`);
    return v;
  };
  const smb = bool(a.smb, before?.smb ?? false, 'smb');
  const nfs = bool(a.nfs, before?.nfs ?? false, 'nfs');
  const timeMachine = bool(a.timeMachine, before?.timeMachine ?? false, 'timeMachine') && smb;
  let nfsClients = before?.nfsClients ?? [];
  if (a.nfsClients !== undefined) {
    if (!Array.isArray(a.nfsClients)) throw new BadArgs('nfsClients must be a list');
    nfsClients = a.nfsClients.map(nfsClient);
  }
  // NFS has no accounts: the list is the whole access control, so it is never empty. A call that leaves NFS alone (only
  // SMB changes) does not trip over a share stored with an empty list before this rule; it stays exported to nobody
  if (nfs && nfsClients.length === 0 && (a.nfs !== undefined || a.nfsClients !== undefined))
    throw new BadArgs('name the hosts or networks allowed to mount it');
  const smbAccess = a.smbAccess === undefined ? (before?.smbAccess ?? null) : smbAccessOf(a.smbAccess);
  if (smb) {
    // the section name is the dataset's last component: never one of Samba's own, never the same as another share's
    const name = smbShareName(dataset).toLowerCase();
    const other = db.shares().find((s) => s.smb && s.dataset !== dataset && s.dataset.split('/').pop()!.toLowerCase() === name);
    if (other) throw new BadArgs(`${other.dataset} is already shared over SMB as "${other.dataset.split('/').pop()}"; two shares cannot have one name`);
  }
  if (!smb && !nfs) {
    db.removeShare(dataset);
    await apply(run, db, cfg);
    return {
      dataset,
      name: dataset.split('/').pop()!,
      mountpoint: d.mountpoint,
      smb,
      timeMachine,
      nfs,
      nfsClients,
      smbAccess,
      updatedAt: new Date().toISOString(),
    };
  }
  const stored: StoredShare = db.setShare({ dataset, smb, timeMachine, nfs, nfsClients, smbAccess });
  const shares = await apply(run, db, cfg);
  return shares.find((s) => s.dataset === dataset) ?? { ...stored, mountpoint: d.mountpoint };
}

export async function removeShare(run: Runner, db: Db, cfg: ShareConfig, dataset: unknown): Promise<{ removed: string }> {
  const name = datasetName(dataset);
  if (!db.removeShare(name)) throw new BadArgs(`${name}: not shared`);
  await apply(run, db, cfg);
  return { removed: name };
}

const COMMENT = 'mk-nas SMB user';

/**
 * Whether the Unix account is one mk-nas made (null: no such account). The account itself says so — our comment and
 * the SMB group as its primary group, as useradd below leaves it — because a row in smb_users does not: an older agent
 * added an existing account to the table as it was, and a restored database can name any account.
 */
async function ours(run: Runner, smbGroup: string, name: string): Promise<boolean | null> {
  const passwd = await run(['getent', 'passwd', name]);
  if (passwd.exitCode !== 0) return null;
  const f = passwd.stdout.trim().split(':');
  if (f[0] !== name || f[4] !== COMMENT) return false;
  const group = await run(['getent', 'group', smbGroup]);
  return group.exitCode === 0 && group.stdout.trim().split(':')[2] === f[3];
}

/** The Unix user Samba needs, without a shell or a home; the password comes separately. Never an account mk-nas did not make. */
export async function setUser(run: Runner, db: Db, cfg: ShareConfig, nameArg: unknown): Promise<SmbUser> {
  const name = smbUserName(nameArg);
  if ((await run(['getent', 'group', cfg.smbGroup])).exitCode !== 0) await must(run, ['groupadd', '--system', cfg.smbGroup]);
  const mine = await ours(run, cfg.smbGroup, name);
  if (mine === false) throw new BadArgs(`${name} is an existing system account; use another name`);
  if (mine === null)
    await must(run, ['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', '--gid', cfg.smbGroup, '--comment', COMMENT, name]);
  return db.setSmbUser(name, false);
}

export async function setSmbPassword(run: Runner, db: Db, cfg: ShareConfig, nameArg: unknown, password: unknown): Promise<SmbUser> {
  const name = smbUserName(nameArg);
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || password.includes('\n'))
    throw new BadArgs('password must be 8 to 128 characters');
  await setUser(run, db, cfg, name);
  // -a adds or updates, -s reads the password (twice) from stdin: it never touches argv
  await must(run, ['smbpasswd', '-a', '-s', name], { input: `${password}\n${password}\n` });
  await must(run, ['smbpasswd', '-e', name]);
  return db.setSmbUser(name, true);
}

export async function removeUser(run: Runner, db: Db, cfg: ShareConfig, nameArg: unknown): Promise<{ removed: string }> {
  const name = smbUserName(nameArg);
  const mine = await ours(run, cfg.smbGroup, name);
  // an account mk-nas did not make is never deleted; one an older agent put in the table only loses its Samba password and its row
  if (mine === false && !db.smbUser(name)) throw new BadArgs(`${name} is a system account mk-nas did not make; it is not removed`);
  await run(['smbpasswd', '-x', name]);
  if (mine) await must(run, ['userdel', name]);
  db.removeSmbUser(name);
  // a later account with the same name must not inherit this one's place on a share
  if (db.dropSmbUserFromShares(name)) await apply(run, db, cfg);
  return { removed: name };
}

/** The mountpoint's owner is who files belong to; used when the container's uid is not configured. */
export async function uidOf(path: string): Promise<{ uid: number; gid: number }> {
  const s = await stat(path);
  return { uid: s.uid, gid: s.gid };
}
