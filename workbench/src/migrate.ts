/** Moving an existing shared workspace into the owner's slot, once.
 *
 * Before slots there was one `/workspace`, owned by uid 1000, holding whatever
 * the owner's commands had written. After slots, no slot user can write any of
 * that: they would open their workspace and find every file read-only, which
 * reads as data loss even though nothing is lost.
 *
 * So the first time a slot is ever assigned on a volume, the supervisor moves
 * what is there into that slot and hands it to that uid. It runs as root — the
 * only moment root ownership is used for anything — and it is idempotent: a
 * marker file is written, and every later call does nothing.
 *
 * **Why the first slot is the owner's.** Reaching the workbench at all requires
 * `entitlements.execution`, which is owner-only (`lib/billing/entitlements.ts`).
 * So on a deployment that predates slots, the first account ever to be assigned
 * one is the operator, and these are their files. If execution is ever opened
 * beyond the owner, this must become an explicit owner key instead — the
 * assumption is load-bearing and is asserted in `migrate.test.mjs`.
 *
 * Deliberately conservative. It moves top-level entries and it never deletes:
 * if anything fails, the files are still where they were and the next boot will
 * try again.
 */
import {
  chmodSync,
  lchownSync,
  lstatSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SLOTS_DIR, SLOTS_FILE, type Slot } from './slots.ts';

/** Written once the volume has been migrated. Its own file rather than the slot
 * assignment: the assignment is written when the slot is created, which is
 * before this runs, so it could never be the marker. */
export const MIGRATED_FILE = '.migrated';

/** What a migration did, so the caller can log one line rather than guess. */
export type Migration = { moved: string[]; slot: string } | null;

export type MigrateFs = {
  list(path: string): string[];
  /** Take an entry over so that it can be moved at all. See the call site. */
  claim(path: string): void;
  move(from: string, to: string): void;
  chownRecursive(path: string, uid: number, gid: number): void;
  exists(path: string): boolean;
  writeMarker(path: string): void;
};

/** Entries that are the slot machinery itself, not somebody's work. */
const NEVER_MOVED = new Set([SLOTS_DIR, SLOTS_FILE, MIGRATED_FILE, 'lost+found']);

/**
 * Move a pre-slots workspace into `slot`, if there is one to move.
 *
 * Returns null when there is nothing to do — an empty volume, or a volume that
 * has already been migrated — which is the common case on every boot after the
 * first.
 */
export function migrateSharedWorkspace(workspace: string, slot: Slot, fs: MigrateFs): Migration {
  // Its presence means this volume has been through here before, so whatever is
  // at the top of it was put there deliberately afterwards and is not ours.
  if (fs.exists(join(workspace, MIGRATED_FILE))) return null;

  const entries = fs.list(workspace).filter((name) => !NEVER_MOVED.has(name));
  if (!entries.length) {
    // Nothing to move, but still mark it: a volume that starts empty must not
    // be re-examined every time a slot is assigned.
    fs.writeMarker(join(workspace, MIGRATED_FILE));
    return null;
  }

  const moved: string[] = [];
  for (const name of entries) {
    // Claim first, and per entry rather than all of them up front, so a failure
    // partway through leaves the rest untouched instead of half re-owned.
    //
    // Renaming a *directory* rewrites its `..`, so the kernel demands write
    // permission on the directory being moved — not only on the two parents.
    // Everything here belongs to uid 1000 and the supervisor holds no
    // DAC_OVERRIDE, so without this every directory is EACCES while loose files
    // move fine: the workspace arrives in the slot with its files and none of
    // its folders, which is the worst possible half-migration.
    fs.claim(join(workspace, name));
    // rename, not copy: it is the same filesystem, so this is atomic per entry
    // and cannot half-write a large file. A failure leaves the entry where it
    // was, and the next boot — which still finds no marker — tries again.
    fs.move(join(workspace, name), join(slot.home, name));
    moved.push(name);
  }
  // After the move, not before: chowning in place first would leave the old
  // uid's files unreadable if the move then failed.
  fs.chownRecursive(slot.home, slot.uid, slot.gid);
  // And the marker last of all, so a failure anywhere above leaves the volume
  // un-migrated and the next attempt tries again rather than giving up.
  fs.writeMarker(join(workspace, MIGRATED_FILE));
  return { moved, slot: slot.name };
}

export const realMigrateFs: MigrateFs = {
  list: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  claim: (path) => {
    const stats = lstatSync(path);
    // lchown, not chown, for the reason chownOne gives below: a link pointing
    // outside the workspace must not have its *target* re-owned by the one part
    // of this service that runs as root.
    lchownSync(path, 0, 0);
    if (!stats.isDirectory()) return;
    const mode = stats.mode & 0o7777;
    // Owning it is not always enough — a directory with no owner-write bit
    // still cannot be renamed, and the supervisor holds no CAP_FOWNER to set
    // the mode on something it does not own, which is why this follows the
    // chown. Widening only, only the owner's own bits, and only when they are
    // missing: a workspace made by shell commands never reaches this line, and
    // a deliberately read-only directory arrives one chmod away from how it
    // was, rather than not arriving at all.
    if ((mode & 0o700) !== 0o700) chmodSync(path, mode | 0o700);
  },
  move: (from, to) => renameSync(from, to),
  writeMarker: (path) => writeFileSync(path, new Date().toISOString() + '\n', { mode: 0o600 }),
  exists: (path) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  chownRecursive: (path, uid, gid) => visitDepthFirst(path, (entry) => chownOne(entry, uid, gid)),
};

/**
 * Visit everything under `path`, children before their parent.
 *
 * The order is the entire point, and it is not a matter of taste. The
 * supervisor holds CAP_CHOWN but no DAC_OVERRIDE, so the moment it chowns a
 * 0700 directory to a slot user it can no longer list it. Walking parent-first
 * therefore re-owns the slot directory, gets EACCES from the very next
 * `readdir`, and returns — leaving every file inside still owned by whoever had
 * it before. Nothing throws and the migration reports success; the owner opens
 * their workspace and finds it read-only, which is the failure the migration
 * exists to prevent.
 *
 * Exported so the order can be asserted without root, which is the only way CI
 * can see it: `lchown` fails there for unrelated reasons, so a test of the
 * chown itself would prove nothing.
 */
export function visitDepthFirst(path: string, visit: (entry: string) => void): void {
  let children;
  try {
    children = readdirSync(path, { withFileTypes: true });
  } catch {
    // Not a directory, or one that cannot be listed. Either way it is a leaf.
    visit(path);
    return;
  }
  for (const child of children) {
    // `isDirectory` on a Dirent does not follow symlinks, so a link pointing at
    // a directory is a leaf here rather than a way to walk out of the slot.
    if (child.isDirectory()) visitDepthFirst(join(path, child.name), visit);
    else visit(join(path, child.name));
  }
  visit(path);
}

/** lchown, not chown: a symlink in someone's workspace is retargeted rather
 * than followed, so a link pointing outside the slot cannot make this change
 * the ownership of something it should not touch. */
function chownOne(path: string, uid: number, gid: number): void {
  try {
    lchownSync(path, uid, gid);
  } catch {
    /* a file that vanished between the listing and the chown is not a failure */
  }
}
