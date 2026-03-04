export type CaptureMode = 'desktop' | 'rooted_android' | 'face_to_face';

export interface InterpretResult {
  burmeseText: string;
  englishText: string;
  audioBase64: string | null;
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

/** One translation segment shown in the conversation view. */
export interface TranslationSegment {
  id: number;
  text: string;
  shownAt: number;
  /** Filled for interpretation segments (Burmese heard); absent for response segments. */
  burmeseText?: string;
}
