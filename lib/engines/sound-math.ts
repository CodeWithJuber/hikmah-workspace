/**
 * Inspectable signal mathematics for the Hikmah playground.
 * Browser-pure: no DOM, Node, network, audio decoding, or learned parameters.
 * These are standard numerical methods, not a speech/meaning decoder.
 */
export const SOUND_LIMITS = Object.freeze({
  maxSignalSamples: 65_536,
  maxFftSize: 65_536,
  maxStftWindowSize: 4_096,
  maxStftComplexCells: 524_288,
  maxSampleRateHz: 384_000,
  maxInputMagnitude: 1_000_000,
});

export type NumericArray = ArrayLike<number>;
export type SignalMode = 'two-tone' | 'sequence' | 'chirp';

export interface SignalOptions {
  mode: SignalMode;
  frequencyAHz: number;
  frequencyBHz: number;
  durationSeconds: number;
  sampleRateHz?: number;
  /** Peak bound, from 0 to 1. Two simultaneous tones each receive half. */
  amplitude?: number;
  /** Reverse the actual discrete samples after generation. */
  reverse?: boolean;
}

export interface GeneratedSignal {
  samples: Float64Array;
  sampleRateHz: number;
  /** Actual sample count / sample rate; requested duration is rounded. */
  durationSeconds: number;
  mode: SignalMode;
  reversed: boolean;
}

export interface ComplexArrays {
  /** Full two-sided, unnormalized DFT coefficients. */
  real: Float64Array;
  imaginary: Float64Array;
}

export interface RealSpectrum extends ComplexArrays {
  fftSize: number;
  sampleRateHz: number;
  /** One-sided nonnegative bins, 0 through Nyquist for even N. */
  frequenciesHz: Float64Array;
  /** One-sided amplitude: 2|X[k]|/N except DC and Nyquist, which use |X[k]|/N. */
  magnitude: Float64Array;
  /** Phase is mathematically undefined at zero amplitude; returned as 0 there. */
  phaseRadians: Float64Array;
}

export interface StftOptions {
  /** Power of two, 4..4096. Default 256. */
  windowSize?: number;
  /** Integer 1..windowSize/2. Default windowSize/4. */
  hopSize?: number;
}

export interface StftResult {
  sampleRateHz: number;
  originalLength: number;
  windowSize: number;
  hopSize: number;
  paddingLeft: number;
  window: Float64Array;
  windowName: 'periodic-hann';
  /** Frame-center coordinates relative to the original signal. */
  timesSeconds: Float64Array;
  frequenciesHz: Float64Array;
  /** Layout is [time frame][nonnegative frequency bin]. */
  magnitude: Float64Array[];
  /** Retained phase-bearing data; magnitude alone cannot perform this inverse. */
  frames: ComplexArrays[];
}

export interface ReconstructionError {
  maxAbsoluteError: number;
  rootMeanSquareError: number;
}

