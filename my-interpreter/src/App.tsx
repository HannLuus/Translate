import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { PlatformSelector } from './components/PlatformSelector';
import { PermissionChecker, checkPermissions } from './components/PermissionChecker';
import { ConversationView } from './components/ConversationView';
import { WavizVisualizer } from './components/WavizVisualizer';
import { ResponseButton } from './components/ResponseButton';
import { ScenarioProfilePanel } from './components/ScenarioProfilePanel';
import { getCaptureStream, captureAudioChunks } from './audioCapture';
import { interpretAudio, healthCheck, getApiBase, cleanAndSummarize, appendInterpretMetrics, getInterpretMetrics, clearInterpretMetrics } from './api';
import { requestWakeLock, releaseWakeLock } from './wakeLock';
import { extractNewSuffix, isDuplicateSegment } from './textMerge';
import type { CaptureMode, PermissionState, TermLockMap, TranslationSegment, CleanSummarizeResult, GlossaryEntry, ScenarioProfile } from './types';
import './App.css';

function mergeSegmentText(candidate: string, lastLine: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (!lastLine.trim()) return trimmed;
  if (isDuplicateSegment(trimmed, lastLine)) return null;
  return extractNewSuffix(trimmed, lastLine);
}

const MODE_STORAGE_KEY = 'interpreter-capture-mode';
const LOOPBACK_STORAGE_KEY = 'interpreter-loopback-device-id';
const TESTING_MODE_STORAGE_KEY = 'interpreter-testing-mode';
const USE_GLOSSARY_BRIEFING_STORAGE_KEY = 'interpreter-use-glossary-briefing';
const SCENARIO_PROFILES_KEY = 'interpreter-scenario-profiles';
const ACTIVE_PROFILE_ID_KEY = 'interpreter-active-profile-id';

type ErrorLogEntry = { timestamp: string; type: string; message: string };

function parseLegacyGlossary(raw: string): GlossaryEntry[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e.term === 'string' && typeof e.meaning === 'string')) {
      return parsed.map((e) => ({ id: e.id ?? Date.now() + Math.random(), term: e.term.trim(), meaning: e.meaning.trim() }));
    }
  } catch { /* fall through */ }
  const entries: GlossaryEntry[] = [];
  const lines = raw.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(.+?)\s*[=:]\s*(.+)$/);
    if (match) entries.push({ id: Date.now() + Math.random(), term: match[1].trim(), meaning: match[2].trim() });
  }
  return entries;
}

function loadProfiles(): ScenarioProfile[] {
  const stored = localStorage.getItem(SCENARIO_PROFILES_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as ScenarioProfile[];
    } catch { /* fall through */ }
  }
  const oldBriefing = localStorage.getItem('interpreter-meeting-context') ?? '';
  const oldGlossaryRaw = localStorage.getItem('interpreter-permanent-glossary');
  const oldGlossary: GlossaryEntry[] = oldGlossaryRaw ? parseLegacyGlossary(oldGlossaryRaw) : [];
  return [{ id: 'profile-default', name: 'My Default', briefing: oldBriefing, glossary: oldGlossary, createdAt: Date.now() }];
}

function loadActiveProfileId(profiles: ScenarioProfile[]): string {
  const stored = localStorage.getItem(ACTIVE_PROFILE_ID_KEY);
  if (stored && profiles.find((p) => p.id === stored)) return stored;
  return profiles[0].id;
}

function glossaryEntriesToText(entries: GlossaryEntry[]): string {
  return entries
    .filter((e) => e.term.trim() || e.meaning.trim())
    .map((e) => `${e.term.trim() || '(term)'} = ${e.meaning.trim() || '(meaning)'}`)
    .join('\n');
}

