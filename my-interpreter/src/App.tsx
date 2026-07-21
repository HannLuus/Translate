import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { PlatformSelector } from './components/PlatformSelector';
import { PermissionChecker, checkPermissions } from './components/PermissionChecker';
import { ConversationView } from './components/ConversationView';
import { WavizVisualizer } from './components/WavizVisualizer';
import { ResponseButton } from './components/ResponseButton';
import { ScenarioProfilePanel } from './components/ScenarioProfilePanel';
import { getCaptureStream, captureAudioSegments, SEGMENT_MS } from './audioCapture';
import {
  interpretSegment,
  healthCheck,
  getApiBase,
  generateMeetingMinutes,
  appendInterpretMetrics,
  getInterpretMetrics,
  clearInterpretMetrics,
} from './api';
import { requestWakeLock, releaseWakeLock } from './wakeLock';
import { extractNewSuffix, isDuplicateSegment } from './textMerge';
import { APP_UPDATE_EVENT, getAppBuildTime, getAppVersionLabel } from './appVersion';
import type {
  CaptureMode,
  PermissionState,
  RecentContextPair,
  TermLockMap,
  TranslationSegment,
  MeetingMinutesResult,
  GlossaryEntry,
  ScenarioProfile,
  SegmentJob,
} from './types';
import './App.css';

const MAX_QUEUED_SEGMENTS = 3;
const MAX_SEGMENT_ATTEMPTS = 4;

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

