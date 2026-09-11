import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOUND_LIMITS,
  generateSignal,
  fftReal,
  fftPadded,
  ifft,
  stft,
  inverseStft,
  analyzeSignal,
  compareTimeReversal,
  cosineDistance,
  reconstructionError,
  energyReport,
  reverseSamples,
  nextPowerOfTwo,
  plotPoints,
} from '../lib/engines/sound-math.ts';
import {
  graphLaplacian,
  graphSpectrum,
  diffuseGraph,
  graphDirichletEnergy,
} from '../lib/engines/graph-math.ts';

const close = (actual, expected, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
const arrayClose = (actual, expected, tolerance = 1e-10) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) close(actual[i], expected[i], tolerance);
};
const path3 = [
  [0, 1, 0],
  [1, 0, 1],
  [0, 1, 0],
];
const testSignal = (size) =>
  Float64Array.from(
    { length: size },
    (_, i) => 0.31 * Math.sin(i * 1.314) + 0.18 * Math.cos(i * 0.27) + 0.02,
  );
const sine = (size, cycles, amplitude = 1) =>
  Float64Array.from(
    { length: size },
    (_, n) => amplitude * Math.sin((2 * Math.PI * cycles * n) / size),
  );

test('DC amplitude and full transform normalization are explicit', () => {
  const spectrum = fftReal(new Float64Array(128).fill(0.25), 8000);
  close(spectrum.real[0], 32);
  close(spectrum.magnitude[0], 0.25);
  assert.ok(spectrum.magnitude.slice(1).every((value) => Math.abs(value) < 1e-12));
  arrayClose(ifft(spectrum).real, new Float64Array(128).fill(0.25));
});

test('Bin-centered sine has the expected frequency, amplitude, and phase', () => {
  const spectrum = fftReal(sine(1024, 64, 0.6), 8192);
  assert.equal(spectrum.frequenciesHz[64], 512);
  close(spectrum.magnitude[64], 0.6);
  close(spectrum.phaseRadians[64], -Math.PI / 2);
  assert.equal(spectrum.magnitude.indexOf(Math.max(...spectrum.magnitude)), 64);
});

test('Nyquist amplitude is not incorrectly doubled', () => {
  const input = Float64Array.from({ length: 128 }, (_, n) => (n % 2 ? -0.7 : 0.7));
  close(fftReal(input, 8000).magnitude[64], 0.7);
});

test('Small FFT agrees with an independent direct DFT', () => {
  const input = [0.2, 0.6, -0.1, 0.7, -0.3, 0.1, 0.8, -0.4];
  const output = fftReal(input, 8000);
  for (let k = 0; k < input.length; k++) {
    let real = 0;
    let imaginary = 0;
    for (let n = 0; n < input.length; n++) {
      real += input[n] * Math.cos((2 * Math.PI * k * n) / input.length);
      imaginary -= input[n] * Math.sin((2 * Math.PI * k * n) / input.length);
    }
    close(output.real[k], real);
    close(output.imaginary[k], imaginary);
  }
});

test('FFT inverse recovers varying real signals without mutating inputs', () => {
  for (const n of [1, 2, 4, 16, 256, 8192]) {
    const input = testSignal(n);
    const copy = input.slice();
    const output = fftReal(input, 8000);
    const recovered = ifft(output);
    arrayClose(recovered.real, input, 1e-10);
    assert.ok(recovered.imaginary.every((value) => Math.abs(value) < 1e-10));
    arrayClose(input, copy, 0);
  }
});

test('Zero padding preserves samples and discrete energy without inventing data', () => {
  const input = testSignal(513);
  const spectrum = fftPadded(input, 8000);
  assert.equal(spectrum.fftSize, 1024);
  arrayClose(ifft(spectrum).real.slice(0, 513), input);
  assert.ok(
    ifft(spectrum)
      .real.slice(513)
      .every((value) => Math.abs(value) < 1e-10),
  );
  assert.ok(energyReport(input, spectrum).relativeDifference < 1e-12);
});