function App() {
  const errorLogRef = useRef<ErrorLogEntry[]>([]);

  const pushErrorLog = useCallback((type: string, message: string) => {
    errorLogRef.current.push({
      timestamp: new Date().toISOString(),
      type,
      message,
    });
  }, []);

  const [profiles, setProfiles] = useState<ScenarioProfile[]>(loadProfiles);
  const [activeProfileId, setActiveProfileId] = useState<string>(() => loadActiveProfileId(profiles));
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];

  const [useGlossaryAndBriefing, setUseGlossaryAndBriefing] = useState(() => {
    const stored = localStorage.getItem(USE_GLOSSARY_BRIEFING_STORAGE_KEY);
    return stored !== '0';
  });

  const [mode, setMode] = useState<CaptureMode>(() => {
    const s = localStorage.getItem(MODE_STORAGE_KEY);
    return (s === 'desktop' || s === 'rooted_android' || s === 'face_to_face')
      ? s
      : 'face_to_face';
  });
  const [loopbackDeviceId, setLoopbackDeviceId] = useState(() => {
    return localStorage.getItem(LOOPBACK_STORAGE_KEY) ?? '';
  });
  const [testingMode, setTestingMode] = useState(() => {
    const stored = localStorage.getItem(TESTING_MODE_STORAGE_KEY);
    return stored !== '0';
  });
  const [permissionState, setPermissionState] = useState<PermissionState>({
    tabAudio: 'unknown',
    microphone: 'unknown',
  });
  const [translationSegments, setTranslationSegments] = useState<TranslationSegment[]>([]);
  const segmentIdRef = useRef(0);
  const [isPlayingTts, setIsPlayingTts] = useState(false);
  const [playTtsEnabled, setPlayTtsEnabled] = useState(false);
  const [playResponseTtsEnabled, setPlayResponseTtsEnabled] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<'unknown' | 'ok' | 'unreachable'>('unknown');
  const [backendError, setBackendError] = useState<string | null>(null);
  const [captureStream, setCaptureStream] = useState<MediaStream | null>(null);
  const [interpretStatus, setInterpretStatus] = useState<'idle' | 'listening' | 'processing'>('idle');
  const [cleanSummarizeStatus, setCleanSummarizeStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [cleanSummarizeResult, setCleanSummarizeResult] = useState<CleanSummarizeResult | null>(null);
  const [cleanSummarizeError, setCleanSummarizeError] = useState<string | null>(null);
  const stopCaptureRef = useRef<(() => void) | null>(null);
  const interpretQueueRef = useRef<ArrayBuffer[]>([]);
  const interpretDrainingRef = useRef(false);
  const currentTtsRef = useRef<HTMLAudioElement | null>(null);
  /** Last 2–3 translation segments for continuity (sent to backend). */
  const recentContextRef = useRef<string>('');
  const termLockRef = useRef<TermLockMap>({});

  useEffect(() => {
    checkPermissions().then(setPermissionState);
  }, []);

  useEffect(() => {
    const apiBase = getApiBase();
    console.log('[Translate] Backend:', apiBase);
    setBackendError(null);
    healthCheck().then(({ ok, error: err }: { ok: boolean; error?: string }) => {
      if (ok) {
        setBackendStatus('ok');
        console.log('[Translate] Backend OK');
      } else {
        setBackendStatus('unreachable');
        const msg = err ?? 'Unknown';
        setBackendError(msg);
        pushErrorLog('warn', `Backend unreachable: ${msg}`);
        console.warn('[Translate] Backend unreachable:', err);
      }
    });
  }, [pushErrorLog]);

  useEffect(() => {
    const rerequest = () => {
      if (document.visibilityState === 'visible' && active) requestWakeLock();
    };
    document.addEventListener('visibilitychange', rerequest);
    return () => document.removeEventListener('visibilitychange', rerequest);
  }, [active]);

  useEffect(() => {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);
  useEffect(() => {
    localStorage.setItem(LOOPBACK_STORAGE_KEY, loopbackDeviceId);
  }, [loopbackDeviceId]);
  useEffect(() => {
    localStorage.setItem(TESTING_MODE_STORAGE_KEY, testingMode ? '1' : '0');
  }, [testingMode]);
  useEffect(() => {
    localStorage.setItem(SCENARIO_PROFILES_KEY, JSON.stringify(profiles));
  }, [profiles]);
  useEffect(() => {
    localStorage.setItem(ACTIVE_PROFILE_ID_KEY, activeProfileId);
  }, [activeProfileId]);
  useEffect(() => {
    localStorage.setItem(USE_GLOSSARY_BRIEFING_STORAGE_KEY, useGlossaryAndBriefing ? '1' : '0');
  }, [useGlossaryAndBriefing]);

  const playTts = useCallback((base64: string) => {
    if (currentTtsRef.current) {
      currentTtsRef.current.pause();
      currentTtsRef.current = null;
    }
    const audio = new Audio('data:audio/mp3;base64,' + base64);
    currentTtsRef.current = audio;
    setIsPlayingTts(true);
    audio.play();
    audio.onended = () => {
      currentTtsRef.current = null;
      setIsPlayingTts(false);
    };
  }, []);

  const startInterpretation = useCallback(async () => {
    setError(null);
    if (mode === 'rooted_android' && !loopbackDeviceId.trim()) {
      const msg = 'Enter a loopback device ID for Rooted Android, or switch to Face-to-Face (Mic) mode.';
      setError(msg);
      pushErrorLog('error', msg);
      return;
    }
    try {
      setTranslationSegments([]);
      recentContextRef.current = '';
      termLockRef.current = {};
      clearInterpretMetrics();
      const stream = await getCaptureStream(
        mode,
        mode === 'rooted_android' ? loopbackDeviceId.trim() || undefined : undefined
      );
      setCaptureStream(stream);
      setActive(true);
      setInterpretStatus('listening');
      await requestWakeLock();

        const drainInterpretQueue = async () => {
          if (interpretDrainingRef.current) return;
          interpretDrainingRef.current = true;
          setInterpretStatus('processing');
          const combinedContext = useGlossaryAndBriefing
            ? [glossaryEntriesToText(activeProfile.glossary), activeProfile.briefing.trim()].filter(Boolean).join('\n\n')
            : '';
          while (interpretQueueRef.current.length > 0) {
            const pcm = interpretQueueRef.current.shift()!;
            try {
              const result = await interpretAudio(pcm, combinedContext || undefined, termLockRef.current);
              if (result.termLock) termLockRef.current = result.termLock;
              if (result.diagnostics) appendInterpretMetrics(result.diagnostics);

              const englishLine = result.englishText ?? '';
              if (englishLine) {
                setTranslationSegments((prev) => {
                  const lastText = prev[prev.length - 1]?.text ?? '';
                  const merged = mergeSegmentText(englishLine, lastText);
                  if (!merged) return prev;
                  const ctx = recentContextRef.current;
                  recentContextRef.current = (ctx ? ctx + '\n' + merged : merged)
                    .split('\n')
                    .filter(Boolean)
                    .slice(-2)
                    .join('\n');
                  return [
                    ...prev,
                    {
                      id: ++segmentIdRef.current,
                      text: merged,
                      shownAt: Date.now(),
                      burmeseText: result.burmeseText?.trim() || undefined,
                    },
                  ];
                });
              }
              if (playTtsEnabled && result.audioBase64) playTts(result.audioBase64);
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Interpret failed';
              setError(msg);
              pushErrorLog('error', `Interpret: ${msg}`);
            }
          }
          interpretDrainingRef.current = false;
          if (stopCaptureRef.current) setInterpretStatus('listening');
        };

        const stop = await captureAudioChunks(stream, (pcm) => {
          interpretQueueRef.current.push(pcm);
          void drainInterpretQueue();
        });
      stopCaptureRef.current = () => {
        stop();
        interpretQueueRef.current = [];
        interpretDrainingRef.current = false;
        recentContextRef.current = '';
        termLockRef.current = {};
        if (currentTtsRef.current) {
          currentTtsRef.current.pause();
          currentTtsRef.current = null;
          setIsPlayingTts(false);
        }
        stream.getTracks().forEach((t) => t.stop());
        setCaptureStream(null);
        setInterpretStatus('idle');
        releaseWakeLock();
        setActive(false);
      };
    } catch (e) {
      setInterpretStatus('idle');
      const msg = e instanceof Error ? e.message : 'Failed to start capture';
      setError(msg);
      pushErrorLog('error', `Start capture: ${msg}`);
    }
  }, [mode, loopbackDeviceId, testingMode, playTts, playTtsEnabled, pushErrorLog, activeProfile, useGlossaryAndBriefing]);

  const stopInterpretation = useCallback(() => {
    stopCaptureRef.current?.();
    stopCaptureRef.current = null;
  }, []);

  const handleResponseResult = useCallback((result: { burmeseText: string }) => {
    const text = result.burmeseText?.trim();
    const toShow = text || 'No speech detected. Try speaking again.';
    setTranslationSegments((prev) => [
      ...prev,
      { id: ++segmentIdRef.current, text: toShow, shownAt: Date.now() },
    ]);
  }, []);

  const downloadMetricsLog = useCallback(() => {
    const samples = getInterpretMetrics();
    const lines: string[] = [
      'Translate app – segment metrics',
      `Generated: ${new Date().toISOString()}`,
      `Sample count: ${samples.length}`,
      '',
      '--- Samples ---',
      ...samples.map((s) => JSON.stringify(s)),
    ];
    if (samples.length === 0) {
      lines.push('(No metrics recorded in this session.)');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `translate-metrics-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const downloadErrorLog = useCallback(() => {
    const apiBase = getApiBase();
    const lines: string[] = [
      'Translate app – error log',
      `Generated: ${new Date().toISOString()}`,
      `Backend: ${apiBase}`,
      `Backend status: ${backendStatus}${backendError ? ` – ${backendError}` : ''}`,
      '',
      '--- Entries ---',
      ...errorLogRef.current.map((e) => `[${e.timestamp}] ${e.type.toUpperCase()}: ${e.message}`),
    ];
    if (errorLogRef.current.length === 0) {
      lines.push('(No errors recorded since last download.)');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `translate-error-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    errorLogRef.current = [];
  }, [backendStatus, backendError]);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Burmese–English Interpreter</h1>
        <p className="app__backend-status" aria-live="polite">
          {backendStatus === 'ok' && (
            <span className="app__backend-ok">Backend connected</span>
          )}
          {backendStatus === 'unreachable' && (
            <span className="app__backend-unreachable">
              Backend unreachable{backendError ? `: ${backendError}` : ''}. On free hosting the first request may take ~50s.
            </span>
          )}
          {backendStatus === 'unknown' && (
            <span className="app__backend-unknown">Checking backend…</span>
          )}
        </p>
        <PermissionChecker
          permissionState={permissionState}
          onDismiss={() => {}}
          onSwitchToMobileMic={() => setMode('face_to_face')}
        />
      </header>

      <main className="app__main">
        <PlatformSelector
          mode={mode}
          onModeChange={setMode}
          loopbackDeviceId={loopbackDeviceId}
          onLoopbackDeviceIdChange={setLoopbackDeviceId}
          disabled={active}
        />

        <label className="app__tts-toggle app__tts-toggle--testing" title="Keep full script on screen for the whole session so you can compare and give feedback.">
          <input
            type="checkbox"
            checked={testingMode}
            onChange={(e) => setTestingMode(e.target.checked)}
          />
          <span>Testing mode — keep full script</span>
        </label>

        {!active && (
          <ScenarioProfilePanel
            profiles={profiles}
            activeProfileId={activeProfileId}
            disabled={active}
            useGlossaryAndBriefing={useGlossaryAndBriefing}
            onUseGlossaryAndBriefingChange={setUseGlossaryAndBriefing}
            onProfilesChange={setProfiles}
            onActiveProfileIdChange={setActiveProfileId}
          />
        )}


        {mode === 'desktop' && !active && (
          <p className="app__desktop-hint" role="status">
            When you click Start, choose the Teams tab (or window) and check <strong>Share tab audio</strong> so the app can hear the meeting.
          </p>
        )}

        <div className="app__controls">
          {!active ? (
            <motion.button
              type="button"
              className="app__btn app__btn--start"
              onClick={startInterpretation}
              whileTap={{ scale: 0.98 }}
            >
              Start interpretation
            </motion.button>
          ) : (
            <motion.button
              type="button"
              className="app__btn app__btn--stop"
              onClick={stopInterpretation}
              whileTap={{ scale: 0.98 }}
            >
              Stop
            </motion.button>
          )}
        </div>

        <label className="app__tts-toggle app__tts-toggle--interpret">
          <input
            type="checkbox"
            checked={playTtsEnabled}
            onChange={(e) => setPlayTtsEnabled(e.target.checked)}
          />
          <span>Play translation aloud</span>
        </label>

        <WavizVisualizer
          stream={captureStream}
          active={active}
        />

        {active && (
          <div className="app__interpret-status">
            <p className="app__interpret-hint" role="status">
              {interpretStatus === 'listening' && (
                <>Live translation — newest at the bottom. Full script kept until you clear it.</>
              )}
              {interpretStatus === 'processing' && (
                <>Sending to server…</>
              )}
            </p>
          </div>
        )}

        {!active && (
          <p className="app__script-hint" role="status">
            Starting a new session clears the script.
          </p>
        )}

        <ConversationView
          translationText={translationSegments.slice(-6).map((s) => s.text).join('\n')}
          isPlayingTts={isPlayingTts}
          testingMode={testingMode}
          segments={testingMode ? translationSegments : translationSegments.slice(-6)}
        />

        {translationSegments.length > 0 && !active && (
          <div className="app__testing-actions">
            <motion.button
              type="button"
              className="app__btn app__btn--start"
              disabled={
                cleanSummarizeStatus === 'loading' ||
                !translationSegments.some((s) => s.text.trim() !== '')
              }
              onClick={async () => {
                setCleanSummarizeError(null);
                setCleanSummarizeStatus('loading');
                const fullScript = translationSegments.map((s) => s.text).join('\n').trim();
                const combinedContext = useGlossaryAndBriefing
                  ? [glossaryEntriesToText(activeProfile.glossary), activeProfile.briefing.trim()].filter(Boolean).join('\n\n')
                  : '';
                try {
                  const result = await cleanAndSummarize(fullScript || '', combinedContext || undefined);
                  setCleanSummarizeResult(result);
                  setCleanSummarizeStatus('success');
                } catch (e) {
                  const msg = e instanceof Error ? e.message : 'Clean & summarize failed';
                  setCleanSummarizeError(msg);
                  setCleanSummarizeStatus('error');
                  pushErrorLog('error', `Clean & summarize: ${msg}`);
                }
              }}
              whileTap={{ scale: 0.98 }}
            >
              {cleanSummarizeStatus === 'loading' ? 'Cleaning…' : 'Clean & summarize'}
            </motion.button>
            <motion.button
              type="button"
              className="app__btn app__btn--secondary"
              disabled={cleanSummarizeStatus === 'loading'}
              onClick={() => {
                setTranslationSegments([]);
                setCleanSummarizeStatus('idle');
                setCleanSummarizeResult(null);
                setCleanSummarizeError(null);
              }}
              whileTap={{ scale: 0.98 }}
            >
              Clear script (new run)
            </motion.button>
          </div>
        )}

        {cleanSummarizeStatus === 'error' && cleanSummarizeError && (
          <div className="app__clean-error">
            <p>{cleanSummarizeError}</p>
            <button
              type="button"
              className="app__btn app__btn--secondary"
              onClick={() => {
                setCleanSummarizeStatus('idle');
                setCleanSummarizeError(null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {cleanSummarizeStatus === 'success' && cleanSummarizeResult && (
          <div className="app__clean-result">
            <h3 className="app__clean-result-title">Cleaned transcript & summary</h3>
            <p className="app__clean-result-hint">
              {useGlossaryAndBriefing ? 'Based on your glossary and meeting briefing.' : 'Cleaned without glossary or briefing.'}
            </p>
            <div className="app__clean-transcript-wrap">
              <label className="app__clean-label">Cleaned transcript</label>
              <div className="app__clean-transcript" role="document">
                {cleanSummarizeResult.cleanedTranscript || '(Empty)'}
              </div>
              <button
                type="button"
                className="app__btn app__btn--secondary app__clean-download"
                onClick={() => {
                  const blob = new Blob([cleanSummarizeResult.cleanedTranscript || ''], { type: 'text/plain' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = `meeting-cleaned-${new Date().toISOString().slice(0, 10)}.txt`;
                  a.click();
                  URL.revokeObjectURL(a.href);
                }}
              >
                Download cleaned transcript
              </button>
            </div>
            <div className="app__clean-summary-wrap">
              <label className="app__clean-label">Summary</label>
              <p className="app__clean-summary">{cleanSummarizeResult.summary || '(No summary)'}</p>
              {cleanSummarizeResult.keyPoints && cleanSummarizeResult.keyPoints.length > 0 && (
                <>
                  <label className="app__clean-label">Key points</label>
                  <ul className="app__clean-keypoints">
                    {cleanSummarizeResult.keyPoints.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <button
              type="button"
              className="app__btn app__btn--secondary"
              onClick={() => {
                setCleanSummarizeStatus('idle');
                setCleanSummarizeResult(null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="app__response">
          <p className="app__response-hint" aria-hidden="true">
            Speak in English — translation appears in Burmese for the other person.
          </p>
          <label className="app__tts-toggle app__tts-toggle--response">
            <input
              type="checkbox"
              checked={playResponseTtsEnabled}
              onChange={(e) => setPlayResponseTtsEnabled(e.target.checked)}
            />
            <span>Play response aloud</span>
          </label>
          <ResponseButton
            onResult={handleResponseResult}
            onError={(e) => {
              setError(e.message);
              pushErrorLog('error', `Response: ${e.message}`);
            }}
            disabled={active}
            playTtsEnabled={playResponseTtsEnabled}
          />
        </div>

        <div className="app__error-log">
          <motion.button
            type="button"
            className="app__btn app__btn--error-log"
            onClick={downloadMetricsLog}
            whileTap={{ scale: 0.98 }}
          >
            Download metrics log
          </motion.button>
          <motion.button
            type="button"
            className="app__btn app__btn--error-log"
            onClick={downloadErrorLog}
            whileTap={{ scale: 0.98 }}
          >
            Download error log
          </motion.button>
        </div>

        {error && (
          <motion.p
            className="app__error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            role="alert"
          >
            <span>{error}</span>
            <button
              type="button"
              className="app__error-dismiss"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </motion.p>
        )}
      </main>
    </div>
  );
}

export default App;
