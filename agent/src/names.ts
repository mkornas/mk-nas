/**
 * Shapes a caller-supplied value must have before it can become an argv
 * element. Anything that does not match is refused; nothing here is ever
 * "escaped", because there is no shell to escape for.
 */

export class BadArgs extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** A pool name: letters, digits, '_' '-' ':' '.'; must start with a letter (the zpool rule). */
const COMPONENT = /^[A-Za-z][A-Za-z0-9_.:-]{0,254}$/;
/** A child dataset or snapshot component: may start with a digit; never with '-' or '.'. */
const CHILD = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;

export function poolName(v: unknown, what = 'pool'): string {
  if (typeof v !== 'string' || !COMPONENT.test(v) || v.includes('..')) throw new BadArgs(`${what}: not a pool name`);
  return v;
}

/** pool or pool/child/grandchild. */
export function datasetName(v: unknown, what = 'dataset'): string {
  if (typeof v !== 'string' || v.length > 255 || v.includes('@')) throw new BadArgs(`${what}: not a dataset name`);
  const [pool, ...rest] = v.split('/');
  if (!COMPONENT.test(pool) || !rest.every((p) => CHILD.test(p))) throw new BadArgs(`${what}: not a dataset name`);
  return v;
}

/** dataset@snap. */
export function snapshotName(v: unknown, what = 'snapshot'): string {
  if (typeof v !== 'string' || v.length > 255) throw new BadArgs(`${what}: not a snapshot name`);
  const at = v.indexOf('@');
  if (at < 1) throw new BadArgs(`${what}: not a snapshot name`);
  datasetName(v.slice(0, at), what);
  if (!CHILD.test(v.slice(at + 1))) throw new BadArgs(`${what}: not a snapshot name`);
  return v;
}

/** A by-id link name (not a path): what /dev/disk/by-id/ lists. */
export function diskId(v: unknown, what = 'disk'): string {
  if (typeof v !== 'string' || !CHILD.test(v)) throw new BadArgs(`${what}: not a disk id`);
  return v;
}

export function optional<T>(v: unknown, f: (v: unknown) => T): T | undefined {
  return v === undefined || v === null || v === '' ? undefined : f(v);
}

/** Refuses keys the verb did not declare, so a typo never silently does something else. */
export function only(args: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  const a = args ?? {};
  if (typeof a !== 'object' || Array.isArray(a)) throw new BadArgs('args must be an object');
  for (const k of Object.keys(a)) if (!keys.includes(k)) throw new BadArgs(`unexpected argument: ${k}`);
  return a;
}
