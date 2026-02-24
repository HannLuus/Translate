import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { PlatformSelector } from './components/PlatformSelector';
import { PermissionChecker, checkPermissions } from './components/PermissionChecker';
import { ConversationView } from './components/ConversationView';
import { WavizVisualizer } from './components/WavizVisualizer';
import { ResponseButton } from './components/ResponseButton';
import { getCaptureStream, captureAudioChunks } from './audioCapture';
import { interpretAudio, healthCheck, getApiBase } from './api';
import { requestWakeLock, releaseWakeLock } from './wakeLock';
import type { CaptureMode, PermissionState, TranslationSegment } from './types';
import './App.css';

const MODE_STORAGE_KEY = 'interpreter-capture-mode';
const LOOPBACK_STORAGE_KEY = 'interpreter-loopback-device-id';
const TESTING_MODE_STORAGE_KEY = 'interpreter-testing-mode';

type ErrorLogEntry = { timestamp: string; type: string; message: string };

function App() {
  const errorLogRef = useRef<ErrorLogEntry[]>([]);

  const pushErrorLog = useCallback((type: string, message: string) => {
    errorLogRef.current.push({
      timestamp: new Date().toISOString(),
      type,
      message,
    });
  }, []);

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
  const stopCaptureRef = useRef<(() => void) | null>(null);
  const currentTtsRef = useRef<HTMLAudioElement | null>(null);
  /** Last 2–3 translation segments for continuity (sent to backend). */
  const recentContextRef = useRef<string>('');

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
      const stream = await getCaptureStream(
        mode,
        mode === 'rooted_android' ? loopbackDeviceId.trim() || undefined : undefined
      );
      setCaptureStream(stream);
      setActive(true);
      setInterpretStatus('listening');
      await requestWakeLock();

      const stop = await captureAudioChunks(stream, async (pcm) => {
          try {
            setInterpretStatus('processing');
            const result = await interpretAudio(pcm, recentContextRef.current || undefined);
            const englishLine = result.englishText ?? '';
            if (englishLine) {
              const prev = recentContextRef.current;
              recentContextRef.current = (prev ? prev + '\n' + englishLine : englishLine)
                .split('\n')
                .filter(Boolean)
                .slice(-3)
                .join('\n');
              setTranslationSegments((prev) => [
                ...prev,
                {
                  id: ++segmentIdRef.current,
                  text: englishLine,
                  shownAt: Date.now(),
                  burmeseText: result.burmeseText?.trim() || undefined,
                },
              ]);
            }
            if (playTtsEnabled && result.audioBase64) playTts(result.audioBase64);
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Interpret failed';
            setError(msg);
            pushErrorLog('error', `Interpret: ${msg}`);
          } finally {
            if (stopCaptureRef.current) setInterpretStatus('listening');
          }
        });
      stopCaptureRef.current = () => {
        stop();
        recentContextRef.current = '';
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
  }, [mode, loopbackDeviceId, testingMode, playTts, playTtsEnabled, pushErrorLog]);

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
          translationText={translationSegments.map((s) => s.text).join('\n')}
          isPlayingTts={isPlayingTts}
          testingMode={testingMode}
          segments={testingMode ? translationSegments : undefined}
        />

        {translationSegments.length > 0 && !active && (
          <div className="app__testing-actions">
            <motion.button
              type="button"
              className="app__btn app__btn--secondary"
              onClick={() => setTranslationSegments([])}
              whileTap={{ scale: 0.98 }}
            >
              Clear script (new run)
            </motion.button>
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
