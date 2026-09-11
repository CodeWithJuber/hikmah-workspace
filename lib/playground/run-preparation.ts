import { connectMcp, type McpTool } from './mcp-client';
import type { McpConnection } from './workspace-config';

/** Optional preparation must never hold the answer or Stop button hostage. */
export async function withinDeadline<T>(
  task: Promise<T>,
  signal: AbortSignal,
  milliseconds: number,
): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout>;
  let stop: () => void;
  const deadline = new Promise<never>((_, reject) => {
    stop = () => reject(new DOMException('Stopped', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    timer = setTimeout(() => reject(new Error('Optional preparation timed out.')), milliseconds);
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', stop!);
  }
}

export async function prepareConnectors(
  connections: McpConnection[],
  keys: Record<string, string>,
  catalogs: Record<string, McpTool[]>,
  signal: AbortSignal,
  connect = connectMcp,
) {
  signal.throwIfAborted();
  const ready = { ...catalogs };
  const failures: { id: string; name: string; message: string }[] = [];
  await Promise.all(
    connections
      .filter((c) => c.enabled && !ready[c.id]?.length)
      .map(async (c) => {
        try {
          const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
          ready[c.id] = await withinDeadline(connect(c, keys[c.id] ?? '', bounded), signal, 8500);
        } catch (e) {
          delete ready[c.id];
          failures.push({
            id: c.id,
            name: c.name,
            message: e instanceof Error ? e.message : 'Connection unavailable.',
          });
        }
      }),
  );
  signal.throwIfAborted();
  return { catalogs: ready, failures };
}
