export interface SttAlternative {
  transcript: string;
  confidence: number;
}

export interface SttResult {
  transcript: string;
  confidence: number;
  alternatives: SttAlternative[];
  model: string;
}

export type SttPath =
  | 'elevenlabs_scribe'
  | 'speech_api'
  | 'speech_api_refined'
  | 'gemini_audio_fallback';
