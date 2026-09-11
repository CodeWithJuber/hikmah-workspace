/** Standard spectral methods on a small undirected weighted graph. */
export const GRAPH_LIMITS = Object.freeze({
  maxNodes: 32,
  maxWeight: 1_000_000,
  maxSignalMagnitude: 1_000_000,
});

export interface GraphSpectrum {
  laplacian: number[][];
  /** Ascending eigenvalues of L = D - A. Graph units, not acoustic Hz. */
  eigenvalues: number[];
  /** eigenvectors[mode][node]; each mode has Euclidean unit norm. */
  eigenvectors: number[][];
  maxEigenResidual: number;
  maxOrthogonalityError: number;
  jacobiRotations: number;
}

function validatedAdjacency(input: readonly (readonly number[])[]): number[][] {
  if (!Array.isArray(input) || input.length < 1 || input.length > GRAPH_LIMITS.maxNodes) {
    throw new RangeError(`Graph must have 1..${GRAPH_LIMITS.maxNodes} nodes`);
  }
  const n = input.length;
  for (let i = 0; i < n; i++) {
    if (!Array.isArray(input[i]) || input[i].length !== n)
      throw new RangeError('Adjacency must be square');
    for (let j = 0; j < n; j++) {
      if (
        !Number.isFinite(input[i][j]) ||
        input[i][j] < 0 ||
        input[i][j] > GRAPH_LIMITS.maxWeight
      ) {
        throw new RangeError(
          'Adjacency weights must be finite, nonnegative, and within the weight cap',
        );
      }
      if (i === j && input[i][j] !== 0)
        throw new RangeError('Use zero diagonal; self-loops are excluded in this lab');
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (input[i][j] !== input[j][i])
        throw new RangeError(
          'Adjacency must be exactly symmetric; directed edges are not silently converted',
        );
    }
  }
  return input.map((row) => Array.from(row));
}

export function graphLaplacian(adjacency: readonly (readonly number[])[]): number[][] {
  const a = validatedAdjacency(adjacency);
  return a.map((row, i) =>
    row.map((weight, j) =>
      i === j ? row.reduce((sum, value) => sum + value, 0) : weight === 0 ? 0 : -weight,
    ),
  );
}

/** Bounded largest-pivot Jacobi eigensolver, with numerical diagnostics. */
export function graphSpectrum(adjacency: readonly (readonly number[])[]): GraphSpectrum {
  const laplacian = graphLaplacian(adjacency);
  const n = laplacian.length;
  const a = laplacian.map((row) => row.slice());
  const vectors = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => Number(i === j)),
  );
  const scale = Math.max(...a.flat().map(Math.abs));
  const tolerance = scale * 1e-12;
  const maxRotations = 50 * n * n;
  let rotations = 0;
  let converged = false;
  while (rotations < maxRotations) {
    let p = 0;
    let q = 0;
    let maxOffDiagonal = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(a[i][j]) > maxOffDiagonal) {
          maxOffDiagonal = Math.abs(a[i][j]);
          p = i;
          q = j;
        }
      }
    if (maxOffDiagonal <= tolerance) {
      converged = true;
      break;
    }
    const apq = a[p][q];
    const tau = (a[q][q] - a[p][p]) / (2 * apq);
    // hypot prevents tau^2 overflow for disparate values.
    const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.hypot(1, tau));
    const c = 1 / Math.hypot(1, t);
    const s = t * c;
    a[p][p] -= t * apq;
    a[q][q] += t * apq;
    a[p][q] = 0;
    a[q][p] = 0;
    for (let k = 0; k < n; k++) {
      if (k !== p && k !== q) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = a[p][k] = c * akp - s * akq;
        a[k][q] = a[q][k] = s * akp + c * akq;
      }
      const vkp = vectors[k][p];
      const vkq = vectors[k][q];
      vectors[k][p] = c * vkp - s * vkq;
      vectors[k][q] = s * vkp + c * vkq;
    }
    rotations++;
  }
  if (!converged)
    throw new RangeError('Jacobi eigensolver did not converge within its rotation budget');
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j]);
  const eigenvalues = order.map((i) => (Math.abs(a[i][i]) < tolerance ? 0 : a[i][i]));
  const eigenvectors = order.map((i) => vectors.map((row) => row[i]));
  let maxEigenResidual = 0;
  let maxOrthogonalityError = 0;
  for (let mode = 0; mode < n; mode++) {
    for (let node = 0; node < n; node++) {
      const lv = laplacian[node].reduce((sum, value, j) => sum + value * eigenvectors[mode][j], 0);
      maxEigenResidual = Math.max(
        maxEigenResidual,
        Math.abs(lv - eigenvalues[mode] * eigenvectors[mode][node]),
      );
    }
    for (let other = 0; other < n; other++) {
      const dot = eigenvectors[mode].reduce(
        (sum, value, j) => sum + value * eigenvectors[other][j],
        0,
      );
      maxOrthogonalityError = Math.max(
        maxOrthogonalityError,
        Math.abs(dot - Number(mode === other)),
      );
    }
  }
  return {
    laplacian,
    eigenvalues,
    eigenvectors,
    maxEigenResidual,
    maxOrthogonalityError,
    jacobiRotations: rotations,
  };
}