test('Parseval uses all complex bins with the 1/N normalization', () => {
  const input = sine(1024, 37, 0.6);
  const spectrum = fftReal(input, 8000);
  const report = energyReport(input, spectrum);
  close(report.timeDomainSumSquares, (1024 * 0.6 * 0.6) / 2, 1e-9);
  close(report.frequencyDomainSumSquares, report.timeDomainSumSquares, 1e-9);
  assert.ok(report.relativeDifference < 1e-12);
});

test('Global magnitude is preserved by discrete reversal for padded and unpadded lengths', () => {
  for (const n of [127, 128, 513, 8192]) {
    const comparison = compareTimeReversal(testSignal(n), 8000);
    assert.ok(comparison.maxMagnitudeDifference < 1e-10);
    assert.ok(comparison.magnitudeCosineDistance <= 1e-12);
    assert.ok(comparison.waveformCosineDistance > 0.01);
    assert.equal(comparison.semanticInference, 'not-established');
  }
});

test('Sequence order appears in STFT even when global reversal magnitudes match', () => {
  const original = generateSignal({
    mode: 'sequence',
    frequencyAHz: 500,
    frequencyBHz: 1500,
    durationSeconds: 0.256,
    sampleRateHz: 8000,
  });
  const forward = stft(original.samples, 8000, { windowSize: 256, hopSize: 64 });
  const backward = stft(reverseSamples(original.samples), 8000, { windowSize: 256, hopSize: 64 });
  const frame = 4;
  const peak = (row) => row.indexOf(Math.max(...row));
  close(forward.frequenciesHz[peak(forward.magnitude[frame])], 500);
  close(backward.frequenciesHz[peak(backward.magnitude[frame])], 1500);
  assert.ok(compareTimeReversal(original.samples, 8000).maxMagnitudeDifference < 1e-10);
});

test('Centered STFT reconstructs boundaries and non-multiple lengths', () => {
  for (const n of [1, 2, 17, 256, 777, 4097]) {
    for (const hopSize of [32, 64, 128]) {
      const input = testSignal(n);
      input[0] = 0.75;
      input[n - 1] = -0.63;
      const transformed = stft(input, 8000, { windowSize: 256, hopSize });
      const recovered = inverseStft(transformed);
      assert.equal(recovered.length, n);
      arrayClose(recovered, input, 1e-10);
    }
  }
});

test('STFT amplitude compensates the periodic Hann coherent gain', () => {
  const input = sine(2048, 128, 0.6);
  const transformed = stft(input, 8000, { windowSize: 256, hopSize: 64 });
  close(transformed.magnitude[4][16], 0.6, 1e-10);
});

test('Chirp frequency increases with time according to its phase integral', () => {
  const signal = generateSignal({
    mode: 'chirp',
    frequencyAHz: 400,
    frequencyBHz: 1800,
    durationSeconds: 0.5,
  });
  const transformed = stft(signal.samples, signal.sampleRateHz);
  const peak = (row) => transformed.frequenciesHz[row.indexOf(Math.max(...row))];
  assert.ok(peak(transformed.magnitude[48]) > peak(transformed.magnitude[10]) + 600);
});

test('Generator modes respect requested amplitude bound and exact reversal', () => {
  for (const mode of ['two-tone', 'sequence', 'chirp']) {
    const options = {
      mode,
      frequencyAHz: 300,
      frequencyBHz: 1200,
      durationSeconds: 0.25,
      amplitude: 0.4,
    };
    const forward = generateSignal(options);
    assert.ok(forward.samples.every((value) => Math.abs(value) <= 0.4 + 1e-14));
    const reverse = generateSignal({ ...options, reverse: true });
    arrayClose(reverse.samples, reverseSamples(forward.samples), 0);
  }
});