function formatMinutesDownload(result: MeetingMinutesResult): string {
  const lines = [
    'MEETING MINUTES',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Executive summary',
    result.executiveSummary || '(none)',
    '',
    '## Chronological record',
    result.chronologicalRecord || '(none)',
    '',
    '## Decisions',
    ...(result.decisions.length ? result.decisions.map((d) => `- ${d}`) : ['(none)']),
    '',
    '## Action items',
    ...(result.actionItems.length ? result.actionItems.map((d) => `- ${d}`) : ['(none)']),
    '',
    '## Open questions',
    ...(result.openQuestions.length ? result.openQuestions.map((d) => `- ${d}`) : ['(none)']),
    '',
    '## Key points',
    ...(result.keyPoints?.length
      ? result.keyPoints.map((d) => `- ${d}`)
      : ['(none)']),
  ];
  return lines.join('\n');
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
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const appVersionLabel = getAppVersionLabel();
  const appBuildTime = getAppBuildTime();

  useEffect(() => {
    const onUpdate = () => setUpdateAvailable(true);
    window.addEventListener(APP_UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(APP_UPDATE_EVENT, onUpdate);
  }, []);

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
  const [sessionStatusLine, setSessionStatusLine] = useState('');
  const [minutesStatus, setMinutesStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [minutesResult, setMinutesResult] = useState<MeetingMinutesResult | null>(null);
  const [minutesError, setMinutesError] = useState<string | null>(null);
  const [failedSegmentLocalId, setFailedSegmentLocalId] = useState<number | null>(null);
  const stopCaptureRef = useRef<(() => void) | null>(null);
  const sessionActiveRef = useRef(false);
  const segmentQueueRef = useRef<SegmentJob[]>([]);
  const interpretDrainingRef = useRef(false);
  const currentTtsRef = useRef<HTMLAudioElement | null>(null);
  const recentContextRef = useRef<RecentContextPair[]>([]);
  const termLockRef = useRef<TermLockMap>({});
  const jobIdRef = useRef(0);
  const queueDepthRef = useRef(0);
  const [, setQueueTick] = useState(0);

  const bumpQueueUi = useCallback(() => {
    queueDepthRef.current = segmentQueueRef.current.filter((j) => j.status === 'queued' || j.status === 'processing' || j.status === 'failed').length;
    setQueueTick((n) => n + 1);
  }, []);

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
    if (!active) return;
    const id = window.setInterval(() => {
      void healthCheck().then(({ ok, error: err }) => {
        if (!ok) {
          setBackendStatus('unreachable');
          setBackendError(err ?? 'Unknown');
        } else if (backendStatus !== 'ok') {
          setBackendStatus('ok');
          setBackendError(null);
        }
      });
    }, 60_000);
    return () => clearInterval(id);
  }, [active, backendStatus]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && active) {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
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
    void audio.play().catch(() => {
      currentTtsRef.current = null;
      setIsPlayingTts(false);
    });
    audio.onended = () => {
      currentTtsRef.current = null;
      setIsPlayingTts(false);
    };
  }, []);

  const appendTranslation = useCallback((english: string, burmese: string, segmentIndex: number) => {
    const eng = english.trim();
    const my = burmese.trim();
    if (!eng && !my) return;

    setTranslationSegments((prev) => {
      const lastText = prev[prev.length - 1]?.text ?? '';
      const displayEnglish = eng ? mergeSegmentText(eng, lastText) : null;

      // mergeSegmentText returns null for empty or duplicate English — never fall back to raw `eng`.
      if (eng && displayEnglish === null) return prev;
      if (!displayEnglish && !my) return prev;

      if (displayEnglish) {
        recentContextRef.current = [
          ...recentContextRef.current,
          { burmese: my, english: displayEnglish },
        ].slice(-4);
      }

      return [
        ...prev,
        {
          id: ++segmentIdRef.current,
          text: displayEnglish || '(Burmese heard; English empty)',
          shownAt: Date.now(),
          burmeseText: my || undefined,
          segmentIndex,
        },
      ];
    });
  }, []);

  const drainSegmentQueue = useCallback(async () => {
    if (interpretDrainingRef.current) return;
    interpretDrainingRef.current = true;

    const combinedContext = useGlossaryAndBriefing
      ? [glossaryEntriesToText(activeProfile.glossary), activeProfile.briefing.trim()].filter(Boolean).join('\n\n')
      : '';

    while (sessionActiveRef.current || segmentQueueRef.current.some((j) => j.status === 'queued' || j.status === 'processing')) {
      const job = segmentQueueRef.current.find((j) => j.status === 'queued');
      if (!job) break;

      job.status = 'processing';
      job.attempts += 1;
      setInterpretStatus('processing');
      setFailedSegmentLocalId(null);
      const lagMin = Math.max(0, Math.round((Date.now() - job.enqueuedAt) / 60000));
      setSessionStatusLine(
        `Translating segment ${job.segmentIndex} (${Math.round(job.durationMs / 1000)}s audio)` +
          (lagMin > 0 ? ` · ~${lagMin} min behind` : '') +
          (queueDepthRef.current > 1 ? ` · ${queueDepthRef.current - 1} waiting` : ''),
      );
      bumpQueueUi();

      try {
        const result = await interpretSegment(
          job.pcm,
          combinedContext || undefined,
          termLockRef.current,
          recentContextRef.current,
        );
        if (!sessionActiveRef.current && !segmentQueueRef.current.includes(job)) {
          break;
        }
        if (result.termLock) termLockRef.current = result.termLock;
        if (result.diagnostics) appendInterpretMetrics(result.diagnostics);

        const burmese = result.burmeseText?.trim() ?? '';
        const english = result.englishText?.trim() ?? '';
        if (!burmese && !english) {
          job.status = 'empty';
          setSessionStatusLine(`Segment ${job.segmentIndex}: no speech detected`);
          pushErrorLog('warn', `Segment ${job.segmentIndex}: empty STT/MT`);
        } else {
          job.status = 'done';
          appendTranslation(english, burmese, job.segmentIndex);
          if (playTtsEnabled && result.audioBase64) playTts(result.audioBase64);
          setSessionStatusLine(`Segment ${job.segmentIndex} ready`);
        }
        // Drop finished PCM to free memory
        job.pcm = new ArrayBuffer(0);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Interpret failed';
        if (job.attempts < MAX_SEGMENT_ATTEMPTS) {
          job.status = 'queued';
          setError(`Segment ${job.segmentIndex} failed (attempt ${job.attempts}): ${msg}. Retrying…`);
          pushErrorLog('error', `Segment ${job.segmentIndex}: ${msg}`);
          await new Promise((r) => setTimeout(r, 2000 * job.attempts));
        } else {
          job.status = 'failed';
          job.error = msg;
          setFailedSegmentLocalId(job.localId);
          setError(`Segment ${job.segmentIndex} failed after ${job.attempts} attempts: ${msg}`);
          pushErrorLog('error', `Segment ${job.segmentIndex} final: ${msg}`);
          setSessionStatusLine(`Segment ${job.segmentIndex} failed — tap Retry`);
          bumpQueueUi();
          break;
        }
      }
      bumpQueueUi();
    }

    interpretDrainingRef.current = false;
    if (sessionActiveRef.current) {
      setInterpretStatus('listening');
      const pending = segmentQueueRef.current.filter((j) => j.status === 'queued' || j.status === 'failed').length;
      if (pending === 0) {
        setSessionStatusLine(`Recording next ~${Math.round(SEGMENT_MS / 60000)}-minute segment…`);
      }
    } else {
      setInterpretStatus('idle');
    }
  }, [activeProfile, useGlossaryAndBriefing, appendTranslation, playTts, playTtsEnabled, pushErrorLog, bumpQueueUi]);

  const enqueueSegment = useCallback((pcm: ArrayBuffer, segmentIndex: number, durationMs: number) => {
    const unfinished = segmentQueueRef.current.filter((j) => j.status === 'queued' || j.status === 'processing');
    if (unfinished.length >= MAX_QUEUED_SEGMENTS) {
      const msg = `Segment queue full (${MAX_QUEUED_SEGMENTS}). Translation is behind — wait for a segment to finish before more audio is queued.`;
      setError(msg);
      pushErrorLog('warn', msg);
      setSessionStatusLine('Queue full — still recording, waiting to catch up');
      // Still keep the newest segment by dropping oldest queued (not processing)
      const oldestQueued = segmentQueueRef.current.find((j) => j.status === 'queued');
      if (oldestQueued) {
        oldestQueued.status = 'failed';
        oldestQueued.error = 'Dropped: queue overflow';
        oldestQueued.pcm = new ArrayBuffer(0);
        pushErrorLog('warn', `Dropped segment ${oldestQueued.segmentIndex} due to queue overflow`);
      } else {
        return;
      }
    }

    const job: SegmentJob = {
      localId: ++jobIdRef.current,
      segmentIndex,
      pcm,
      durationMs,
      status: 'queued',
      attempts: 0,
      enqueuedAt: Date.now(),
    };
    segmentQueueRef.current.push(job);
    bumpQueueUi();
    void drainSegmentQueue();
  }, [bumpQueueUi, drainSegmentQueue, pushErrorLog]);

  const retryFailedSegment = useCallback(() => {
    const job = segmentQueueRef.current.find((j) => j.localId === failedSegmentLocalId && j.status === 'failed');
    if (!job || job.pcm.byteLength === 0) {
      setError('Nothing left to retry for that segment (audio was cleared).');
      return;
    }
    job.status = 'queued';
    job.attempts = 0;
    job.error = undefined;
    setFailedSegmentLocalId(null);
    setError(null);
    bumpQueueUi();
    void drainSegmentQueue();
  }, [failedSegmentLocalId, bumpQueueUi, drainSegmentQueue]);

  const startInterpretation = useCallback(async () => {
    setError(null);
    setMinutesResult(null);
    setMinutesStatus('idle');
    setMinutesError(null);
    if (mode === 'rooted_android' && !loopbackDeviceId.trim()) {
      const msg = 'Enter a loopback device ID for Rooted Android, or switch to Face-to-Face (Mic) mode.';
      setError(msg);
      pushErrorLog('error', msg);
      return;
    }
    try {
      setTranslationSegments([]);
      recentContextRef.current = [];
      termLockRef.current = {};
      segmentQueueRef.current = [];
      jobIdRef.current = 0;
      clearInterpretMetrics();
      setFailedSegmentLocalId(null);

      const stream = await getCaptureStream(
        mode,
        mode === 'rooted_android' ? loopbackDeviceId.trim() || undefined : undefined
      );
      setCaptureStream(stream);
      setActive(true);
      sessionActiveRef.current = true;
      setInterpretStatus('listening');
      setSessionStatusLine(`Recording first ~${Math.round(SEGMENT_MS / 60000)}-minute segment…`);

      const wakeOk = await requestWakeLock();
      if (!wakeOk) {
        pushErrorLog('warn', 'Wake lock unavailable — keep the screen on during the meeting');
        setError('Could not keep the screen awake. Leave this tab visible so capture does not stall.');
      }

      const stop = await captureAudioSegments(
        stream,
        (pcm, meta) => {
          if (!sessionActiveRef.current) return;
          enqueueSegment(pcm, meta.segmentIndex, meta.durationMs);
        },
        {
          onStall: (reason) => {
            const msg =
              reason === 'track_ended'
                ? 'Audio share ended (tab/window closed or unshared). Capture stopped — tap Start and share again.'
                : 'Audio engine suspended (tab backgrounded or system pause). Capture stopped — return to this tab and Start again.';
            setError(msg);
            pushErrorLog('error', msg);
            setSessionStatusLine('Capture stalled');
            stopCaptureRef.current?.();
            stopCaptureRef.current = null;
          },
        },
      );

      stopCaptureRef.current = () => {
        // Flush final partial segment while session is still marked active
        stop();
        sessionActiveRef.current = false;
        void drainSegmentQueue();
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
        setSessionStatusLine('Finishing any segments still translating…');
      };
    } catch (e) {
      sessionActiveRef.current = false;
      setInterpretStatus('idle');
      setActive(false);
      const msg = e instanceof Error ? e.message : 'Failed to start capture';
      setError(msg);
      pushErrorLog('error', `Start capture: ${msg}`);
    }
  }, [mode, loopbackDeviceId, pushErrorLog, enqueueSegment, drainSegmentQueue]);

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

  const queuedCount = segmentQueueRef.current.filter((j) => j.status === 'queued' || j.status === 'processing').length;

  return (
    <div className="app">
      {updateAvailable ? (
        <div className="app__update-banner" role="status">
          <span>New app version ready.</span>
          <button type="button" className="app__update-reload" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}
      <header className="app__header">
        <div className="app__title-row">
          <h1 className="app__title">Burmese–English Interpreter</h1>
          <p
            className="app__version"
            title={appBuildTime ? `Built ${appBuildTime}` : undefined}
          >
            {appVersionLabel}
          </p>
        </div>
        <p className="app__backend-status" aria-live="polite">
          {backendStatus === 'ok' && (
            <span className="app__backend-ok">Backend connected</span>
          )}
          {backendStatus === 'unreachable' && (
            <span className="app__backend-unreachable">
              Backend unreachable{backendError ? `: ${backendError}` : ''}.
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
            Translation arrives in ~{Math.round(SEGMENT_MS / 60000)}-minute segments (not live).
          </p>
        )}

        {!active && (
          <p className="app__desktop-hint" role="status">
            Mode: batch segments (~{Math.round(SEGMENT_MS / 60000)} min each, overlapping). You will be a few minutes behind — by design, for clearer Burmese→English.
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
                <>Recording continuously · English updates after each ~{Math.round(SEGMENT_MS / 60000)}-minute segment.</>
              )}
              {interpretStatus === 'processing' && (
                <>Sending segment to server…{queuedCount > 1 ? ` (${queuedCount} in queue)` : ''}</>
              )}
            </p>
            {sessionStatusLine && (
              <p className="app__interpret-hint app__interpret-hint--detail" role="status">
                {sessionStatusLine}
              </p>
            )}
          </div>
        )}

        {failedSegmentLocalId != null && (
          <div className="app__clean-error">
            <p>A segment failed. You can retry it without restarting the meeting.</p>
            <button type="button" className="app__btn app__btn--secondary" onClick={retryFailedSegment}>
              Retry failed segment
            </button>
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
                minutesStatus === 'loading' ||
                !translationSegments.some((s) => s.text.trim() !== '')
              }
              onClick={async () => {
                setMinutesError(null);
                setMinutesStatus('loading');
                const fullScript = translationSegments.map((s) => s.text).join('\n').trim();
                const segmentPayload = translationSegments
                  .filter((s) => s.text.trim())
                  .map((s) => ({
                    english: s.text,
                    burmese: s.burmeseText,
                    segmentIndex: s.segmentIndex,
                  }));
                const combinedContext = useGlossaryAndBriefing
                  ? [glossaryEntriesToText(activeProfile.glossary), activeProfile.briefing.trim()].filter(Boolean).join('\n\n')
                  : '';
                try {
                  const result = await generateMeetingMinutes(
                    fullScript || '',
                    combinedContext || undefined,
                    segmentPayload,
                  );
                  setMinutesResult(result);
                  setMinutesStatus('success');
                } catch (e) {
                  const msg = e instanceof Error ? e.message : 'Meeting minutes failed';
                  setMinutesError(msg);
                  setMinutesStatus('error');
                  pushErrorLog('error', `Meeting minutes: ${msg}`);
                }
              }}
              whileTap={{ scale: 0.98 }}
            >
              {minutesStatus === 'loading' ? 'Writing minutes…' : 'Generate meeting minutes'}
            </motion.button>
            <motion.button
              type="button"
              className="app__btn app__btn--secondary"
              disabled={minutesStatus === 'loading'}
              onClick={() => {
                setTranslationSegments([]);
                setMinutesStatus('idle');
                setMinutesResult(null);
                setMinutesError(null);
              }}
              whileTap={{ scale: 0.98 }}
            >
              Clear script (new run)
            </motion.button>
          </div>
        )}

        {minutesStatus === 'error' && minutesError && (
          <div className="app__clean-error">
            <p>{minutesError}</p>
            <button
              type="button"
              className="app__btn app__btn--secondary"
              onClick={() => {
                setMinutesStatus('idle');
                setMinutesError(null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {minutesStatus === 'success' && minutesResult && (
          <div className="app__clean-result">
            <h3 className="app__clean-result-title">Meeting minutes</h3>
            <p className="app__clean-result-hint">
              Structured from your bilingual segments
              {useGlossaryAndBriefing ? ' using glossary and briefing.' : '.'}
            </p>

            <div className="app__clean-summary-wrap">
              <label className="app__clean-label">Executive summary</label>
              <p className="app__clean-summary">{minutesResult.executiveSummary || '(No summary)'}</p>
            </div>

            <div className="app__clean-transcript-wrap">
              <label className="app__clean-label">Chronological record</label>
              <div className="app__clean-transcript" role="document">
                {minutesResult.chronologicalRecord || '(Empty)'}
              </div>
            </div>

            {minutesResult.decisions.length > 0 && (
              <div className="app__clean-summary-wrap">
                <label className="app__clean-label">Decisions</label>
                <ul className="app__clean-keypoints">
                  {minutesResult.decisions.map((point, i) => (
                    <li key={`d-${i}`}>{point}</li>
                  ))}
                </ul>
              </div>
            )}

            {minutesResult.actionItems.length > 0 && (
              <div className="app__clean-summary-wrap">
                <label className="app__clean-label">Action items</label>
                <ul className="app__clean-keypoints">
                  {minutesResult.actionItems.map((point, i) => (
                    <li key={`a-${i}`}>{point}</li>
                  ))}
                </ul>
              </div>
            )}

            {minutesResult.openQuestions.length > 0 && (
              <div className="app__clean-summary-wrap">
                <label className="app__clean-label">Open questions</label>
                <ul className="app__clean-keypoints">
                  {minutesResult.openQuestions.map((point, i) => (
                    <li key={`q-${i}`}>{point}</li>
                  ))}
                </ul>
              </div>
            )}

            {minutesResult.keyPoints && minutesResult.keyPoints.length > 0 && (
              <div className="app__clean-summary-wrap">
                <label className="app__clean-label">Key points</label>
                <ul className="app__clean-keypoints">
                  {minutesResult.keyPoints.map((point, i) => (
                    <li key={`k-${i}`}>{point}</li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              className="app__btn app__btn--secondary app__clean-download"
              onClick={() => {
                const blob = new Blob([formatMinutesDownload(minutesResult)], { type: 'text/plain;charset=utf-8' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `meeting-minutes-${new Date().toISOString().slice(0, 10)}.txt`;
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Download meeting minutes
            </button>
            <button
              type="button"
              className="app__btn app__btn--secondary"
              onClick={() => {
                setMinutesStatus('idle');
                setMinutesResult(null);
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