export interface EnergyReport {
  /** Discrete sum of squares. Physical energy needs units and calibration. */
  timeDomainSumSquares: number;
  /** sum(|X|^2)/N over the full complex spectrum. */
  frequencyDomainSumSquares: number;
  absoluteDifference: number;
  relativeDifference: number;
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function positiveSampleRate(value: number): void {
  finite(value, 'sampleRateHz');
  if (value <= 0 || value > SOUND_LIMITS.maxSampleRateHz) {
    throw new RangeError(`sampleRateHz must be > 0 and <= ${SOUND_LIMITS.maxSampleRateHz}`);
  }
}

function validateArray(
  input: NumericArray,
  label = 'samples',
  cap: number = SOUND_LIMITS.maxSignalSamples,
  magnitudeCap: number = SOUND_LIMITS.maxInputMagnitude,
): number {
  if (input == null || !Number.isInteger(input.length) || input.length < 1 || input.length > cap) {
    throw new RangeError(`${label} length must be an integer in 1..${cap}`);
  }
  for (let i = 0; i < input.length; i++) {
    if (!Number.isFinite(input[i]) || Math.abs(input[i]) > magnitudeCap) {
      throw new RangeError(`${label}[${i}] must be finite and have magnitude <= ${magnitudeCap}`);
    }
  }
  return input.length;
}

export function isPowerOfTwo(size: number): boolean {
  return (
    Number.isInteger(size) &&
    size > 0 &&
    size <= SOUND_LIMITS.maxFftSize &&
    (size & (size - 1)) === 0
  );
}

export function nextPowerOfTwo(size: number): number {
  if (!Number.isInteger(size) || size < 1 || size > SOUND_LIMITS.maxFftSize) {
    throw new RangeError(`size must be an integer in 1..${SOUND_LIMITS.maxFftSize}`);
  }
  let result = 1;
  while (result < size) result *= 2;
  return result;
}

export function reverseSamples(input: NumericArray): Float64Array {
  const size = validateArray(input);
  const result = new Float64Array(size);
  for (let i = 0; i < size; i++) result[i] = input[size - 1 - i];
  return result;
}

export function generateSignal(options: SignalOptions): GeneratedSignal {
  const sampleRateHz = options.sampleRateHz ?? 8_000;
  const amplitude = options.amplitude ?? 0.7;
  positiveSampleRate(sampleRateHz);
  finite(options.durationSeconds, 'durationSeconds');
  finite(amplitude, 'amplitude');
  if (options.durationSeconds <= 0 || amplitude < 0 || amplitude > 1) {
    throw new RangeError('durationSeconds must be positive and amplitude must be in [0, 1]');
  }
  if (!['two-tone', 'sequence', 'chirp'].includes(options.mode))
    throw new RangeError('Unknown signal mode');
  for (const frequency of [options.frequencyAHz, options.frequencyBHz]) {
    finite(frequency, 'tone frequency');
    if (frequency < 0 || frequency >= sampleRateHz / 2) {
      throw new RangeError(
        'Tone frequencies must be >= 0 and strictly below the Nyquist frequency',
      );
    }
  }
  const size = Math.round(options.durationSeconds * sampleRateHz);
  if (!Number.isInteger(size) || size < 2 || size > SOUND_LIMITS.maxSignalSamples) {
    throw new RangeError(`Generated length must be in 2..${SOUND_LIMITS.maxSignalSamples} samples`);
  }
  const durationSeconds = size / sampleRateHz;
  const split = Math.floor(size / 2);
  const splitSeconds = split / sampleRateHz;
  const samples = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const t = i / sampleRateHz;
    let value: number;
    if (options.mode === 'two-tone') {
      value =
        0.5 *
        (Math.sin(2 * Math.PI * options.frequencyAHz * t) +
          Math.sin(2 * Math.PI * options.frequencyBHz * t));
    } else if (options.mode === 'sequence') {
      // Phase is continuous at the switch; instantaneous frequency changes.
      const cycles =
        i < split
          ? options.frequencyAHz * t
          : options.frequencyAHz * splitSeconds + options.frequencyBHz * (t - splitSeconds);
      value = Math.sin(2 * Math.PI * cycles);
    } else {
      // f(t)=fA+(fB-fA)t/T, so phase is the integral of that frequency.
      const cycles =
        options.frequencyAHz * t +
        ((options.frequencyBHz - options.frequencyAHz) * t * t) / (2 * durationSeconds);
      value = Math.sin(2 * Math.PI * cycles);
    }
    samples[i] = amplitude * value;
  }
  return {
    samples: options.reverse ? reverseSamples(samples) : samples,
    sampleRateHz,
    durationSeconds,
    mode: options.mode,
    reversed: options.reverse ?? false,
  };
}

function transformComplex(
  realInput: NumericArray,
  imaginaryInput: NumericArray | null,
  inverse: boolean,
): ComplexArrays {
  const size = realInput.length;
  if (!isPowerOfTwo(size))
    throw new RangeError('FFT length must be a power of two within the size cap');
  const real = Float64Array.from(realInput);
  const imaginary = imaginaryInput ? Float64Array.from(imaginaryInput) : new Float64Array(size);
  // In-place bit reversal in our private copies; input arrays are never mutated.
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2;
    const angle = ((inverse ? 2 : -2) * Math.PI) / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += width) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let j = 0; j < half; j++) {
        const even = start + j;
        const odd = even + half;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < size; i++) {
      real[i] /= size;
      imaginary[i] /= size;
    }
  }
  return { real, imaginary };
}

