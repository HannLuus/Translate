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

export interface PermissionState {
  tabAudio: 'unknown' | 'granted' | 'blocked' | 'unsupported';
  microphone: 'unknown' | 'granted' | 'blocked';
}
