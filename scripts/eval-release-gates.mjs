#!/usr/bin/env node
/**
 * Evaluate interpret segment metrics against commercial release gates.
 *
 * Usage:
 *   node scripts/eval-release-gates.mjs path/to/translate-metrics.txt
 */

import { readFileSync } from 'node:fs';

const RELEASE_GATES = {
  maxEmptyOutputRate: 0.05,
  maxFallbackRate: 0.15,
  minMeanSttConfidence: 0.72,
  maxP95LatencyMs: 8000,
  maxP50LatencyMs: 3500,
};

function parseMetricsFile(path) {
  const text = readFileSync(path, 'utf8');
  const samples = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      samples.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return samples;
}

function evaluate(samples) {
  const n = samples.length || 1;
  const latencies = samples.map((s) => Number(s.latencyMs) || 0).sort((a, b) => a - b);
  const confidences = samples
    .map((s) => s.sttConfidence)
    .filter((c) => typeof c === 'number');

  const emptyOutputRate = samples.filter((s) => s.emptyOutput === true).length / n;
  const fallbackRate = samples.filter((s) => s.sttPath === 'gemini_audio_fallback').length / n;
  const meanSttConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;
  const p50LatencyMs = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  const failures = [];
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

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/eval-release-gates.mjs <metrics-file>');
  process.exit(2);
}

const samples = parseMetricsFile(file);
if (samples.length === 0) {
  console.error('No metric samples found in file.');
  process.exit(2);
}

const result = evaluate(samples);

console.log('Benchmark aggregate:');
console.log(JSON.stringify(result, null, 2));

if (!result.passed) {
  console.error('\nRelease gates FAILED:');
  for (const f of result.failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('\nRelease gates PASSED.');
process.exit(0);
