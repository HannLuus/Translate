import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Mic } from 'lucide-react';
import { responseAudio, type ResponseAudioResult } from '../api';
import type { ResponseResult } from '../types';

interface ResponseButtonProps {
  onResult: (result: ResponseResult) => void;
  onError: (err: Error) => void;
  disabled?: boolean;
  /** When true, play the Burmese TTS from the response over the speaker. */
  playTtsEnabled?: boolean;
}

const SAMPLE_RATE = 16000;
// Match backend MIN_AUDIO_BYTES (0.5 s at 16 kHz 16-bit) so we don't send too-short audio
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2;

const WORKLET_URL = new URL(
  `${import.meta.env.BASE_URL}audio-processor.worklet.js`,
  import.meta.url
).href;

/** Convert worklet Float32Array frame to 16-bit PCM. Guards against null/undefined and zero length. */
function floatTo16BitPcm(frame: Float32Array | null | undefined): ArrayBuffer {
  if (frame == null || !(frame instanceof Float32Array) || frame.length === 0) {
    return new Int16Array(0).buffer;
  }
  const len = frame.length;
  const int16 = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, frame[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16.buffer;
}

export function ResponseButton({
  onResult,
  onError,
  disabled,
  playTtsEnabled = false,
}: ResponseButtonProps) {
  const [recording, setRecording] = useState(false);
  const stopRef = useRef<(() => ArrayBuffer) | null>(null);

  const startRecording = useCallback(() => {
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: SAMPLE_RATE,
        },
      })
      .then(async (stream) => {
        const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        if (audioContext.state === 'suspended') {
          audioContext.resume().catch(() => {});
        }
        await audioContext.audioWorklet.addModule(WORKLET_URL);

        const source = audioContext.createMediaStreamSource(stream);
        const buffer: Int16Array[] = [];
        const node = new AudioWorkletNode(audioContext, 'capture-processor', {
          processorOptions: { frameSize: 4096 },
        });
        node.port.onmessage = (e: MessageEvent<{ frame?: Float32Array }>) => {
          try {
            const data = e?.data;
            const frame = data && (data as { frame?: Float32Array }).frame;
            if (frame == null || typeof (frame as Float32Array).length !== 'number') return;
            const ab = floatTo16BitPcm(frame instanceof Float32Array ? frame : undefined);
            if (ab.byteLength > 0) buffer.push(new Int16Array(ab));
          } catch {
            // Defensive: malformed worklet messages must not break recording
          }
        };
        source.connect(node);
        node.connect(audioContext.destination);
        setRecording(true);

        stopRef.current = () => {
          node.disconnect();
          source.disconnect();
          audioContext.close();
          stream.getTracks().forEach((t) => t.stop());
          const valid = buffer.filter((b) => b && typeof b.length === 'number');
          const totalLength = valid.reduce((acc, b) => acc + b.length, 0);
          const merged = new Int16Array(totalLength);
          let offset = 0;
          for (const b of valid) {
            merged.set(b, offset);
            offset += b.length;
          }
          return merged.buffer;
        };
      })
      .catch((err) => onError(err instanceof Error ? err : new Error(String(err))));
  }, [onError]);

  const stopAndSend = useCallback(() => {
    const stop = stopRef.current;
    if (!stop) return;
    const pcm = stop();
    stopRef.current = null;
    setRecording(false);
    if (!pcm || pcm.byteLength < MIN_AUDIO_BYTES) {
      onError(new Error('Recording too short — speak for at least half a second'));
      return;
    }
    responseAudio(pcm)
      .then((data: ResponseAudioResult) => {
        const burmeseText = data && typeof data.burmeseText === 'string' ? data.burmeseText : '';
        const audioBase64 = data && data.audioBase64 != null ? data.audioBase64 : null;
        onResult({ burmeseText, audioBase64 });
        if (playTtsEnabled && audioBase64) {
          const audio = new Audio('data:audio/mp3;base64,' + audioBase64);
          audio.play().catch(() => {});
        }
      })
      .catch(onError);
  }, [onResult, onError, playTtsEnabled]);

  return (
    <motion.button
      type="button"
      className={`response-btn ${recording ? 'response-btn--recording' : ''}`}
      onClick={recording ? stopAndSend : startRecording}
      disabled={disabled}
      whileTap={{ scale: 0.98 }}
    >
      <Mic size={20} aria-hidden />
      <span>{recording ? 'Stop & send' : 'Response'}</span>
    </motion.button>
  );
}
