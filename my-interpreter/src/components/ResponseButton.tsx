import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Mic } from 'lucide-react';
import { responseAudio } from '../api';
import type { ResponseResult } from '../types';

interface ResponseAudioResult {
  englishText: string;
  burmeseText: string;
  audioBase64: string | null;
}

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

function floatTo16BitPcm(float32: Float32Array): ArrayBuffer {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
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
          processorOptions: { chunkSize: 4096 },
        });
        node.port.onmessage = (e: MessageEvent<{ chunk: Float32Array }>) => {
          const int16 = new Int16Array(floatTo16BitPcm(e.data.chunk) as ArrayBuffer);
          buffer.push(int16);
        };
        source.connect(node);
        node.connect(audioContext.destination);
        setRecording(true);

        stopRef.current = () => {
          node.disconnect();
          source.disconnect();
          audioContext.close();
          stream.getTracks().forEach((t) => t.stop());
          const totalLength = buffer.reduce((acc, b) => acc + b.length, 0);
          const merged = new Int16Array(totalLength);
          let offset = 0;
          for (const b of buffer) {
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
        onResult({ burmeseText: data.burmeseText, audioBase64: data.audioBase64 });
        if (playTtsEnabled && data.audioBase64) {
          const audio = new Audio('data:audio/mp3;base64,' + data.audioBase64);
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
