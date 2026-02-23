let wakeLock: WakeLockSentinel | null = null;

export async function requestWakeLock(): Promise<boolean> {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await (navigator as Navigator & { wakeLock: WakeLockAPI }).wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    return true;
  } catch {
    return false;
  }
}

export function releaseWakeLock(): void {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

interface WakeLockAPI {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}
