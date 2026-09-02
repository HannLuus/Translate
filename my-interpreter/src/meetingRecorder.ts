/** Record tab/window audio to a single file — no live transcription. */
export async function startMeetingRecording(stream: MediaStream): Promise<{
  stop: () => Promise<File>;
}> {
  if (stream.getAudioTracks().length === 0) {
    throw new Error(
      'No audio in shared tab. Choose the Teams tab and check "Share tab audio" when starting.',
    );
  }

  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  if (!mimeType) {
    throw new Error('This browser cannot record meeting audio.');
  }

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  recorder.start(1000);

  const stop = (): Promise<File> =>
    new Promise((resolve, reject) => {
      if (recorder.state === 'inactive') {
        reject(new Error('Recording already stopped.'));
        return;
      }

      recorder.onstop = () => {
        if (chunks.length === 0) {
          reject(new Error('Recording is empty. Share tab audio when selecting the meeting tab.'));
          return;
        }
        const blob = new Blob(chunks, { type: mimeType });
        const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
        resolve(
          new File([blob], `meeting-recording-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.${ext}`, {
            type: blob.type,
          }),
        );
      };

      recorder.onerror = () => reject(new Error('Recording failed in the browser.'));

      try {
        recorder.stop();
      } catch (e) {
        reject(e instanceof Error ? e : new Error('Could not stop recording.'));
      }
    });

  return { stop };
}
