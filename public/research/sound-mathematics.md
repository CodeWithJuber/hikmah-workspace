# Sound and graph mathematics for the Hikmah playground

This module makes measurable parts of the proposed architecture inspectable. The signal and graph methods are established mathematics implemented in our own browser code. Their combination with reviewed root senses is an architectural research direction; these transforms do not themselves translate speech or learn meanings.

| Quantity | Definition | Unit or domain |
|---|---|---|
| Acoustic frequency | Oscillation rate in a measured waveform | Hz, cycles per second |
| Lexical frequency | Count or probability of a token in a specified corpus | Count, or dimensionless probability |
| Graph spectral frequency | Eigenvalue of a particular graph operator | Depends on the edge-weight convention; not acoustic Hz |

Sharing the word “frequency” does not supply a mapping between these objects. A learned relationship needs aligned data, a prediction task, and held-out evaluation.

## Signals you can change

For sample rate \(f_s\), sample \(n\) occurs at \(t_n=n/f_s\). The simultaneous two-tone generator uses

\[
x[n]=\frac{a}{2}\bigl(\sin(2\pi f_A t_n)+\sin(2\pi f_B t_n)\bigr).
\]

The sequence generator switches from \(f_A\) to \(f_B\) halfway through, preserving phase at the switch. The chirp uses the integral of a linearly changing frequency:

\[
x[n]=a\sin\left(2\pi\left[f_A t_n+\frac{f_B-f_A}{2T}t_n^2\right]\right).
\]

The interface rejects negative frequencies, frequencies at or above \(f_s/2\), nonfinite numbers, and requests exceeding its sample budget. This avoids deliberately generating aliased test tones. It is not an antialiasing filter for arbitrary uploaded recordings. Duration rounds to a whole number of samples, which the returned metadata reports.

## An invertible representation needs phase

The implementation uses a negative-exponent forward DFT and a normalized inverse:

\[
X[k]=\sum_{n=0}^{N-1}x[n]e^{-2\pi i kn/N},\qquad
x[n]=\frac1N\sum_{k=0}^{N-1}X[k]e^{2\pi i kn/N}.
\]

This is the usual sign convention; FFTW documents the convention while leaving normalization to its caller. Our inverse includes \(1/N\). [FFTW transform definition](https://fftw.org/fftw3_doc/The-1d-Discrete-Fourier-Transform-_0028DFT_0029.html)

The full complex transform is invertible up to numerical error. The displayed magnitude spectrum discards phase and is not generally invertible. For a real sequence reversed as \(y[n]=x[N-1-n]\), substitution gives \(Y[k]=e^{2\pi ik/N}\overline{X[k]}\), hence \(|Y[k]|=|X[k]|\). Reversal can change temporal structure while leaving global magnitudes identical. The playground demonstrates this with a 500→1500 Hz sequence and its reversal.

The FFT runs in \(O(N\log N)\) operations. An arbitrary accepted input is zero-padded to the next power of two. Padding changes plotted bin spacing \(f_s/N\); it adds no new observation. Reported magnitudes are one-sided amplitudes, with DC and Nyquist treated separately. Energy diagnostics use the full coefficients:

\[
\sum_n|x[n]|^2=\frac1N\sum_k|X[k]|^2.
\]

These sums are discrete squared-amplitude quantities, not calibrated physical energy in joules.

## Preserve changes through time

The short-time Fourier transform analyzes overlapping periodic Hann windows:

\[
X_m[k]=\sum_n x[n+mH]w[n]e^{-2\pi ikn/W}.
\]

The returned matrix has time frames as rows and nonnegative frequencies as columns. Larger windows provide finer frequency sampling while averaging over a longer interval. Centered zero padding covers the original boundary samples. Reconstruction retains each frame's complex values, applies the inverse, and divides weighted overlap-add by \(\sum_m w^2[n-mH]\). The denominator must remain nonzero. This condition and reconstruction equation are documented in SciPy's signal reference. [Inverse STFT mathematics](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.istft.html)

Our allowed hop sizes and explicit denominator check support reconstruction of unmodified frames. A magnitude-only heatmap cannot recover the original waveform. Modified spectra may represent a different or inconsistent signal. Reconstruction accuracy validates the numerical representation, not a claim of linguistic understanding.

## Similarity and graph diffusion

Cosine distance is \(1-(u^Tv)/(\|u\|\|v\|)\). It measures the chosen feature arrays. A zero norm returns `null`, because the angle is undefined. Spectral distance can suggest a comparison for later analysis; it cannot authorize an action, establish a root sense, or prove semantic equivalence.

For a small symmetric nonnegative adjacency matrix, the graph branch computes \(L=D-A\). Its eigenvectors satisfy \(Lu_j=\lambda_j u_j\). The Dirichlet energy

\[
f^TLf=\sum_{i<j}a_{ij}(f_i-f_j)^2
\]

measures variation across connected nodes. The heat operator produces

\[
f(\tau)=\sum_j e^{-\tau\lambda_j}(u_j^Tf(0))u_j.
\]

Nonconstant components decay, graph energy decreases, and the sum is conserved within connected components, up to numerical error. Graph spectral constructions have an established research basis. [Hammond, Vandergheynst, and Gribonval](https://arxiv.org/abs/0912.3848)

The lab uses a bounded Jacobi eigensolver and reports eigen residuals and orthogonality error. It accepts at most 32 nodes and rejects directed or negative-weight matrices. Typed semantic relations must remain in the architecture's separate meaning graph. Smoothing numerical scores does not preserve negation, agent/object roles, or logical entailment automatically.

## Verified scope

The accompanying run passed 25 numerical tests: direct-DFT agreement, normalization, inverse recovery, boundary coverage, reversal invariance, invalid inputs, graph eigenvalues, and diffusion invariants. The recorded sequence's maximum FFT and STFT reconstruction errors were approximately \(8.66\times10^{-15}\) and \(2.78\times10^{-15}\). Results are saved in `verification-results.json`.

No audio-recognition model, acoustic-to-root law, training gain, or AGI capability is established. The future architectural experiment is to add sound trajectories to an otherwise equal lexical/contextual system and measure whether they improve independently reviewed meanings and verified task outcomes.
