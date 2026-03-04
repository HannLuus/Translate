import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { PlatformSelector } from './components/PlatformSelector';
import { PermissionChecker, checkPermissions } from './components/PermissionChecker';
import { ConversationView } from './components/ConversationView';
import { WavizVisualizer } from './components/WavizVisualizer';
import { ResponseButton } from './components/ResponseButton';
import { getCaptureStream, captureAudioChunks } from './audioCapture';
import { interpretAudio, healthCheck, getApiBase, cleanAndSummarize } from './api';
import { requestWakeLock, releaseWakeLock } from './wakeLock';
import type { CaptureMode, PermissionState, TranslationSegment, CleanSummarizeResult } from './types';
import './App.css';

/**
 * True if the new line is too similar to the immediately previous line.
 * With pause-based chunking each chunk is a distinct utterance, so a
 * simple Jaccard check against the last line is all that is needed.
 */
function isDuplicate(candidate: string, lastLine: string): boolean {
  const tok = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
  const a = tok(candidate);
  const b = tok(lastLine);
  if (a.size === 0 || b.size === 0) return false;
  let intersection = 0;
  a.forEach((w) => { if (b.has(w)) intersection++; });
  return intersection / new Set([...a, ...b]).size >= 0.65;
}

const MODE_STORAGE_KEY = 'interpreter-capture-mode';
const LOOPBACK_STORAGE_KEY = 'interpreter-loopback-device-id';
const TESTING_MODE_STORAGE_KEY = 'interpreter-testing-mode';
const MEETING_CONTEXT_STORAGE_KEY = 'interpreter-meeting-context';
const PERMANENT_GLOSSARY_STORAGE_KEY = 'interpreter-permanent-glossary';

type ErrorLogEntry = { timestamp: string; type: string; message: string };

export type GlossaryEntry = { id: number; term: string; meaning: string };

function parseGlossaryString(str: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const lines = str.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(.+?)\s*[=:]\s*(.+)$/);
    if (match) {
      entries.push({ id: Date.now() + Math.random(), term: match[1].trim(), meaning: match[2].trim() });
    }
  }
  return entries;
}

