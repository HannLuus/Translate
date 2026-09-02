import { useRef } from 'react';
import { motion } from 'framer-motion';
import { Monitor, Smartphone, Mic, Upload, CheckCircle2, CircleDot } from 'lucide-react';
import type { CaptureMode } from '../types';

const MODES: { id: CaptureMode; label: string; icon: typeof Monitor }[] = [
  { id: 'record_meeting', label: 'Record meeting (Teams)', icon: CircleDot },
  { id: 'desktop', label: 'Desktop (Work PC)', icon: Monitor },
  { id: 'rooted_android', label: 'Rooted Android', icon: Smartphone },
  { id: 'face_to_face', label: 'Face-to-Face (Mic)', icon: Mic },
  { id: 'upload_recording', label: 'From file', icon: Upload },
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
  uploadMinutesOnly?: boolean;
  onUploadMinutesOnlyChange?: (value: boolean) => void;
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
  uploadMinutesOnly = false,
  onUploadMinutesOnlyChange,
}: PlatformSelectorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      {mode === 'record_meeting' && !disabled && (
        <p className="platform-selector__hint platform-selector__hint--english">
          Records <strong>both sides</strong>: Teams tab audio (other people) plus your microphone (you).
          When you click Start, allow <strong>screen/tab share with audio</strong> and your <strong>microphone</strong>.
          Headphones recommended so your voice is not picked up twice.
        </p>
      )}
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
          <p className="platform-selector__upload-intro">
            Use a recording you already have (MP3, WAV, M4A, WebM).
          </p>
          <ol className="platform-selector__upload-steps">
            <li className={uploadFile ? 'done' : 'current'}>
              <span className="platform-selector__step-num">1</span>
              <span>Choose your audio file</span>
            </li>
            <li className={uploadFile ? 'current' : ''}>
              <span className="platform-selector__step-num">2</span>
              <span>Click <strong>Start processing</strong> below</span>
            </li>
          </ol>
          <input
            ref={fileInputRef}
            key={uploadFileInputKey}
            id="upload-recording-file"
            type="file"
            accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg,.aac,.mp4"
            className="platform-selector__file platform-selector__file--hidden"
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              onUploadFileChange(file);
            }}
          />
          <button
            type="button"
            className="platform-selector__choose-file"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadFile ? 'Change file…' : 'Choose recording file…'}
          </button>
          {uploadFile ? (
            <p className="platform-selector__file-ready" title={uploadFile.name}>
              <CheckCircle2 size={16} aria-hidden />
              <span>
                Ready: {uploadFile.name}
                {uploadFile.size > 0
                  ? ` · ${(uploadFile.size / (1024 * 1024)).toFixed(1)} MB`
                  : ''}
              </span>
            </p>
          ) : (
            <p className="platform-selector__file-hint" role="status">
              No file chosen yet.
            </p>
          )}
          <label className="platform-selector__english-only">
            <input
              type="checkbox"
              checked={uploadMinutesOnly}
              onChange={(e) => onUploadMinutesOnlyChange?.(e.target.checked)}
              disabled={disabled}
            />
            <span>English meeting — generate minutes only (skip Burmese translation)</span>
          </label>
          {!uploadMinutesOnly && (
            <p className="platform-selector__hint">
              Uses your scenario profile for Burmese→English interpretation. Long recordings (1–2 hours) work on desktop.
            </p>
          )}
        </motion.div>
      )}
    </div>
  );
}
