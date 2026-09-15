'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  generateSignal,
  analyzeSignal,
  compareTimeReversal,
  type SignalMode,
} from '@/lib/engines/sound-math';
import { Choice, Notice, Metric, Equation, errorMessage, downloadJson } from './common';
function LineChart({
  values,
  max = 1,
  color = '#2457dc',
}: {
  values: ArrayLike<number>;
  max?: number;
  color?: string;
}) {
  const n = values.length;
  const pts = Array.from({ length: Math.min(n, 900) }, (_, i) => {
    const start = Math.floor((i * n) / Math.min(n, 900));
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / Math.min(n, 900)));
    let v = values[start];
    for (let j = start + 1; j < end; j++) if (Math.abs(values[j]) > Math.abs(v)) v = values[j];
    return `${((i / (Math.min(n, 900) - 1)) * 720).toFixed(2)},${(90 - (v / max) * 78).toFixed(2)}`;
  }).join(' ');
  return (
    <svg className="chart" viewBox="0 0 720 180" role="img" aria-label="Computed signal plot">
      <path d="M0 90H720" stroke="#dde3eb" fill="none" />
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} />
    </svg>
  );
}
function Spectrogram({ analysis }: { analysis: ReturnType<typeof analyzeSignal> }) {
  const s = analysis.shortTime;
  const frames = Math.min(90, s.magnitude.length);
  const bins = Math.min(64, s.frequenciesHz.length);
  let peak = 0;
  for (const row of s.magnitude) for (const v of row) peak = Math.max(peak, v);
  const cells = [];
  for (let t = 0; t < frames; t++)
    for (let f = 0; f < bins; f++) {
      let m = 0;
      const from = Math.floor((f * s.frequenciesHz.length) / bins),
        to = Math.floor(((f + 1) * s.frequenciesHz.length) / bins);
      const row = s.magnitude[Math.floor((t * s.magnitude.length) / frames)];
      for (let k = from; k < to; k++) m = Math.max(m, row[k]);
      const normalized = peak
        ? Math.max(0, 1 + (20 * Math.log10(Math.max(m, 1e-12) / peak)) / 65)
        : 0;
      const r = Math.round(247 - 213 * normalized),
        g = Math.round(249 - 170 * normalized),
        b = Math.round(252 - 57 * normalized);
      cells.push(
        <rect
          key={`${t}-${f}`}
          x={(t * 720) / frames}
          y={((bins - f - 1) * 170) / bins}
          width={720 / frames + 0.2}
          height={170 / bins + 0.2}
          fill={`rgb(${r},${g},${b})`}
        />,
      );
    }
  return (
    <svg
      className="chart"
      viewBox="0 0 720 170"
      role="img"
      aria-label="Short-time frequency magnitude, time increases to the right, frequency upwards"
    >
      {cells}
    </svg>
  );
}
export function SoundLab() {
  const [mode, setMode] = useState<SignalMode>('sequence');
  const [a, setA] = useState(500);
  const [b, setB] = useState(1500);
  const [duration, setDuration] = useState(0.512);
  const [reverse, setReverse] = useState(false);
  const [windowSize, setWindowSize] = useState('256');
  const [uploaded, setUploaded] = useState<{
    samples: Float64Array;
    sampleRateHz: number;
    name: string;
    duration: number;
    channels: number;
  } | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  useEffect(
    () => () => {
      void audioRef.current?.close();
    },
    [],
  );
  const data = useMemo(() => {
    try {
      const signal = uploaded
        ? {
            samples: reverse ? uploaded.samples.slice().reverse() : uploaded.samples,
            sampleRateHz: uploaded.sampleRateHz,
          }
        : generateSignal({
            mode,
            frequencyAHz: a,
            frequencyBHz: b,
            durationSeconds: duration,
            sampleRateHz: 8000,
            reverse,
            amplitude: 0.7,
          });
      return {
        signal,
        analysis: analyzeSignal(signal.samples, signal.sampleRateHz, {
          windowSize: Number(windowSize),
          hopSize: Number(windowSize) / 4,
        }),
        reversal: compareTimeReversal(signal.samples, signal.sampleRateHz),
      };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }, [uploaded, mode, a, b, duration, reverse, windowSize]);
  const play = async () => {
    try {
      if (!data.signal) return;
      if (audioRef.current) await audioRef.current.close();
      const ctx = new AudioContext();
      audioRef.current = ctx;
      await ctx.resume();
      const buffer = ctx.createBuffer(1, data.signal.samples.length, data.signal.sampleRateHz);
      buffer.getChannelData(0).set(data.signal.samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 0.2;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = () => {
        setPlaying(false);
        void ctx.close();
        if (audioRef.current === ctx) audioRef.current = null;
      };
      setPlaying(true);
      source.start();
      setError('');
    } catch (e) {
      setError(errorMessage(e));
      setPlaying(false);
    }
  };
  const upload = async (file: File) => {
    try {
      if (file.size > 2000000) throw Error('Choose an audio file under 2 MB.');
      const bytes = await file.arrayBuffer();
      const ctx = new AudioContext();
      try {
        const decoded = await ctx.decodeAudioData(bytes);
        if (decoded.duration > 30) throw Error('Choose a clip up to 30 seconds.');
        const samples = Float64Array.from(decoded.getChannelData(0).slice(0, 65536));
        setUploaded({
          samples,
          sampleRateHz: decoded.sampleRate,
          name: file.name,
          duration: decoded.duration,
          channels: decoded.numberOfChannels,
        });
        setReverse(false);
        setError('');
      } finally {
        await ctx.close();
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const analysis = data.analysis;
  const signal = data.signal;
  const reversal = data.reversal;
  const peaks = analysis
    ? Array.from(analysis.spectrum.magnitude)
        .map((m, i) => ({ m, hz: analysis.spectrum.frequenciesHz[i] }))
        .sort((x, y) => y.m - x.m)
        .slice(0, 3)
    : [];
  return (
    <>
      <div className="fields">
        <Choice
          label="Signal"
          value={mode}
          onChange={(v) => {
            setMode(v as SignalMode);
            setUploaded(null);
          }}
          options={[
            { value: 'sequence', label: 'Tone A, then tone B' },
            { value: 'two-tone', label: 'Two simultaneous tones' },
            { value: 'chirp', label: 'Continuous frequency sweep' },
          ]}
        />
        <Choice
          label="STFT window"
          value={windowSize}
          onChange={setWindowSize}
          options={['128', '256', '512', '1024'].map((v) => ({ value: v, label: v + ' samples' }))}
        />
      </div>
      <div className="sound-controls">
        {[
          { label: 'Frequency A', value: a, set: setA },
          { label: 'Frequency B', value: b, set: setB },
        ].map((c) => (
          <div className="field" key={c.label}>
            <div className="number-row">
              <span>{c.label}</span>
              <output>{c.value} Hz</output>
            </div>
            <Slider
              aria-label={c.label}
              value={[c.value]}
              onValueChange={([v]) => c.set(v)}
              min={100}
              max={3500}
              step={25}
              disabled={!!uploaded}
            />
          </div>
        ))}
        <div className="field">
          <div className="number-row">
            <span>Duration</span>
            <output>
              {uploaded
                ? (uploaded.samples.length / uploaded.sampleRateHz).toFixed(3)
                : duration.toFixed(3)}{' '}
              s
            </output>
          </div>
          <Slider
            aria-label="Signal duration"
            value={[duration]}
            min={0.128}
            max={2}
            step={0.128}
            onValueChange={([v]) => setDuration(v)}
            disabled={!!uploaded}
          />
        </div>
      </div>
      <div className="actions">
        <Button onClick={play} disabled={playing || !signal}>
          {playing ? 'Playing…' : 'Play signal'}
        </Button>
        <Button
          variant="outline"
          disabled={!playing}
          onClick={() => {
            void audioRef.current?.close();
            audioRef.current = null;
            setPlaying(false);
          }}
        >
          Stop audio
        </Button>
        <label className="check-row">
          <Checkbox
            aria-label="Reverse time"
            checked={reverse}
            onCheckedChange={(v) => setReverse(!!v)}
          />
          Reverse time
        </label>
        <span className="small-note">Playback volume: 20%</span>
      </div>
      {(error || data.error) && <Notice error>{error || data.error}</Notice>}
      {analysis && signal && reversal && (
        <>
          <div className="two-columns section">
            <section>
              <h2>Waveform</h2>
              <LineChart
                values={signal.samples.slice(0, Math.min(256, signal.samples.length))}
                max={1}
              />
              <div className="chart-caption">
                <span>First {Math.min(256, signal.samples.length)} samples</span>
                <span>
                  {((Math.min(256, signal.samples.length) / signal.sampleRateHz) * 1000).toFixed(1)}{' '}
                  ms
                </span>
              </div>
            </section>
            <section>
              <h2>Frequency magnitude</h2>
              <LineChart
                values={analysis.spectrum.magnitude}
                max={Math.max(1e-9, ...analysis.spectrum.magnitude)}
              />
              <div className="chart-caption">
                <span>0 Hz</span>
                <span>{signal.sampleRateHz / 2} Hz</span>
              </div>
              <p className="small-note" style={{ marginTop: 12 }}>
                Strongest bins: {peaks.map((p) => p.hz.toFixed(1) + ' Hz').join(', ')}. Bin spacing{' '}
                {analysis.binSpacingHz.toFixed(2)} Hz.
              </p>
            </section>
          </div>
          <section className="chart-block">
            <h2>Frequency over time</h2>
            <Spectrogram analysis={analysis} />
            <div className="chart-caption">
              <span>Time → · frequency ↑ to {signal.sampleRateHz / 2} Hz</span>
              <span>
                {(signal.samples.length / signal.sampleRateHz).toFixed(3)} seconds · darker =
                stronger
              </span>
            </div>
          </section>
          <div className="metric-row section">
            <Metric
              value={analysis.fftReconstructionError.maxAbsoluteError.toExponential(2)}
              label="FFT inverse maximum error"
            />
            <Metric
              value={analysis.energy.relativeDifference.toExponential(2)}
              label="Parseval relative error"
            />
            <Metric
              value={
                reversal.magnitudeCosineDistance === null
                  ? 'Undefined'
                  : reversal.magnitudeCosineDistance.toExponential(2)
              }
              label="reversal magnitude distance"
            />
          </div>
          <Notice>
            Reverse time and watch the spectrogram. The global magnitude spectrum can remain almost
            identical while the order of sounds changes. This is an acoustic comparison; it does not
            measure semantic similarity.
          </Notice>
          <div className="actions">
            <Button
              variant="outline"
              onClick={() =>
                downloadJson(
                  {
                    source: uploaded?.name ?? 'synthetic',
                    sampleRateHz: signal.sampleRateHz,
                    samples: signal.samples.length,
                    windowSize: analysis.shortTime.windowSize,
                    frequenciesHz: Array.from(analysis.spectrum.frequenciesHz),
                    magnitude: Array.from(analysis.spectrum.magnitude),
                    phaseRadians: Array.from(analysis.spectrum.phaseRadians),
                    fftError: analysis.fftReconstructionError,
                    stftError: analysis.stftReconstructionError,
                    energy: analysis.energy,
                    reversal,
                  },
                  'hikmah-sound-results.json',
                )
              }
            >
              Export calculations
            </Button>
          </div>
        </>
      )}
      <section className="audio-upload">
        <h3>Test your own audio</h3>
        <p className="small-note">
          Audio stays in this browser. Maximum file: 2 MB, duration: 30 seconds. The first channel
          and first 65,536 samples are analyzed at the decoded sample rate; longer clips are
          cropped.
        </p>
        <Input
          aria-label="Upload audio"
          type="file"
          accept="audio/*"
          style={{ marginTop: 14 }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
        {uploaded && (
          <Notice>
            {uploaded.name} · original {uploaded.duration.toFixed(2)} s, {uploaded.channels}{' '}
            channels · channel 1 · analyzing{' '}
            {(uploaded.samples.length / uploaded.sampleRateHz).toFixed(3)} s at{' '}
            {uploaded.sampleRateHz} Hz.
            <div className="actions">
              <Button variant="outline" onClick={() => setUploaded(null)}>
                Return to synthetic signal
              </Button>
            </div>
          </Notice>
        )}
      </section>
      <details className="disclosure">
        <summary>Sound mathematics and limits</summary>
        <Equation description="The complex transform retains phase. Its magnitude alone cannot reconstruct the full temporal signal.">
          X[k] = Σₙ x[n] exp(−2πikn/N)
        </Equation>
        <Equation description="The short-time Fourier transform keeps a local time coordinate using overlapping Hann windows. Window size trades temporal detail against frequency detail.">
          X[m,k] = Σₙ x[n] w[n−mH] exp(−2πikn/N)
        </Equation>
        <p className="small-note">
          Graph frequencies are eigenvalues of a graph operator, not acoustic hertz. Sound patterns
          can have statistical language associations, but this experiment establishes no universal
          frequency-to-root dictionary. No speech recognizer or trained acoustic meaning model is
          included.
        </p>
      </details>
    </>
  );
}
