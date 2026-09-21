/**
 * Starts the run worker once per server process.
 *
 * `register` is the only documented once-per-start hook, and it runs in every
 * runtime, so the Node-only work is behind a runtime check and a dynamic import
 * that keeps node:sqlite out of the edge compile.
 *
 * The worker is started without awaiting it. Next waits for `register` to
 * resolve before serving any request, so awaiting a loop that runs for the life
 * of the process would mean the server never comes up.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runService } = await import('./lib/runs/service');
    const worker = runService();
    worker.start();
    const { automaticLearningService } = await import('./lib/learning/automatic-server');
    const learning = automaticLearningService();
    learning.start();

    // Hand back anything in flight so the next boot resumes it rather than
    // leaving it marked running with nobody driving it.
    const shutdown = () => {
      void worker.stop();
      void learning.stop();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}