export function fftReal(input: NumericArray, sampleRateHz: number): RealSpectrum {
  const size = validateArray(input);
  positiveSampleRate(sampleRateHz);
  const complex = transformComplex(input, null, false);
  const bins = Math.floor(size / 2) + 1;
  const frequenciesHz = new Float64Array(bins);
  const magnitude = new Float64Array(bins);
  const phaseRadians = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const rawMagnitude = Math.hypot(complex.real[k], complex.imaginary[k]);
    const endpoint = k === 0 || (size % 2 === 0 && k === size / 2);
    frequenciesHz[k] = (k * sampleRateHz) / size;
    magnitude[k] = (rawMagnitude * (endpoint ? 1 : 2)) / size;
    phaseRadians[k] = rawMagnitude === 0 ? 0 : Math.atan2(complex.imaginary[k], complex.real[k]);
  }
  return { ...complex, fftSize: size, sampleRateHz, frequenciesHz, magnitude, phaseRadians };
}

export function fftPadded(input: NumericArray, sampleRateHz: number): RealSpectrum {
  const size = validateArray(input);
  const padded = new Float64Array(nextPowerOfTwo(size));
  for (let i = 0; i < size; i++) padded[i] = input[i];
  return fftReal(padded, sampleRateHz);
}

export function ifft(spectrum: { real: NumericArray; imaginary: NumericArray }): ComplexArrays {
  const maxCoefficient = SOUND_LIMITS.maxInputMagnitude * SOUND_LIMITS.maxFftSize;
  const size = validateArray(spectrum.real, 'real', SOUND_LIMITS.maxFftSize, maxCoefficient);
  validateArray(spectrum.imaginary, 'imaginary', SOUND_LIMITS.maxFftSize, maxCoefficient);
  if (size !== spectrum.imaginary.length)
    throw new RangeError('Complex arrays must have equal lengths');
  return transformComplex(spectrum.real, spectrum.imaginary, true);
}

function stftConfiguration(
  size: number,
  options: StftOptions,
): { windowSize: number; hopSize: number; frameCount: number } {
  const windowSize = options.windowSize ?? 256;
  const hopSize = options.hopSize ?? windowSize / 4;
  if (!isPowerOfTwo(windowSize) || windowSize < 4 || windowSize > SOUND_LIMITS.maxStftWindowSize) {
    throw new RangeError('windowSize must be a power of two in 4..4096');
  }
  if (!Number.isInteger(hopSize) || hopSize < 1 || hopSize > windowSize / 2) {
    throw new RangeError('hopSize must be an integer in 1..windowSize/2 for reliable overlap');
  }
  const frameCount = Math.ceil(size / hopSize) + 1;
  if (frameCount * windowSize > SOUND_LIMITS.maxStftComplexCells) {
    throw new RangeError(
      'STFT exceeds the complex-cell budget; shorten the signal or increase hopSize',
    );
  }
  return { windowSize, hopSize, frameCount };
}

export function stft(
  input: NumericArray,
  sampleRateHz: number,
  options: StftOptions = {},
): StftResult {
  const originalLength = validateArray(input);
  positiveSampleRate(sampleRateHz);
  const { windowSize, hopSize, frameCount } = stftConfiguration(originalLength, options);
  const paddingLeft = windowSize / 2;
  const window = Float64Array.from(
    { length: windowSize },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / windowSize),
  );
  const timesSeconds = new Float64Array(frameCount);
  const frequenciesHz = Float64Array.from(
    { length: windowSize / 2 + 1 },
    (_, k) => (k * sampleRateHz) / windowSize,
  );
  const frames: ComplexArrays[] = [];
  const magnitude: Float64Array[] = [];
  const windowSum = window.reduce((sum, value) => sum + value, 0);
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * hopSize - paddingLeft;
    const chunk = new Float64Array(windowSize);
    for (let n = 0; n < windowSize; n++) {
      const sourceIndex = offset + n;
      if (sourceIndex >= 0 && sourceIndex < originalLength)
        chunk[n] = input[sourceIndex] * window[n];
    }
    const spectrum = fftReal(chunk, sampleRateHz);
    frames.push({ real: spectrum.real, imaginary: spectrum.imaginary });
    // Correct the displayed amplitude for the analysis window's coherent gain.
    magnitude.push(spectrum.magnitude.map((value) => (value * windowSize) / windowSum));
    timesSeconds[frame] = (frame * hopSize) / sampleRateHz;
  }
  return {
    sampleRateHz,
    originalLength,
    windowSize,
    hopSize,
    paddingLeft,
    window,
    windowName: 'periodic-hann',
    timesSeconds,
    frequenciesHz,
    magnitude,
    frames,
  };
}

