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
import {
  PARALLEL_WORKERS,
  MAX_SEGMENT_ATTEMPTS,
  WARN_BUFFERED_MS,
  bufferedUnfinishedMs,
  clearAllSegments,
  getSegmentPcm,
  jobToStored,
  putSegment,
  updateSegment,
} from './segmentStore';
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
  const sessionIdRef = useRef('');
  const sessionGenRef = useRef(0);
  const segmentQueueRef = useRef<SegmentJob[]>([]);
  const activeWorkersRef = useRef(0);
  const drainRunningRef = useRef(false);
  /** Next segmentIndex to append to the UI (ordered merge for parallel workers). */
  const nextDisplayIndexRef = useRef(1);
  const pendingDisplayRef = useRef<Map<number, { english: string; burmese: string; empty: boolean }>>(new Map());
  /** segmentIndexes already flushed (including empty failures) — late retries upsert. */
  const flushedIndexesRef = useRef<Set<number>>(new Set());
  const playTtsEnabledRef = useRef(playTtsEnabled);
  playTtsEnabledRef.current = playTtsEnabled;
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

  /** Replace or append a segment that was previously flushed as empty (manual retry). */
  const upsertTranslation = useCallback((english: string, burmese: string, segmentIndex: number) => {
    const eng = english.trim();
    const my = burmese.trim();
    if (!eng && !my) return;

    setTranslationSegments((prev) => {
      const existingIdx = prev.findIndex((s) => s.segmentIndex === segmentIndex);
      const placeholder = '(Burmese heard; English empty)';
      const text = eng || placeholder;

      if (existingIdx >= 0) {
        const next = [...prev];
        next[existingIdx] = {
          ...next[existingIdx],
          text,
          burmeseText: my || undefined,
          shownAt: Date.now(),
        };
        return next;
      }

      const lastText = prev[prev.length - 1]?.text ?? '';
      const displayEnglish = eng ? mergeSegmentText(eng, lastText) : null;
      if (eng && displayEnglish === null) {
        // Still show retry result even if similar to neighbor
        return [
          ...prev,
          {
            id: ++segmentIdRef.current,
            text: eng,
            shownAt: Date.now(),
            burmeseText: my || undefined,
            segmentIndex,
          },
        ];
      }

      return [
        ...prev,
        {
          id: ++segmentIdRef.current,
          text: displayEnglish || placeholder,
          shownAt: Date.now(),
          burmeseText: my || undefined,
          segmentIndex,
        },
      ];
    });

    if (eng) {
      recentContextRef.current = [
        ...recentContextRef.current,
        { burmese: my, english: eng },
      ].slice(-4);
    }
  }, []);

  const flushOrderedDisplay = useCallback(() => {
    while (pendingDisplayRef.current.has(nextDisplayIndexRef.current)) {
      const idx = nextDisplayIndexRef.current;
      const item = pendingDisplayRef.current.get(idx)!;
      pendingDisplayRef.current.delete(idx);
      nextDisplayIndexRef.current = idx + 1;
      flushedIndexesRef.current.add(idx);
      if (!item.empty) {
        appendTranslation(item.english, item.burmese, idx);
      }
    }
  }, [appendTranslation]);

  const persistJob = useCallback(async (job: SegmentJob) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    job.revision += 1;
    const revision = job.revision;
    try {
      await putSegment(jobToStored(job, sid, revision));
    } catch (e) {
      pushErrorLog('warn', `IndexedDB put failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [pushErrorLog]);

  const processOneJob = useCallback(async (
    job: SegmentJob,
    combinedContext: string,
  ) => {
    // Caller claimed the job (status === 'processing'). Retry in-place — never re-queue
    // while this worker still owns the job (avoids double-claim by the other worker).
    const owningGen = job.sessionGen;

    while (job.attempts < MAX_SEGMENT_ATTEMPTS) {
      if (sessionGenRef.current !== owningGen) return;

      job.attempts += 1;
      await persistJob(job);
      bumpQueueUi();

      const termLockSnap = { ...termLockRef.current };
      const recentSnap = recentContextRef.current.slice(-4);
      const waiting = segmentQueueRef.current.filter((j) => j.status === 'queued').length;
      const oldestQueued = segmentQueueRef.current.find((j) => j.status === 'queued' || j.status === 'processing');
      const lagMin = oldestQueued
        ? Math.max(0, Math.round((Date.now() - oldestQueued.enqueuedAt) / 60000))
        : 0;
      setInterpretStatus('processing');
      setSessionStatusLine(
        `Translating segment ${job.segmentIndex}` +
          (lagMin > 0 ? ` · catching up · ~${lagMin} min behind` : '') +
          (waiting > 0 ? ` · ${waiting} waiting` : ''),
      );

      try {
        const wantTts = playTtsEnabledRef.current;
        const result = await interpretSegment(
          job.pcm,
          combinedContext || undefined,
          termLockSnap,
          recentSnap,
          wantTts,
        );

        if (sessionGenRef.current !== owningGen) return;

        if (result.termLock) {
          termLockRef.current = { ...termLockRef.current, ...result.termLock };
        }
        if (result.diagnostics) appendInterpretMetrics(result.diagnostics);

        const burmese = result.burmeseText?.trim() ?? '';
        const english = result.englishText?.trim() ?? '';
        if (!burmese && !english) {
          job.status = 'empty';
          if (flushedIndexesRef.current.has(job.segmentIndex)) {
            // already advanced past this index
          } else {
            pendingDisplayRef.current.set(job.segmentIndex, { english: '', burmese: '', empty: true });
          }
          pushErrorLog('warn', `Segment ${job.segmentIndex}: empty STT/MT`);
        } else if (flushedIndexesRef.current.has(job.segmentIndex)) {
          job.status = 'done';
          upsertTranslation(english, burmese, job.segmentIndex);
          if (wantTts && result.audioBase64) playTts(result.audioBase64);
        } else {
          job.status = 'done';
          pendingDisplayRef.current.set(job.segmentIndex, { english, burmese, empty: false });
          if (wantTts && result.audioBase64) playTts(result.audioBase64);
        }

        job.pcm = new ArrayBuffer(0);
        job.revision += 1;
        await updateSegment(job.localId, {
          status: job.status,
          attempts: job.attempts,
          revision: job.revision,
        });
        flushOrderedDisplay();
        bumpQueueUi();
        return;
      } catch (e) {
        if (sessionGenRef.current !== owningGen) return;
        const msg = e instanceof Error ? e.message : 'Interpret failed';
        if (job.attempts < MAX_SEGMENT_ATTEMPTS) {
          setError(`Segment ${job.segmentIndex} failed (attempt ${job.attempts}): ${msg}. Retrying…`);
          pushErrorLog('error', `Segment ${job.segmentIndex}: ${msg}`);
          await persistJob(job);
          await new Promise((r) => setTimeout(r, 2000 * job.attempts));
          continue;
        }
        job.status = 'failed';
        job.error = msg;
        if (!flushedIndexesRef.current.has(job.segmentIndex)) {
          pendingDisplayRef.current.set(job.segmentIndex, { english: '', burmese: '', empty: true });
          flushOrderedDisplay();
        }
        setFailedSegmentLocalId(job.localId);
        setError(`Segment ${job.segmentIndex} failed after ${job.attempts} attempts: ${msg}`);
        pushErrorLog('error', `Segment ${job.segmentIndex} final: ${msg}`);
        setSessionStatusLine(`Segment ${job.segmentIndex} failed — continuing with next`);
        await persistJob(job);
        bumpQueueUi();
        return;
      }
    }

    // Safety: exhausted attempts without an explicit return
    if (sessionGenRef.current === owningGen && job.status === 'processing') {
      job.status = 'failed';
      job.error = 'Exhausted retries';
      if (!flushedIndexesRef.current.has(job.segmentIndex)) {
        pendingDisplayRef.current.set(job.segmentIndex, { english: '', burmese: '', empty: true });
        flushOrderedDisplay();
      }
      setFailedSegmentLocalId(job.localId);
      await persistJob(job);
      bumpQueueUi();
    }
  }, [persistJob, bumpQueueUi, playTts, flushOrderedDisplay, pushErrorLog, upsertTranslation]);

  const drainSegmentQueue = useCallback(async () => {
    if (drainRunningRef.current) return;
    drainRunningRef.current = true;

    const combinedContext = useGlossaryAndBriefing
      ? [glossaryEntriesToText(activeProfile.glossary), activeProfile.briefing.trim()].filter(Boolean).join('\n\n')
      : '';
    const drainGen = sessionGenRef.current;

    const workerLoop = async () => {
      for (;;) {
        if (sessionGenRef.current !== drainGen) return;
        const job = segmentQueueRef.current.find((j) => j.status === 'queued');
        if (!job) return;
        // Claim synchronously so parallel workers never pick the same job.
        job.status = 'processing';
        activeWorkersRef.current += 1;
        try {
          await processOneJob(job, combinedContext);
        } finally {
          activeWorkersRef.current -= 1;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: PARALLEL_WORKERS }, () => workerLoop()));
    } finally {
      drainRunningRef.current = false;
      if (
        sessionGenRef.current === drainGen &&
        segmentQueueRef.current.some((j) => j.status === 'queued')
      ) {
        void drainSegmentQueue();
        return;
      }
    }

    if (sessionGenRef.current !== drainGen) return;

    if (sessionActiveRef.current) {
      setInterpretStatus('listening');
      setSessionStatusLine(`Recording next ~${Math.round(SEGMENT_MS / 60000)}-minute segment…`);
    } else {
      setInterpretStatus('idle');
      setSessionStatusLine('All segments finished');
    }
  }, [activeProfile, useGlossaryAndBriefing, processOneJob]);

  const enqueueSegment = useCallback((pcm: ArrayBuffer, segmentIndex: number, durationMs: number) => {
    const job: SegmentJob = {
      localId: ++jobIdRef.current,
      segmentIndex,
      pcm,
      durationMs,
      status: 'queued',
      attempts: 0,
      enqueuedAt: Date.now(),
      revision: 0,
      sessionGen: sessionGenRef.current,
    };
    segmentQueueRef.current.push(job);
    void persistJob(job);

    const bufferedMs = bufferedUnfinishedMs(segmentQueueRef.current);
    const waiting = segmentQueueRef.current.filter((j) => j.status === 'queued' || j.status === 'processing').length;
    if (bufferedMs >= WARN_BUFFERED_MS) {
      const mins = Math.round(bufferedMs / 60000);
      setSessionStatusLine(`Catching up · ~${mins} min buffered · ${waiting} segments in queue (nothing dropped)`);
      pushErrorLog('warn', `Large backlog: ${mins} min buffered, ${waiting} unfinished segments`);
    } else if (waiting > PARALLEL_WORKERS) {
      const oldest = segmentQueueRef.current.find((j) => j.status === 'queued' || j.status === 'processing');
      const lagMin = oldest ? Math.max(0, Math.round((Date.now() - oldest.enqueuedAt) / 60000)) : 0;
      setSessionStatusLine(
        `Catching up` +
          (lagMin > 0 ? ` · ~${lagMin} min behind` : '') +
          ` · ${waiting - PARALLEL_WORKERS} waiting`,
      );
    }

    bumpQueueUi();
    void drainSegmentQueue();
  }, [persistJob, bumpQueueUi, drainSegmentQueue, pushErrorLog]);

  const retryFailedSegment = useCallback(async () => {
    const job = segmentQueueRef.current.find((j) => j.localId === failedSegmentLocalId && j.status === 'failed');
    if (!job) {
      setError('Nothing left to retry for that segment.');
      return;
    }
    if (job.pcm.byteLength === 0) {
      try {
        const fromDb = await getSegmentPcm(job.localId);
        if (fromDb && fromDb.byteLength > 0) {
          job.pcm = fromDb;
        }
      } catch {
        /* ignore */
      }
    }
    if (job.pcm.byteLength === 0) {
      setError('Nothing left to retry for that segment (audio was cleared).');
      return;
    }
    job.status = 'queued';
    job.attempts = 0;
    job.error = undefined;
    job.sessionGen = sessionGenRef.current;
    setFailedSegmentLocalId(null);
    setError(null);
    void persistJob(job);
    bumpQueueUi();
    void drainSegmentQueue();
  }, [failedSegmentLocalId, bumpQueueUi, drainSegmentQueue, persistJob]);

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
    if (drainRunningRef.current || activeWorkersRef.current > 0) {
      setError('Still finishing the previous session’s translations. Wait a moment, then Start again.');
      return;
    }
    try {
      // Invalidate any leftover async work from a prior session.
      sessionGenRef.current += 1;
      const sessionGen = sessionGenRef.current;

      setTranslationSegments([]);
      recentContextRef.current = [];
      termLockRef.current = {};
      segmentQueueRef.current = [];
      jobIdRef.current = 0;
      nextDisplayIndexRef.current = 1;
      pendingDisplayRef.current.clear();
      flushedIndexesRef.current.clear();
      clearInterpretMetrics();
      setFailedSegmentLocalId(null);

      const sessionId = `session-${Date.now()}`;
      sessionIdRef.current = sessionId;
      try {
        await clearAllSegments();
      } catch {
        /* ignore IDB wipe failures */
      }

      if (sessionGenRef.current !== sessionGen) return;

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

  const visibleSegments = (testingMode || active)
    ? translationSegments
    : translationSegments.slice(-6);

  return (
    <div className={`app${active ? ' app--session' : ''}`}>
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
        </div>
        <PermissionChecker
          permissionState={permissionState}
          onDismiss={() => {}}
          onSwitchToMobileMic={() => setMode('face_to_face')}
        />
      </header>

      <main className="app__main">
        <aside className="app__sidebar">
          <div className="app__sidebar-scroll">
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
                Mode: batch segments (~1 min each, overlapping). You will be a few minutes behind — by design, for clearer Burmese→English.
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
                    <>Recording continuously · updates each ~{Math.round(SEGMENT_MS / 60000)} min. Nothing dropped if translation lags.</>
                  )}
                  {interpretStatus === 'processing' && (
                    <>Catching up…{queuedCount > 0 ? ` (${queuedCount} in queue)` : ''}</>
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
          </div>
        </aside>

        <section className="app__workspace" aria-label="Translation">
          <ConversationView
            translationText={visibleSegments.map((s) => s.text).join('\n')}
            isPlayingTts={isPlayingTts}
            testingMode={testingMode}
            segments={visibleSegments}
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
        </section>
      </main>

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
    </div>
  );
}

export default App;
