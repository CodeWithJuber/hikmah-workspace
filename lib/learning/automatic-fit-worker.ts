import { parentPort, workerData } from 'node:worker_threads';
import { fitAutomatic, type AutomaticFitInput } from './automatic-training.ts';

try {
  const value = fitAutomatic(workerData as AutomaticFitInput, (stage) =>
    parentPort?.postMessage({ stage }),
  );
  parentPort?.postMessage({ value });
} catch {
  // Corpus text and model-supplied labels must not become operator diagnostics.
  parentPort?.postMessage({
    error:
      'The local training or evaluation could not complete. Your current co-model is unchanged.',
  });
}
