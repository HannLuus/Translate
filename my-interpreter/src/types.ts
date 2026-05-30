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

export interface CleanSummarizeResult {
  cleanedTranscript: string;
  summary: string;
  keyPoints?: string[];
}

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
}

