/** One Unix user per account.
 *
 * The workbench had no concept of a user at all: one container, one uid, one
 * `/workspace`, one `/tmp`. With a single owner that is a feature. With two it
 * is a shared filesystem and a shell handed to whoever signed up last — which
 * is why `entitlements.execution` has had to stay owner-only, and why
 * `containPath` says in its own comment that it is not a security boundary.
 *
 * A slot is the answer: an unprivileged uid baked into the image, and a
 * directory that uid alone can enter. The filesystem is what keeps one account
 * out of another's work, not a policy and not a path check. The supervisor
 * assigns slots; it never decides what may run.
 *
 * The pool is fixed and pre-created in the image rather than grown on demand,
 * because creating users at runtime needs `useradd` and a writable `/etc`, and
 * a service that can rewrite `/etc/passwd` is a larger thing than one that
 * cannot.
 */
import { chmodSync, chownSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Slot users baked into the image as hk01…hk32. */
export const POOL_SIZE = 32;
/** uid and gid of hk01; hk<n> is FIRST_ID + n - 1. Above any system range and
 * clear of the 1000 the old single `node` user occupied. */
export const FIRST_ID = 3001;
/** Where the assignment lives, relative to the workspace root. */
export const SLOTS_FILE = '.slots.json';
/** Slot directories live together under one parent, so the workspace root stays
 * a place the supervisor can list. */
export const SLOTS_DIR = 'u';

export type Slot = {
  /** 1-based, matching the name. */
  index: number;
  /** The Unix user name, `hk01`. */
  name: string;
  uid: number;
  gid: number;
  /** The slot's directory, which is also its HOME. */
  home: string;
};

export class SlotError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SlotError';
    this.status = status;
  }
}

/** `hk01` … `hk32`. Zero-padded so the names sort the way the numbers do. */
export function slotName(index: number): string {
  return 'hk' + String(index).padStart(2, '0');
}

/**
 * A user key is opaque to the workbench, and must stay that way.
 *
 * The app sends an HMAC of the account id rather than the id itself, so the
 * workbench never learns who anyone is and a stolen id is not a slot. All this
 * side checks is the shape: something that could not be a path, a flag or a
 * line in a log pretending to be something else.
 */
const USER_KEY = /^[A-Za-z0-9_-]{16,64}$/;

export function isUserKey(value: unknown): value is string {
  return typeof value === 'string' && USER_KEY.test(value);
}

/** The filesystem calls this needs, injectable so the tests do not need root. */
export type SlotFs = {
  mkdir(path: string): void;
  chown(path: string, uid: number, gid: number): void;
  chmod(path: string, mode: number): void;
  /** null when the file is not there; anything else throws. */
  readFile(path: string): string | null;
  writeFile(path: string, body: string, mode: number): void;
};

const realFs: SlotFs = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  chown: (path, uid, gid) => chownSync(path, uid, gid),
  chmod: (path, mode) => chmodSync(path, mode),
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  writeFile: (path, body, mode) => writeFileSync(path, body, { mode }),
};

type Assignment = { version: 1; slots: Record<string, number> };

function parseAssignment(body: string | null, size: number): Assignment {
  if (!body) return { version: 1, slots: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Deliberately fatal rather than "start again with an empty map": a
    // corrupt file silently reset would hand one person another's directory.
    throw new SlotError('The slot assignment file could not be read.', 500);
  }
  const slots = (parsed as Assignment)?.slots;
  // A plain object specifically: an array is also `typeof 'object'`, reads as
  // an empty map, and would then be written back as an array.
  if (!slots || typeof slots !== 'object' || Array.isArray(slots))
    throw new SlotError('The slot assignment file is malformed.', 500);
  for (const [key, index] of Object.entries(slots)) {
    if (!isUserKey(key) || !Number.isInteger(index) || index < 1 || index > size)
      throw new SlotError('The slot assignment file is malformed.', 500);
  }
  return { version: 1, slots: slots as Record<string, number> };
}

/**
 * The slot registry for a workspace.
 *
 * Assignments are persisted so a person keeps their directory across a restart;
 * losing the map would not lose their files, but it would hand them a new empty
 * slot and leave the old one orphaned, which reads as data loss.
 */
