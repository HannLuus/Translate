/** Per-segment pipeline diagnostics returned to client and logged server-side. */
export interface InterpretDiagnostics {
  latencyMs: number;
  sttConfidence: number | null;
  sttPath: 'speech_api' | 'speech_api_refined' | 'gemini_audio_fallback';
  fallbackReason: string | null;
  emptyOutput: boolean;
  secondPassUsed: boolean;
}

export function createDiagnostics(
  startedAt: number,
  partial: Omit<InterpretDiagnostics, 'latencyMs' | 'emptyOutput'>,
  burmeseText: string,
  englishText: string,
): InterpretDiagnostics {
  return {
    ...partial,
    latencyMs: Date.now() - startedAt,
    emptyOutput: !burmeseText.trim() && !englishText.trim(),
  };
}

export function logInterpretMetrics(diagnostics: InterpretDiagnostics): void {
  console.info('[interpret-metrics]', JSON.stringify(diagnostics));
}

/** Release gate thresholds for benchmark evaluation. */
export const RELEASE_GATES = {
  maxEmptyOutputRate: 0.05,
  maxFallbackRate: 0.15,
  minMeanSttConfidence: 0.72,
  maxP95LatencyMs: 8000,
  maxP50LatencyMs: 3500,
} as const;

export interface BenchmarkAggregate {
  sampleCount: number;
  emptyOutputRate: number;
  fallbackRate: number;
  meanSttConfidence: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  passed: boolean;
  failures: string[];
}

export function evaluateReleaseGates(samples: InterpretDiagnostics[]): BenchmarkAggregate {
  const n = samples.length || 1;
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const confidences = samples
    .map((s) => s.sttConfidence)
    .filter((c): c is number => c != null);

  const emptyOutputRate = samples.filter((s) => s.emptyOutput).length / n;
  const fallbackRate = samples.filter((s) => s.sttPath === 'gemini_audio_fallback').length / n;
  const meanSttConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;
  const p50LatencyMs = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  const failures: string[] = [];
  if (emptyOutputRate > RELEASE_GATES.maxEmptyOutputRate) {
    failures.push(`emptyOutputRate ${emptyOutputRate.toFixed(3)} > ${RELEASE_GATES.maxEmptyOutputRate}`);
  }
  if (fallbackRate > RELEASE_GATES.maxFallbackRate) {
    failures.push(`fallbackRate ${fallbackRate.toFixed(3)} > ${RELEASE_GATES.maxFallbackRate}`);
  }
  if (meanSttConfidence < RELEASE_GATES.minMeanSttConfidence) {
    failures.push(`meanSttConfidence ${meanSttConfidence.toFixed(3)} < ${RELEASE_GATES.minMeanSttConfidence}`);
  }
  if (p50LatencyMs > RELEASE_GATES.maxP50LatencyMs) {
    failures.push(`p50LatencyMs ${p50LatencyMs} > ${RELEASE_GATES.maxP50LatencyMs}`);
  }
  if (p95LatencyMs > RELEASE_GATES.maxP95LatencyMs) {
    failures.push(`p95LatencyMs ${p95LatencyMs} > ${RELEASE_GATES.maxP95LatencyMs}`);
  }

  return {
    sampleCount: samples.length,
    emptyOutputRate,
    fallbackRate,
    meanSttConfidence,
    p50LatencyMs,
    p95LatencyMs,
    passed: failures.length === 0,
    failures,
  };
}
