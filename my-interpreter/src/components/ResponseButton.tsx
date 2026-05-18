import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Mic } from 'lucide-react';
import { responseAudio, type ResponseAudioResult } from '../api';
import { floatTo16BitPcm, downsampleTo16khz } from '../audioCapture';
import type { ResponseResult } from '../types';

interface ResponseButtonProps {
  onResult: (result: ResponseResult) => void;
  onError: (err: Error) => void;
  disabled?: boolean;
  /** When true, play the Burmese TTS from the response over the speaker. */
  playTtsEnabled?: boolean;
}

// Match backend MIN_AUDIO_BYTES (0.5 s at 16 kHz 16-bit)
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2;

const WORKLET_URL = new URL(
  `${import.meta.env.BASE_URL}audio-processor.worklet.js`,
  import.meta.url
).href;

export function ResponseButton({
  onResult,
  onError,
  disabled,
  playTtsEnabled = false,
}: ResponseButtonProps) {
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const stopRef = useRef<(() => ArrayBuffer) | null>(null);
  const captureSampleRateRef = useRef(48000);

  const startRecording = useCallback(() => {
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      .then(async (stream) => {
        const audioContext = new AudioContext();
        captureSampleRateRef.current = audioContext.sampleRate;
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
            const frame = e?.data?.frame;
            if (!(frame instanceof Float32Array) || frame.length === 0) return;
            const pcm16k = downsampleTo16khz(
              floatTo16BitPcm(frame),
              captureSampleRateRef.current,
            );
            if (pcm16k.length > 0) buffer.push(pcm16k);
          } catch {
            // Malformed worklet messages must not break recording
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
    if (!stop || sending) return;
    const pcm = stop();
    stopRef.current = null;
    setRecording(false);
    if (!pcm || pcm.byteLength < MIN_AUDIO_BYTES) {
      onError(new Error('Recording too short — speak for at least half a second'));
      return;
    }
    setSending(true);
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
      .catch((err) => onError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setSending(false));
  }, [onResult, onError, playTtsEnabled, sending]);

  return (
    <motion.button
      type="button"
      className={`response-btn ${recording ? 'response-btn--recording' : ''} ${sending ? 'response-btn--sending' : ''}`}
      onClick={recording ? stopAndSend : startRecording}
      disabled={disabled || sending}
      whileTap={{ scale: 0.98 }}
      aria-busy={sending}
    >
      <Mic size={20} aria-hidden />
      <span>
        {sending ? 'Translating…' : recording ? 'Stop & send' : 'Response'}
      </span>
    </motion.button>
  );
}