export function createSlots(options: {
  workspace: string;
  size?: number;
  /** Injected by the tests, which do not run as root. */
  fs?: SlotFs;
}) {
  const workspace = resolve(options.workspace);
  const size = options.size ?? POOL_SIZE;
  const fs = options.fs ?? realFs;
  const file = join(workspace, SLOTS_FILE);
  const parent = join(workspace, SLOTS_DIR);

  let assignment: Assignment | null = null;
  const load = (): Assignment => (assignment ??= parseAssignment(fs.readFile(file), size));

  const save = () => {
    // 0600 and root-owned: a slot user that could rewrite this could point its
    // own key at someone else's directory.
    fs.writeFile(file, JSON.stringify(load(), null, 2) + '\n', 0o600);
  };

  const describe = (index: number): Slot => ({
    index,
    name: slotName(index),
    uid: FIRST_ID + index - 1,
    gid: FIRST_ID + index - 1,
    home: join(parent, slotName(index)),
  });

  return {
    /**
     * The slot for a user key, assigned on first use.
     *
     * Creating the directory is part of resolving the slot rather than a
     * separate step, so there is no window in which a slot is assigned and its
     * directory is missing or owned by the wrong uid.
     *
     * `beforeHandover` runs while the directory is still root's, after its mode
     * is set and before it is given to the slot user. That window exists for
     * exactly one caller — the one-time migration of a pre-slots workspace,
     * which has to move files *into* the directory. Once it belongs to the slot
     * user the supervisor cannot write there at all (no DAC_OVERRIDE), so there
     * is no later moment at which that move could happen.
     */
    for(userKey: string, beforeHandover?: (slot: Slot) => void): Slot {
      if (!isUserKey(userKey))
        throw new SlotError('This request did not say which account it is for.', 400);
      const state = load();
      let index = state.slots[userKey];
      if (index === undefined) {
        const taken = new Set(Object.values(state.slots));
        index = 0;
        for (let candidate = 1; candidate <= size; candidate += 1) {
          if (!taken.has(candidate)) {
            index = candidate;
            break;
          }
        }
        if (!index)
          throw new SlotError(
            `This deployment runs ${size} workspaces and all of them are in use.`,
            503,
          );
        state.slots[userKey] = index;
        save();
      }
      const slot = describe(index);
      // mkdir, take it back, set the mode, let the caller write, hand it over —
      // and every step of that order is forced by the capability set.
      //
      // `chmod` needs ownership or CAP_FOWNER, and the supervisor holds neither
      // once the directory belongs to the slot user; so the mode must be set
      // while root still owns it, which means chowning back first to make this
      // idempotent for a directory that already belongs to someone.
      //
      // Writing into the directory needs the same thing, which is why
      // `beforeHandover` sits here rather than after: a 0700 directory owned by
      // hk01 is one the supervisor cannot rename a file into.
      //
      // Measured under cap_drop ALL + cap_add SETUID/SETGID/CHOWN. Two earlier
      // orderings failed in CI, each silently:
      //   mkdir -> chown -> chmod          chmod EPERM, left world-readable
      //   ...then migrate after handover   rename EACCES, nothing moved
      try {
        fs.mkdir(slot.home);
        fs.chown(slot.home, 0, 0);
        fs.chmod(slot.home, 0o700);
        beforeHandover?.(slot);
        fs.chown(slot.home, slot.uid, slot.gid);
      } catch (error) {
        if (error instanceof SlotError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        // What an operator meets if the volume was restored from a backup, or
        // came from a release before `chown 0:0 workbench-data`.
        if (code === 'EACCES' || code === 'EPERM')
          throw new SlotError(
            `The workspace volume is not writable by this service. ` +
              `Its root must be owned by root (\`chown 0:0\` on the mounted directory); ` +
              `each account's own directory inside it is then created for them.`,
            500,
          );
        throw error;
      }
      return slot;
    },

    /** Forget an assignment. The directory is left alone: this is for tests and
     * for an account that has been removed, neither of which should delete
     * someone's files as a side effect. */
    release(userKey: string): void {
      const state = load();
      if (state.slots[userKey] === undefined) return;
      delete state.slots[userKey];
      save();
    },

    /** Has anything been assigned yet? The migration below asks this. */
    get assigned(): number {
      return Object.keys(load().slots).length;
    },

    get size(): number {
      return size;
    },
  };
}