function validateGraphSignal(signal: readonly number[], size: number): void {
  if (!Array.isArray(signal) || signal.length !== size) {
    throw new RangeError('Graph signal must have one finite, bounded value per node');
  }
  // An indexed loop also rejects sparse-array holes, which Array.some skips.
  for (let i = 0; i < size; i++)
    if (!Number.isFinite(signal[i]) || Math.abs(signal[i]) > GRAPH_LIMITS.maxSignalMagnitude) {
      throw new RangeError('Graph signal must have one finite, bounded value per node');
    }
}

export function graphDirichletEnergy(
  adjacency: readonly (readonly number[])[],
  signal: readonly number[],
): number {
  const a = validatedAdjacency(adjacency);
  validateGraphSignal(signal, a.length);
  let result = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      result += a[i][j] * (signal[i] - signal[j]) ** 2;
    }
  return result;
}

export interface GraphDiffusion {
  spectrum: GraphSpectrum;
  initialSignal: number[];
  diffusedSignal: number[];
  coefficients: number[];
  attenuatedCoefficients: number[];
  diffusionTime: number;
  energyBefore: number;
  energyAfter: number;
  sumBefore: number;
  sumAfter: number;
  semantics: 'numeric-diffusion-only';
}

/** Exact spectral heat solution for this small operator, up to numerical error. */
export function diffuseGraph(
  adjacency: readonly (readonly number[])[],
  signal: readonly number[],
  diffusionTime: number,
): GraphDiffusion {
  if (!Number.isFinite(diffusionTime) || diffusionTime < 0 || diffusionTime > 1_000_000) {
    throw new RangeError('diffusionTime must be finite and in [0, 1000000]');
  }
  const spectrum = graphSpectrum(adjacency);
  validateGraphSignal(signal, spectrum.eigenvalues.length);
  const coefficients = spectrum.eigenvectors.map((vector) =>
    vector.reduce((sum, value, node) => sum + value * signal[node], 0),
  );
  const attenuatedCoefficients = coefficients.map(
    (value, mode) => value * Math.exp(-diffusionTime * Math.max(0, spectrum.eigenvalues[mode])),
  );
  const diffusedSignal = signal.map((_, node) =>
    spectrum.eigenvectors.reduce(
      (sum, vector, mode) => sum + vector[node] * attenuatedCoefficients[mode],
      0,
    ),
  );
  return {
    spectrum,
    initialSignal: Array.from(signal),
    diffusedSignal,
    coefficients,
    attenuatedCoefficients,
    diffusionTime,
    energyBefore: graphDirichletEnergy(adjacency, signal),
    energyAfter: graphDirichletEnergy(adjacency, diffusedSignal),
    sumBefore: signal.reduce((sum, value) => sum + value, 0),
    sumAfter: diffusedSignal.reduce((sum, value) => sum + value, 0),
    semantics: 'numeric-diffusion-only',
  };
}
