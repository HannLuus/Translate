# Burmese Interpret Benchmark and Release Gates

Use this flow to validate commercial readiness before promoting pipeline changes.

## 1) Capture live metrics from the app

1. Start interpretation in the PWA.
2. Run a representative meeting sample (noisy room, Burmese speaker, glossary enabled).
3. Click **Download metrics log** in the app footer.

Each line is one segment diagnostic JSON with:

- `latencyMs`
- `sttConfidence`
- `sttPath` (`speech_api`, `speech_api_refined`, `gemini_audio_fallback`)
- `fallbackReason`
- `emptyOutput`
- `secondPassUsed`

## 2) Evaluate release gates

From repo root:

```bash
node scripts/eval-release-gates.mjs path/to/translate-metrics-*.txt
```

The script prints aggregate stats and exits non-zero when thresholds fail.

## Release gate thresholds

| Metric | Threshold |
|--------|-----------|
| Empty output rate | <= 5% |
| Gemini audio fallback rate | <= 15% |
| Mean STT confidence | >= 0.72 |
| p50 latency | <= 3500 ms |
| p95 latency | <= 8000 ms |

Thresholds are defined in:

- Backend: [`supabase/functions/_shared/metrics.ts`](../supabase/functions/_shared/metrics.ts)
- Eval script: [`scripts/eval-release-gates.mjs`](../scripts/eval-release-gates.mjs)

## 3) Rollout flags

Frontend capture flags (localStorage):

- `interpreter-adaptive-vad` (`1` on, `0` off)
- `interpreter-overlap-chunks` (`1` on, `0` off)

Backend Edge Function secrets:

- `CONFIDENCE_ROUTING` (`0` disables confidence gate)
- `SECOND_PASS_REFINE` (`0` disables second-pass STT)

## Recommended promotion sequence

1. Enable adaptive VAD + overlap in staging.
2. Enable confidence routing + second-pass refine.
3. Run benchmark pack and confirm release gates pass.
4. Promote to production cohort, monitor fallback/latency for 24h.