test('Cosine distance is bounded and zero-norm cases remain undefined', () => {
  close(cosineDistance([1, 0], [2, 0]), 0);
  close(cosineDistance([1, 0], [0, 1]), 1);
  close(cosineDistance([1, 0], [-1, 0]), 2);
  assert.equal(cosineDistance([0, 0], [0, 0]), null);
  assert.equal(cosineDistance([0, 0], [1, 0]), null);
  assert.throws(() => cosineDistance([1], [1, 0]), RangeError);
});

test('All-zero signal yields zero reconstruction and explicitly undefined similarity', () => {
  const input = new Float64Array(256);
  const result = analyzeSignal(input, 8000);
  assert.equal(result.fftReconstructionError.maxAbsoluteError, 0);
  assert.equal(result.stftReconstructionError.maxAbsoluteError, 0);
  assert.equal(result.energy.relativeDifference, 0);
  assert.equal(compareTimeReversal(input, 8000).magnitudeCosineDistance, null);
});

test('FFT rejects empty, non-power-of-two, nonfinite and excessive inputs', () => {
  for (const input of [[], [1, 2, 3], [NaN, 0], [Infinity, 0], [1e100, 0]])
    assert.throws(() => fftReal(input, 8000), RangeError);
  assert.throws(
    () => fftReal(new Float64Array(SOUND_LIMITS.maxSignalSamples + 1), 8000),
    RangeError,
  );
  for (const sampleRate of [0, -1, NaN, Infinity, 1e9])
    assert.throws(() => fftReal([0, 1], sampleRate), RangeError);
  assert.throws(() => ifft({ real: [1, 2], imaginary: [0] }), RangeError);
  assert.throws(() => ifft({ real: [1, NaN], imaginary: [0, 0] }), RangeError);
  assert.throws(() => nextPowerOfTwo(SOUND_LIMITS.maxFftSize + 1), RangeError);
});

test('STFT rejects missing overlap, non-power windows, corrupted metadata and excessive work', () => {
  const input = new Float64Array(4096);
  for (const options of [
    { windowSize: 300 },
    { windowSize: 8192 },
    { hopSize: 0 },
    { hopSize: 256 },
    { windowSize: 256, hopSize: 1 },
  ]) {
    assert.throws(() => stft(input, 8000, options), RangeError);
  }
  const result = stft(input, 8000);
  assert.throws(() => inverseStft({ ...result, paddingLeft: 0 }), RangeError);
  assert.throws(() => inverseStft({ ...result, frames: result.frames.slice(1) }), RangeError);
  assert.throws(() => inverseStft({ ...result, window: new Float64Array(256) }), RangeError);
});

test('Generator rejects aliases, invalid modes, short and oversized requests', () => {
  const valid = { mode: 'two-tone', frequencyAHz: 500, frequencyBHz: 1000, durationSeconds: 0.1 };
  for (const change of [
    { frequencyAHz: 4000 },
    { frequencyBHz: -2 },
    { frequencyAHz: NaN },
    { amplitude: 2 },
    { durationSeconds: 0 },
    { durationSeconds: 1e6 },
    { durationSeconds: 0.00001 },
    { mode: 'meaning-wave' },
  ]) {
    assert.throws(() => generateSignal({ ...valid, ...change }), RangeError);
  }
});

test('Analysis is self-consistent and plotting retains end points', () => {
  const input = testSignal(1000);
  const result = analyzeSignal(input, 8000);
  assert.equal(result.originalLength, 1000);
  assert.equal(result.spectrum.fftSize, 1024);
  close(result.observationDurationSeconds, 0.125);
  close(result.binSpacingHz, 7.8125);
  assert.ok(result.fftReconstructionError.maxAbsoluteError < 1e-10);
  assert.ok(result.stftReconstructionError.maxAbsoluteError < 1e-10);
  const points = plotPoints(input, 1 / 8000, 100);
  assert.equal(points.length, 100);
  assert.deepEqual(points[0], { x: 0, y: input[0] });
  assert.deepEqual(points.at(-1), { x: 999 / 8000, y: input[999] });
  assert.throws(() => reconstructionError([1], [1, 2]), RangeError);
});

