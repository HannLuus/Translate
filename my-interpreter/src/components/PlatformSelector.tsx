import { motion } from 'framer-motion';
import { Monitor, Smartphone, Mic, Upload } from 'lucide-react';
import type { CaptureMode } from '../types';

const MODES: { id: CaptureMode; label: string; icon: typeof Monitor }[] = [
  { id: 'desktop', label: 'Desktop (Work PC)', icon: Monitor },
  { id: 'rooted_android', label: 'Rooted Android', icon: Smartphone },
  { id: 'face_to_face', label: 'Face-to-Face (Mic)', icon: Mic },
  { id: 'upload_recording', label: 'Upload recording', icon: Upload },
];

interface PlatformSelectorProps {
  mode: CaptureMode;
  onModeChange: (mode: CaptureMode) => void;
  loopbackDeviceId: string;
  onLoopbackDeviceIdChange: (id: string) => void;
  uploadFile: File | null;
  onUploadFileChange: (file: File | null) => void;
  uploadFileInputKey?: number;
  disabled?: boolean;
}

export function PlatformSelector({
  mode,
  onModeChange,
  loopbackDeviceId,
  onLoopbackDeviceIdChange,
  uploadFile,
  onUploadFileChange,
  uploadFileInputKey = 0,
  disabled = false,
}: PlatformSelectorProps) {
  return (
    <div className="platform-selector">
      <p className="platform-selector__label">Capture mode</p>
      <div className="platform-selector__buttons">
        {MODES.map(({ id, label, icon: Icon }) => (
          <motion.button
            key={id}
            type="button"
            className={`platform-selector__btn ${mode === id ? 'active' : ''}`}
            onClick={() => !disabled && onModeChange(id)}
            disabled={disabled}
            whileTap={{ scale: 0.98 }}
          >
            <Icon size={18} aria-hidden />
            <span>{label}</span>
          </motion.button>
        ))}
      </div>
      {mode === 'rooted_android' && (
        <motion.div
          className="platform-selector__loopback"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
        >
          <label htmlFor="loopback-device-id">
            Loopback device ID (paste from companion app or system settings)
          </label>
          <input
            id="loopback-device-id"
            type="text"
            value={loopbackDeviceId}
            onChange={(e) => onLoopbackDeviceIdChange(e.target.value)}
            placeholder="e.g. default or device ID"
            className="platform-selector__input"
            disabled={disabled}
          />
          <p className="platform-selector__hint">
            On rooted Android, use an app that exposes system audio as a virtual
            device and paste its device ID here. Get the ID from your audio app
            settings or <code>getUserMedia</code> device list.
          </p>
        </motion.div>
      )}
      {mode === 'upload_recording' && (
        <motion.div
          className="platform-selector__upload"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
        >
          <label htmlFor="upload-recording-file">Meeting recording (Burmese audio)</label>
          <input
            key={uploadFileInputKey}
            id="upload-recording-file"
            type="file"
            accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg,.aac,.mp4"
            className="platform-selector__file"
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              onUploadFileChange(file);
            }}
          />
          {uploadFile && (
            <p className="platform-selector__file-name" title={uploadFile.name}>
              {uploadFile.name}
              {uploadFile.size > 0
                ? ` · ${(uploadFile.size / (1024 * 1024)).toFixed(1)} MB`
                : ''}
            </p>
          )}
          <p className="platform-selector__hint">
            Download the meeting recording, then Start. Uses your scenario profile
            (people, topic, glossary) for better transcription and translation.
            Works best with MP3, WAV, M4A, or WebM. Long files (over ~2 hours) may
            strain phone memory — prefer desktop for very long meetings.
          </p>
        </motion.div>
      )}
    </div>
  );
}
