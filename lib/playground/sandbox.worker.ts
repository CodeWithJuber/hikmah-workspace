import { evaluateJavascript, quickJsModule } from './sandbox-core';

/** Boot the runtime as soon as the worker starts, and say when it is usable.
 *
 * Startup and execution are announced separately because they fail for
 * different reasons and deserve different patience: compiling the WASM module
 * takes seconds on a modest machine, while a program that has not finished in
 * seconds is a program that is stuck. */
void quickJsModule().then(
  () => self.postMessage({ ready: true }),
  (error: unknown) =>
    self.postMessage({
      ready: false,
      error: error instanceof Error ? error.message : 'The JavaScript runtime could not start.',
    }),
);

self.onmessage = async (event: MessageEvent<{ id: number; code: string }>) => {
  const { id, code } = event.data;
  try {
    self.postMessage({ id, value: await evaluateJavascript(code) });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : 'Sandbox failed.' });
  }
};