test('Graph Laplacian has zero row sums and known path eigenvalues', () => {
  const laplacian = graphLaplacian(path3);
  assert.deepEqual(laplacian, [
    [1, -1, 0],
    [-1, 2, -1],
    [0, -1, 1],
  ]);
  for (const row of laplacian)
    close(
      row.reduce((sum, value) => sum + value, 0),
      0,
    );
  const result = graphSpectrum(path3);
  arrayClose(result.eigenvalues, [0, 1, 3]);
  assert.ok(result.maxEigenResidual < 1e-10);
  assert.ok(result.maxOrthogonalityError < 1e-10);
});

test('Complete and disconnected graphs have expected eigenvalue multiplicities', () => {
  const complete4 = Array.from({ length: 4 }, (_, i) =>
    Array.from({ length: 4 }, (_, j) => Number(i !== j)),
  );
  arrayClose(graphSpectrum(complete4).eigenvalues, [0, 4, 4, 4]);
  arrayClose(
    graphSpectrum([
      [0, 1, 0, 0],
      [1, 0, 0, 0],
      [0, 0, 0, 1],
      [0, 0, 1, 0],
    ]).eigenvalues,
    [0, 0, 2, 2],
  );
  arrayClose(graphSpectrum([[0]]).eigenvalues, [0]);
});

test('Graph eigenvectors satisfy residual and orthogonality checks on a weighted case', () => {
  const a = [
    [0, 0.4, 0, 0.1],
    [0.4, 0, 1.2, 0.2],
    [0, 1.2, 0, 0.7],
    [0.1, 0.2, 0.7, 0],
  ];
  const result = graphSpectrum(a);
  assert.ok(result.eigenvalues.every((value) => value >= -1e-10));
  assert.ok(result.maxEigenResidual < 1e-10);
  assert.ok(result.maxOrthogonalityError < 1e-10);
  close(
    result.eigenvalues.reduce((sum, value) => sum + value, 0),
    result.laplacian.reduce((sum, row, i) => sum + row[i], 0),
  );
});

test('Heat diffusion preserves mass, dissipates Dirichlet energy and is identity at zero', () => {
  const initial = [1, 0, 0];
  arrayClose(diffuseGraph(path3, initial, 0).diffusedSignal, initial);
  const result = diffuseGraph(path3, initial, 1);
  close(result.sumAfter, result.sumBefore);
  assert.ok(result.energyAfter < result.energyBefore);
  assert.ok(result.diffusedSignal.every((value) => value >= 0));
  arrayClose(diffuseGraph(path3, initial, 100).diffusedSignal, [1 / 3, 1 / 3, 1 / 3], 1e-10);
  close(graphDirichletEnergy(path3, [1, 1, 1]), 0);
});

test('Diffusion does not transfer signal across disconnected components', () => {
  const adjacency = [
    [0, 1, 0, 0],
    [1, 0, 0, 0],
    [0, 0, 0, 1],
    [0, 0, 1, 0],
  ];
  const output = diffuseGraph(adjacency, [1, 0, 0, 0], 10).diffusedSignal;
  close(output[0] + output[1], 1);
  close(output[2], 0);
  close(output[3], 0);
});

test('Graph validation rejects directionality, negative weights, NaNs and oversized graphs', () => {
  for (const graph of [
    [],
    [
      [0, 1],
      [0, 0],
    ],
    [
      [0, -1],
      [-1, 0],
    ],
    [
      [0, NaN],
      [NaN, 0],
    ],
    [[1]],
    [[0, 1], [1]],
    Array.from({ length: 33 }, () => new Array(33).fill(0)),
  ]) {
    assert.throws(() => graphSpectrum(graph), RangeError);
  }
  assert.throws(() => diffuseGraph(path3, [1, 2], 1), RangeError);
  assert.throws(() => diffuseGraph(path3, [1, 2, NaN], 1), RangeError);
  assert.throws(() => diffuseGraph(path3, new Array(3), 1), RangeError);
  assert.throws(() => diffuseGraph(path3, [1, 2, 3], -1), RangeError);
});
