/** Normalized glossary entry for STT biasing and translation consistency. */
export interface GlossaryHint {
  term: string;
  meaning: string;
}

/** Session-level term lock: source term -> preferred English rendering. */
export type TermLockMap = Record<string, string>;

const GLOSSARY_LINE_RE = /^(.+?)\s*[=:]\s*(.+)$/;

/** Parse glossary/briefing text into structured hints. */
export function parseGlossaryHints(meetingContext?: string | null): GlossaryHint[] {
  if (!meetingContext?.trim()) return [];
  const hints: GlossaryHint[] = [];
  const seen = new Set<string>();

  for (const line of meetingContext.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(GLOSSARY_LINE_RE);
    if (!match) continue;
    const term = match[1].trim();
    const meaning = match[2].trim();
    if (!term || !meaning) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({ term, meaning });
  }

  return hints.slice(0, 50);
}

/** Build Speech API v2 inline phrase hints from glossary terms. */
export function buildPhraseHints(hints: GlossaryHint[]): { value: string; boost: number }[] {
  return hints
    .map((h) => ({ value: h.term.trim(), boost: 15 }))
    .filter((p) => p.value.length > 0)
    .slice(0, 40);
}

/** Append glossary guidance to translation system context. */
export function buildTerminologyPrompt(hints: GlossaryHint[], termLock?: TermLockMap): string {
  if (hints.length === 0 && (!termLock || Object.keys(termLock).length === 0)) return '';

  const lines: string[] = ['TERMINOLOGY (use consistently; do not invent terms not in the audio):'];
  for (const h of hints) {
    lines.push(`- "${h.term}" => "${h.meaning}"`);
  }
  if (termLock && Object.keys(termLock).length > 0) {
    lines.push('', 'LOCKED RENDERINGS FROM THIS SESSION (must reuse exactly):');
    for (const [term, rendering] of Object.entries(termLock)) {
      lines.push(`- "${term}" => "${rendering}"`);
    }
  }
  return lines.join('\n');
}

/** Apply session term lock to English output when glossary terms appear in Burmese source. */
export function applyTermLock(
  burmeseText: string,
  englishText: string,
  hints: GlossaryHint[],
  termLock: TermLockMap,
): { englishText: string; termLock: TermLockMap } {
  const updatedLock = { ...termLock };
  let out = englishText;

  for (const h of hints) {
    if (!h.term || !h.meaning) continue;
    if (!burmeseText.includes(h.term)) continue;

    const key = h.term.toLowerCase();
    const locked = updatedLock[key] ?? h.meaning;
    updatedLock[key] = locked;

    const escaped = h.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    if (re.test(out)) continue;

    // If translation omitted glossary term, append canonical rendering once.
    if (!out.toLowerCase().includes(locked.toLowerCase())) {
      out = `${out.trim()} (${locked})`.trim();
    }
  }

  return { englishText: out, termLock: updatedLock };
}
