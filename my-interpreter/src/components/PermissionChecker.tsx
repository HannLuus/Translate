import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, X } from 'lucide-react';
import type { PermissionState } from '../types';

interface PermissionCheckerProps {
  permissionState: PermissionState;
  onDismiss: () => void;
  onSwitchToMobileMic: () => void;
}

export function PermissionChecker({
  permissionState,
  onDismiss,
  onSwitchToMobileMic,
}: PermissionCheckerProps) {
  const [dismissed, setDismissed] = useState(false);
  const micBlocked = permissionState.microphone === 'blocked';
  const show = !dismissed && micBlocked;

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss();
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="permission-banner"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          role="alert"
        >
          <AlertCircle size={20} aria-hidden />
          <div className="permission-banner__text">
            <strong>Tab Audio or Microphone is restricted.</strong> Use{' '}
            <strong>Mobile Mic Mode (Face-to-Face)</strong> as a backup. Tab Audio
            (single tab) is usually allowed by IT; System Audio is often blocked.
          </div>
          <div className="permission-banner__actions">
            <button
              type="button"
              className="permission-banner__btn"
              onClick={onSwitchToMobileMic}
            >
              Switch to Mobile Mic
            </button>
            <button
              type="button"
              className="permission-banner__dismiss"
              onClick={handleDismiss}
              aria-label="Dismiss"
            >
              <X size={18} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export async function checkPermissions(): Promise<PermissionState> {
  const state: PermissionState = {
    tabAudio: 'unknown',
    microphone: 'unknown',
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.microphone = 'granted';
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    state.microphone = 'blocked';
  }

  // Do not call getDisplayMedia on load (it would open the share dialog).
  // Tab audio permission is discovered when user starts Desktop mode.
  return state;
}