function loadGlossaryFromStorage(): GlossaryEntry[] {
  const raw = localStorage.getItem(PERMANENT_GLOSSARY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e.term === 'string' && typeof e.meaning === 'string')) {
      return parsed.map((e) => ({ id: e.id ?? Date.now() + Math.random(), term: e.term.trim(), meaning: e.meaning.trim() }));
    }
    if (typeof parsed === 'string') return parseGlossaryString(parsed);
    return [];
  } catch {
    return parseGlossaryString(raw);
  }
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

  const [glossaryEntries, setGlossaryEntries] = useState<GlossaryEntry[]>(loadGlossaryFromStorage);
  const [editingGlossaryId, setEditingGlossaryId] = useState<number | null>(null);
  const [glossarySaveFeedback, setGlossarySaveFeedback] = useState(false);
  const [glossaryExpanded, setGlossaryExpanded] = useState(false);
  const [briefingSaveFeedback, setBriefingSaveFeedback] = useState(false);
  const [meetingContext, setMeetingContext] = useState(() => {
    return localStorage.getItem(MEETING_CONTEXT_STORAGE_KEY) ?? '';
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
  useEffect(() => {
    localStorage.setItem(PERMANENT_GLOSSARY_STORAGE_KEY, JSON.stringify(glossaryEntries));
  }, [glossaryEntries]);
  useEffect(() => {
    localStorage.setItem(MEETING_CONTEXT_STORAGE_KEY, meetingContext);
  }, [meetingContext]);

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
            const combinedContext = [glossaryEntriesToText(glossaryEntries), meetingContext.trim()].filter(Boolean).join('\n\n');
            const result = await interpretAudio(pcm, combinedContext);
            const englishLine = result.englishText ?? '';
            if (englishLine) {
              setTranslationSegments((prev) => {
                const lastText = prev[prev.length - 1]?.text ?? '';
                if (isDuplicate(englishLine, lastText)) return prev; // too similar to previous — skip
                const ctx = recentContextRef.current;
                recentContextRef.current = (ctx ? ctx + '\n' + englishLine : englishLine)
                  .split('\n')
                  .filter(Boolean)
                  .slice(-2)
                  .join('\n');
                return [
                  ...prev,
                  {
                    id: ++segmentIdRef.current,
                    text: englishLine,
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
  }, [mode, loopbackDeviceId, testingMode, playTts, playTtsEnabled, pushErrorLog, glossaryEntries, meetingContext]);

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

        {!active && (
          <details className="app__context-panel">
            <summary>Meeting Briefing & Glossary (Optional)</summary>
            
            <div className="app__context-group">
              <div className="app__glossary-summary-wrap">
                <button
                  type="button"
                  className="app__glossary-summary-btn"
                  onClick={() => setGlossaryExpanded((e) => !e)}
                  aria-expanded={glossaryExpanded}
                >
                  <span className="app__glossary-summary-label">
                    Permanent Glossary (Company names, acronyms, standard terms)
                  </span>
                  <span className="app__glossary-summary-count">
                    {glossaryEntries.length} {glossaryEntries.length === 1 ? 'entry' : 'entries'}
                    {glossarySaveFeedback ? ' • Saved!' : ' saved'}
                  </span>
                  <span className="app__glossary-summary-chevron" aria-hidden>{glossaryExpanded ? '▼' : '▶'}</span>
                </button>
              </div>
              {!glossaryExpanded && (
                <p className="app__context-hint">Click above to add, edit, or remove entries. Saved entries are used in every meeting.</p>
              )}
              {glossaryExpanded && (
                <>
                  <p className="app__context-hint">Saves across all meetings. Add, edit, or remove entries below, then Save glossary.</p>
                  <div className="app__glossary-list">
                {glossaryEntries.map((entry) => (
                  <div key={entry.id} className="app__glossary-row">
                    {editingGlossaryId === entry.id ? (
                      <>
                        <input
                          className="app__glossary-input"
                          value={entry.term}
                          onChange={(e) =>
                            setGlossaryEntries((prev) =>
                              prev.map((x) => (x.id === entry.id ? { ...x, term: e.target.value } : x))
                            )
                          }
                          placeholder="Term / acronym"
                        />
                        <input
                          className="app__glossary-input"
                          value={entry.meaning}
                          onChange={(e) =>
                            setGlossaryEntries((prev) =>
                              prev.map((x) => (x.id === entry.id ? { ...x, meaning: e.target.value } : x))
                            )
                          }
                          placeholder="Meaning"
                        />
                        <button
                          type="button"
                          className="app__glossary-btn app__glossary-btn--save"
                          onClick={() => setEditingGlossaryId(null)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="app__glossary-btn app__glossary-btn--cancel"
                          onClick={() => {
                            setEditingGlossaryId(null);
                            if (!entry.term.trim() && !entry.meaning.trim()) {
                              setGlossaryEntries((prev) => prev.filter((e) => e.id !== entry.id));
                            }
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="app__glossary-term">{entry.term || '(term)'}</span>
                        <span className="app__glossary-meaning">{entry.meaning || '(meaning)'}</span>
                        <button
                          type="button"
                          className="app__glossary-btn app__glossary-btn--edit"
                          onClick={() => setEditingGlossaryId(entry.id)}
                          aria-label="Edit entry"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="app__glossary-btn app__glossary-btn--delete"
                          onClick={() => {
                            setGlossaryEntries((prev) => prev.filter((e) => e.id !== entry.id));
                            if (editingGlossaryId === entry.id) setEditingGlossaryId(null);
                          }}
                          aria-label="Delete entry"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="app__glossary-btn app__glossary-btn--add"
                onClick={() => {
                  const id = Date.now();
                  setGlossaryEntries((prev) => [...prev, { id, term: '', meaning: '' }]);
                  setEditingGlossaryId(id);
                }}
              >
                Add new entry
              </button>
              <button
                type="button"
                className="app__glossary-btn app__glossary-btn--save-glossary"
                onClick={() => {
                  localStorage.setItem(PERMANENT_GLOSSARY_STORAGE_KEY, JSON.stringify(glossaryEntries));
                  setGlossarySaveFeedback(true);
                  setGlossaryExpanded(false);
                  window.setTimeout(() => setGlossarySaveFeedback(false), 2000);
                }}
              >
                {glossarySaveFeedback ? 'Saved!' : 'Save glossary'}
              </button>
                </>
              )}
            </div>

            <div className="app__context-group">
              <label className="app__context-label">Meeting Specific Briefing</label>
              <p className="app__context-hint">Specific to today's call. Saved briefing is sent to the AI when you start interpretation.</p>
              <textarea
                className="app__context-input"
                value={meetingContext}
                onChange={(e) => setMeetingContext(e.target.value)}
                placeholder="Add meeting specific context here..."
                disabled={active}
              />
              <div className="app__context-briefing-actions">
                <button
                  type="button"
                  className="app__context-save-btn"
                  onClick={() => {
                    localStorage.setItem(MEETING_CONTEXT_STORAGE_KEY, meetingContext);
                    setBriefingSaveFeedback(true);
                    window.setTimeout(() => setBriefingSaveFeedback(false), 2000);
                  }}
                >
                  {briefingSaveFeedback ? 'Saved!' : 'Save meeting briefing'}
                </button>
                <button
                  type="button"
                  className="app__context-clear-btn"
                  onClick={() => {
                    setMeetingContext('');
                    localStorage.removeItem(MEETING_CONTEXT_STORAGE_KEY);
                  }}
                >
                  Clear for next meeting
                </button>
              </div>
            </div>
          </details>
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
                const combinedContext = [glossaryEntriesToText(glossaryEntries), meetingContext.trim()].filter(Boolean).join('\n\n');
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
            <p className="app__clean-result-hint">Based on your glossary and meeting briefing.</p>
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
