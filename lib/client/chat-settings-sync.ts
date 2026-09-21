import type { ChatSettings } from '../chat/settings.ts';

type SettingsSyncOptions = {
  read: (signal: AbortSignal) => Promise<ChatSettings>;
  write: (patch: Partial<ChatSettings>) => Promise<ChatSettings>;
  publish: (settings: ChatSettings) => void;
  ready: () => void;
};

/** Coordinate one mounted settings reader. Writes are serialized patches;
 * refreshes coalesce, and a read started before a write or invalidation cannot
 * replace its newer result. Nothing is persisted in browser storage. */
export function createChatSettingsSync(options: SettingsSyncOptions) {
  let stopped = false;
  let generation = 0;
  let wanted = false;
  let scheduled = false;
  let reading: AbortController | null = null;
  let writes = 0;
  let tail: Promise<void> = Promise.resolve();

  function schedule() {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!stopped && wanted && !reading && !writes) void readLatest();
    });
  }

  async function readLatest() {
    wanted = false;
    const started = generation;
    const controller = new AbortController();
    reading = controller;
    try {
      const next = await options.read(controller.signal);
      if (!stopped && !controller.signal.aborted && started === generation && !writes)
        options.publish(next);
    } catch {
      // Preserve the last confirmed snapshot. An initial failure retains the
      // existing app fallback; a later refresh never clears working settings.
    } finally {
      if (!stopped && !controller.signal.aborted && started === generation && !writes)
        options.ready();
      if (reading === controller) reading = null;
      schedule();
    }
  }

  return {
    refresh() {
      if (stopped) return;
      generation++;
      wanted = true;
      schedule();
    },
    change(patch: Partial<ChatSettings>): Promise<void> {
      if (stopped) return Promise.reject(new Error('Settings are unavailable. Reopen the page.'));
      const started = ++generation;
      writes++;
      reading?.abort();
      const operation = tail.then(async () => {
        try {
          if (stopped) throw new Error('Settings are unavailable. Reopen the page.');
          const next = await options.write(patch);
          if (!stopped && started === generation && writes === 1) {
            options.publish(next);
            options.ready();
          }
        } catch (error) {
          // A timeout can occur after the server committed the patch. Re-read
          // after the queue drains while still returning the failed save.
          if (!stopped) wanted = true;
          throw error;
        } finally {
          writes--;
          schedule();
        }
      });
      // A failed save must not prevent a later retry from running.
      tail = operation.catch(() => {});
      return operation;
    },
    stop() {
      stopped = true;
      generation++;
      wanted = false;
      reading?.abort();
    },
  };
}
