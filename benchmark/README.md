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

## Burmese STT (WhisperWarp-aligned)

Primary Burmese transcription uses **ElevenLabs Scribe v2** (same approach as WhisperWarp), with Google Chirp as fallback.

Edge Function secrets:

```bash
ELEVENLABS_API_KEY=your_key_here
ELEVENLABS_STT_MODEL=scribe_v2
ELEVENLABS_MYANMAR_KEYTERMS=မြန်မာ,ရန်ကုန်
```

Without `ELEVENLABS_API_KEY`, the pipeline falls back to Google Speech-to-Text Chirp (`my-MM`).

English response audio (`/response-audio`) uses **Groq Whisper** (`whisper-large-v3`) when `GROQ_API_KEY` is set — same batch provider as WhisperWarp — with Google Chirp as fallback.

```bash
GROQ_API_KEY=your_key_here
GROQ_MODEL=whisper-large-v3
GROQ_EN_PROMPT=Optional English context prompt
```

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
