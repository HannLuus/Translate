import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { PlatformSelector } from './components/PlatformSelector';
import { PermissionChecker, checkPermissions } from './components/PermissionChecker';
import { ConversationView } from './components/ConversationView';
import { WavizVisualizer } from './components/WavizVisualizer';
import { ResponseButton } from './components/ResponseButton';
import { getCaptureStream, captureAudioChunks } from './audioCapture';
import { interpretAudio } from './api';
import { requestWakeLock, releaseWakeLock } from './wakeLock';
import type { CaptureMode, PermissionState } from './types';
import './App.css';

const MODE_STORAGE_KEY = 'interpreter-capture-mode';
const LOOPBACK_STORAGE_KEY = 'interpreter-loopback-device-id';

function App() {
  const [mode, setMode] = useState<CaptureMode>(() => {
    const s = localStorage.getItem(MODE_STORAGE_KEY);
    return (s === 'desktop' || s === 'rooted_android' || s === 'face_to_face')
      ? s
      : 'face_to_face';
  });
  const [loopbackDeviceId, setLoopbackDeviceId] = useState(() => {
    return localStorage.getItem(LOOPBACK_STORAGE_KEY) ?? '';
  });
  const [permissionState, setPermissionState] = useState<PermissionState>({
    tabAudio: 'unknown',
    microphone: 'unknown',
  });
  const [burmeseText, setBurmeseText] = useState('');
  const [englishText, setEnglishText] = useState('');
  const [isPlayingTts, setIsPlayingTts] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captureStream, setCaptureStream] = useState<MediaStream | null>(null);
  const stopCaptureRef = useRef<(() => void) | null>(null);
  const currentTtsRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    checkPermissions().then(setPermissionState);
  }, []);

  useEffect(() => {
    const rerequest = () => {
      if (document.visibilityState === 'visible' && active) requestWakeLock();
    };
    document.addEventListener('visibilitychange', rerequest);
    return () => document.removeEventListener('visibilitychange', rerequest);
  }, [active]);

  useEffect(() => {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);
  useEffect(() => {
    localStorage.setItem(LOOPBACK_STORAGE_KEY, loopbackDeviceId);
  }, [loopbackDeviceId]);

  const playTts = useCallback((base64: string) => {
    if (currentTtsRef.current) {
      currentTtsRef.current.pause();
      currentTtsRef.current = null;
    }
    const audio = new Audio('data:audio/mp3;base64,' + base64);
    currentTtsRef.current = audio;
    setIsPlayingTts(true);
    audio.play();
    audio.onended = () => {
      currentTtsRef.current = null;
      setIsPlayingTts(false);
    };
  }, []);

  const startInterpretation = useCallback(async () => {
    setError(null);
    if (mode === 'rooted_android' && !loopbackDeviceId.trim()) {
      setError('Enter a loopback device ID for Rooted Android, or switch to Face-to-Face (Mic) mode.');
      return;
    }
    try {
      const stream = await getCaptureStream(
        mode,
        mode === 'rooted_android' ? loopbackDeviceId.trim() || undefined : undefined
      );
      setCaptureStream(stream);
      setActive(true);
      await requestWakeLock();

      const stop = captureAudioChunks(stream, async (pcm) => {
          try {
            const result = await interpretAudio(pcm);
            if (result.burmeseText) setBurmeseText(result.burmeseText);
            if (result.englishText) setEnglishText(result.englishText);
            if (result.audioBase64) playTts(result.audioBase64);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Interpret failed');
          }
        });
      stopCaptureRef.current = () => {
        stop();
        stream.getTracks().forEach((t) => t.stop());
        setCaptureStream(null);
        releaseWakeLock();
        setActive(false);
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start capture');
    }
  }, [mode, loopbackDeviceId, playTts]);

  const stopInterpretation = useCallback(() => {
    stopCaptureRef.current?.();
    stopCaptureRef.current = null;
  }, []);

  const handleResponseResult = useCallback((result: { burmeseText: string }) => {
    setBurmeseText((prev) => (prev ? prev + '\n\n' : '') + result.burmeseText);
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Burmese–English Interpreter</h1>
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

        <WavizVisualizer
          stream={captureStream}
          active={active}
        />

        <ConversationView
          burmeseText={burmeseText}
          englishText={englishText}
          isPlayingTts={isPlayingTts}
        />

        <div className="app__response">
          <ResponseButton
            onResult={handleResponseResult}
            onError={(e) => setError(e.message)}
            disabled={active}
          />
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
