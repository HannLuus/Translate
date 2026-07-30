export type CaptureMode = 'desktop' | 'rooted_android' | 'face_to_face';

export type SttPath =
  | 'elevenlabs_scribe'
  | 'speech_api'
  | 'speech_api_refined'
  | 'gemini_audio_fallback';

export interface InterpretDiagnostics {
  latencyMs: number;
  sttConfidence: number | null;
  sttPath: SttPath;
  fallbackReason: string | null;
  emptyOutput: boolean;
  secondPassUsed: boolean;
}

/** Session-level glossary term lock (source term -> English rendering). */
export type TermLockMap = Record<string, string>;

/** Rolling bilingual context pair sent to the backend for MT continuity. */
export interface RecentContextPair {
  burmese: string;
  english: string;
}

export interface InterpretResult {
  burmeseText: string;
  englishText: string;
  audioBase64: string | null;
  diagnostics?: InterpretDiagnostics;
  termLock?: TermLockMap;
}

export interface ResponseResult {
  burmeseText: string;
  audioBase64: string | null;
}

/** Structured meeting minutes (also keeps legacy CleanSummarize field names). */
export interface MeetingMinutesResult {
  executiveSummary: string;
  chronologicalRecord: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  /** @deprecated alias of chronologicalRecord */
  cleanedTranscript: string;
  /** @deprecated alias of executiveSummary */
  summary: string;
  keyPoints?: string[];
}

/** @deprecated Use MeetingMinutesResult */
export type CleanSummarizeResult = MeetingMinutesResult;

export interface PermissionState {
  tabAudio: 'unknown' | 'granted' | 'blocked' | 'unsupported';
  microphone: 'unknown' | 'granted' | 'blocked';
}

export type GlossaryEntry = { id: number; term: string; meaning: string };

export interface ScenarioProfile {
  id: string;
  name: string;
  briefing: string;
  glossary: GlossaryEntry[];
  createdAt: number;
}

/** One translation segment shown in the conversation view. */
export interface TranslationSegment {
  id: number;
  text: string;
  shownAt: number;
  /** Filled for interpretation segments (Burmese heard); absent for response segments. */
  burmeseText?: string;
  /** Rolling segment index from capture (1-based), when applicable. */
  segmentIndex?: number;
}

export type SegmentJobStatus = 'queued' | 'processing' | 'done' | 'failed' | 'empty';

export interface SegmentJob {
  localId: number;
  segmentIndex: number;
  pcm: ArrayBuffer;
  durationMs: number;
  status: SegmentJobStatus;
  attempts: number;
  error?: string;
  enqueuedAt: number;
  /** Bumped on each persist so stale IndexedDB puts are ignored. */
  revision: number;
  /** Session generation that owns this job — workers ignore if session moved on. */
  sessionGen: number;
}
