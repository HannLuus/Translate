/**
 * Merge overlapped translation segments without dropping valid new words.
 * Handles prefix/suffix overlap between consecutive English lines.
 */

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  a.forEach((w) => { if (b.has(w)) intersection++; });
  return intersection / new Set([...a, ...b]).size;
}

/** True when candidate is too similar to lastLine (duplicate from overlap). */
export function isDuplicateSegment(candidate: string, lastLine: string): boolean {
  const c = candidate.trim();
  const l = lastLine.trim();
  if (!c || !l) return false;
  if (c === l) return true;
  if (c.includes(l) || l.includes(c)) {
    const shorter = c.length <= l.length ? c : l;
    const longer = c.length > l.length ? c : l;
    if (shorter.length / longer.length >= 0.85) return true;
  }
  return jaccard(new Set(tokenize(c)), new Set(tokenize(l))) >= 0.72;
}

/** Extract only the new suffix when candidate overlaps prefix of lastLine. */
export function extractNewSuffix(candidate: string, lastLine: string): string {
  const cWords = candidate.trim().split(/\s+/);
  const lWords = lastLine.trim().split(/\s+/);
  if (cWords.length === 0 || lWords.length === 0) return candidate.trim();

  let maxOverlap = 0;
  const maxCheck = Math.min(lWords.length, cWords.length, 12);
  for (let n = maxCheck; n >= 2; n--) {
    const lTail = lWords.slice(-n).join(' ').toLowerCase();
    const cHead = cWords.slice(0, n).join(' ').toLowerCase();
    if (lTail === cHead) {
      maxOverlap = n;
      break;
    }
  }

  if (maxOverlap === 0) return candidate.trim();
  const suffix = cWords.slice(maxOverlap).join(' ').trim();
  return suffix || candidate.trim();
}