export function inverseStft(result: StftResult): Float64Array {
  if (
    !Number.isInteger(result.originalLength) ||
    result.originalLength < 1 ||
    result.originalLength > SOUND_LIMITS.maxSignalSamples
  ) {
    throw new RangeError('Invalid originalLength');
  }
  const configuration = stftConfiguration(result.originalLength, result);
  if (
    result.frames.length !== configuration.frameCount ||
    result.paddingLeft !== result.windowSize / 2 ||
    result.window.length !== result.windowSize ||
    result.windowName !== 'periodic-hann'
  ) {
    throw new RangeError('STFT metadata does not match this transform convention');
  }
  validateArray(result.window, 'window', SOUND_LIMITS.maxStftWindowSize, 1);
  const output = new Float64Array(result.originalLength);
  const weights = new Float64Array(result.originalLength);
  for (let frame = 0; frame < result.frames.length; frame++) {
    if (
      result.frames[frame].real.length !== result.windowSize ||
      result.frames[frame].imaginary.length !== result.windowSize
    ) {
      throw new RangeError('STFT frame length mismatch');
    }
    const chunk = ifft(result.frames[frame]);
    const offset = frame * result.hopSize - result.paddingLeft;
    for (let n = 0; n < result.windowSize; n++) {
      const target = offset + n;
      if (target >= 0 && target < output.length) {
        output[target] += chunk.real[n] * result.window[n];
        weights[target] += result.window[n] * result.window[n];
      }
    }
  }
  for (let i = 0; i < output.length; i++) {
    if (weights[i] <= 1e-12) throw new RangeError('Nonzero overlap-add condition failed');
    output[i] /= weights[i];
  }
  return output;
}

export function reconstructionError(
  expected: NumericArray,
  actual: NumericArray,
): ReconstructionError {
  validateArray(expected, 'expected');
  validateArray(actual, 'actual');
  if (expected.length !== actual.length) throw new RangeError('Reconstruction lengths must match');
  let maxAbsoluteError = 0;
  let sum = 0;
  for (let i = 0; i < expected.length; i++) {
    const difference = Math.abs(expected[i] - actual[i]);
    maxAbsoluteError = Math.max(maxAbsoluteError, difference);
    sum += difference * difference;
  }
  return { maxAbsoluteError, rootMeanSquareError: Math.sqrt(sum / expected.length) };
}

/** Cosine feature distance in [0,2], or null when either vector has zero norm. */
export function cosineDistance(a: NumericArray, b: NumericArray): number | null {
  validateArray(a, 'a', SOUND_LIMITS.maxFftSize, 1e12);
  validateArray(b, 'b', SOUND_LIMITS.maxFftSize, 1e12);
  if (a.length !== b.length) throw new RangeError('Feature dimensions must match');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return 1 - Math.max(-1, Math.min(1, dot / Math.sqrt(normA * normB)));
}

export function energyReport(input: NumericArray, spectrum: RealSpectrum): EnergyReport {
  validateArray(input);
  if (
    input.length > spectrum.fftSize ||
    spectrum.real.length !== spectrum.fftSize ||
    spectrum.imaginary.length !== spectrum.fftSize
  ) {
    throw new RangeError('Spectrum size does not match the input or its zero-padded length');
  }
  // Validate external spectrum data as well; this report is not a proof that it came from input.
  validateArray(
    spectrum.real,
    'real',
    SOUND_LIMITS.maxFftSize,
    SOUND_LIMITS.maxInputMagnitude * SOUND_LIMITS.maxFftSize,
  );
  validateArray(
    spectrum.imaginary,
    'imaginary',
    SOUND_LIMITS.maxFftSize,
    SOUND_LIMITS.maxInputMagnitude * SOUND_LIMITS.maxFftSize,
  );
  let timeDomainSumSquares = 0;
  let frequencyDomainSumSquares = 0;
  for (let i = 0; i < input.length; i++) timeDomainSumSquares += input[i] ** 2;
  for (let k = 0; k < spectrum.fftSize; k++)
    frequencyDomainSumSquares += spectrum.real[k] ** 2 + spectrum.imaginary[k] ** 2;
  frequencyDomainSumSquares /= spectrum.fftSize;
  const absoluteDifference = Math.abs(timeDomainSumSquares - frequencyDomainSumSquares);
  return {
    timeDomainSumSquares,
    frequencyDomainSumSquares,
    absoluteDifference,
    relativeDifference:
      timeDomainSumSquares === 0 ? absoluteDifference : absoluteDifference / timeDomainSumSquares,
  };
}

