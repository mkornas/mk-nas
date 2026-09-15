/**
 * Shares and SMB users. The database holds the definitions; this file
 * turns them into /etc/samba/smb.conf and an exports file, whole, on every
 * change, and reloads the daemons. Nothing is edited in place, so what the
 * daemons run is always exactly what the database says. Generation is pure
 * (tests feed it rows); `apply` writes and reloads.
 */
import { writeFile, rename, stat } from 'node:fs/promises';
import type { Share, ShareSetArgs, SmbUser } from '../../shared/types.ts';
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

export const DEFAULT_NFS_CLIENTS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

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
    out.push(
      `[${s.name}]`,
      `   path = ${s.mountpoint}`,
      '   browseable = yes',
      '   read only = no',
      `   valid users = @${cfg.smbGroup}`,
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
    const clients = s.nfsClients.length ? s.nfsClients : DEFAULT_NFS_CLIENTS;
    out.push(`${s.mountpoint} ${clients.map((c) => `${c}(rw,sync,no_subtree_check,all_squash,anonuid=${cfg.ownerUid},anongid=${cfg.ownerGid})`).join(' ')}`);
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
  const stored = db.shares().filter((s) => {
    try {
      datasetName(s.dataset);
      s.nfsClients.forEach(nfsClient);
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

/** Regenerate both files from the database and reload; daemons come up when the first share of their kind appears. */
export async function apply(run: Runner, db: Db, cfg: ShareConfig): Promise<Share[]> {
  const shares = await listShares(run, db);
  const owner = await ownerNamesOf(run, cfg.ownerUid, cfg.ownerGid);
  await writeAtomically(cfg.smbConf, smbConf(shares, cfg, owner.user, owner.group));
  await writeAtomically(cfg.exportsFile, exportsFile(shares, cfg));
  const anySmb = shares.some((s) => s.smb && s.mountpoint);
  const anyNfs = shares.some((s) => s.nfs && s.mountpoint);
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
  if (!smb && !nfs) {
    db.removeShare(dataset);
    await apply(run, db, cfg);
    return { dataset, name: dataset.split('/').pop()!, mountpoint: d.mountpoint, smb, timeMachine, nfs, nfsClients, updatedAt: new Date().toISOString() };
  }
  const stored: StoredShare = db.setShare({ dataset, smb, timeMachine, nfs, nfsClients });
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
  return { removed: name };
}

/** The mountpoint's owner is who files belong to; used when the container's uid is not configured. */
export async function uidOf(path: string): Promise<{ uid: number; gid: number }> {
  const s = await stat(path);
  return { uid: s.uid, gid: s.gid };
}