export interface SignalAnalysis {
  originalLength: number;
  sampleRateHz: number;
  spectrum: RealSpectrum;
  shortTime: StftResult;
  fftReconstructionError: ReconstructionError;
  stftReconstructionError: ReconstructionError;
  energy: EnergyReport;
  /** Display spacing of the zero-padded DFT, not a claim of added physical resolution. */
  binSpacingHz: number;
  observationDurationSeconds: number;
}

export function analyzeSignal(
  input: NumericArray,
  sampleRateHz: number,
  options: StftOptions = {},
): SignalAnalysis {
  validateArray(input);
  const spectrum = fftPadded(input, sampleRateHz);
  const fftReconstructed = ifft(spectrum).real.slice(0, input.length);
  const shortTime = stft(input, sampleRateHz, options);
  const stftReconstructed = inverseStft(shortTime);
  return {
    originalLength: input.length,
    sampleRateHz,
    spectrum,
    shortTime,
    fftReconstructionError: reconstructionError(input, fftReconstructed),
    stftReconstructionError: reconstructionError(input, stftReconstructed),
    energy: energyReport(input, spectrum),
    binSpacingHz: sampleRateHz / spectrum.fftSize,
    observationDurationSeconds: input.length / sampleRateHz,
  };
}

export interface ReversalComparison {
  originalSpectrum: RealSpectrum;
  reversedSpectrum: RealSpectrum;
  reversedSamples: Float64Array;
  magnitudeCosineDistance: number | null;
  maxMagnitudeDifference: number;
  waveformCosineDistance: number | null;
  semanticInference: 'not-established';
  explanation: string;
}

export function compareTimeReversal(input: NumericArray, sampleRateHz: number): ReversalComparison {
  const reversedSamples = reverseSamples(input);
  const originalSpectrum = fftPadded(input, sampleRateHz);
  const reversedSpectrum = fftPadded(reversedSamples, sampleRateHz);
  let maxMagnitudeDifference = 0;
  for (let k = 0; k < originalSpectrum.magnitude.length; k++) {
    maxMagnitudeDifference = Math.max(
      maxMagnitudeDifference,
      Math.abs(originalSpectrum.magnitude[k] - reversedSpectrum.magnitude[k]),
    );
  }
  return {
    originalSpectrum,
    reversedSpectrum,
    reversedSamples,
    magnitudeCosineDistance: cosineDistance(originalSpectrum.magnitude, reversedSpectrum.magnitude),
    maxMagnitudeDifference,
    waveformCosineDistance: cosineDistance(input, reversedSamples),
    semanticInference: 'not-established',
    explanation:
      'Time reversal of a real sequence preserves its global Fourier magnitude, while phase and temporal order can change. Spectral similarity does not establish shared linguistic meaning.',
  };
}

/** At most maxPoints coordinate pairs for simple SVG plots; not an audio resampler. */
export function plotPoints(
  values: NumericArray,
  step = 1,
  maxPoints = 500,
): Array<{ x: number; y: number }> {
  validateArray(values, 'values', SOUND_LIMITS.maxFftSize, 1e12);
  finite(step, 'step');
  if (step <= 0 || !Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 2_000) {
    throw new RangeError('step must be positive and maxPoints must be an integer in 2..2000');
  }
  const count = Math.min(values.length, maxPoints);
  return Array.from({ length: count }, (_, i) => {
    const index = count === 1 ? 0 : Math.round((i * (values.length - 1)) / (count - 1));
    return { x: index * step, y: values[index] };
  });
}
