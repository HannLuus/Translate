import { useEffect, useRef } from 'react';
import type { TranslationSegment } from '../types';

interface ConversationViewProps {
  translationText: string;
  isPlayingTts: boolean;
  testingMode?: boolean;
  segments?: TranslationSegment[];
}

export function ConversationView({
  translationText,
  isPlayingTts,
  testingMode = false,
  segments,
}: ConversationViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const showScript = testingMode && segments && segments.length > 0;

  useEffect(() => {
    const el = contentRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [translationText, segments?.length]);

  return (
    <div className="conversation-view">
      <div className="conversation-view__panel conversation-view__panel--translation">
        <p className="conversation-view__label">
          Translation{isPlayingTts && ' — playing'}
          {showScript && ' (testing — full script)'}
        </p>
        <div ref={contentRef} className="conversation-view__content">
          {showScript ? (
            <div className="conversation-view__script">
              {segments!.map((s) => (
                <div key={s.id} className="conversation-view__segment">
                  {s.burmeseText != null && s.burmeseText !== '' ? (
                    <>
                      <span className="conversation-view__burmese">{s.burmeseText}</span>
                      <span className="conversation-view__segment-sep"> → </span>
                      <span className="conversation-view__english">{s.text}</span>
                    </>
                  ) : (
                    <span className="conversation-view__response">Response: {s.text}</span>
                  )}
                </div>
              ))}
            </div>
          ) : translationText ? (
            translationText
          ) : (
            <span className="conversation-view__placeholder">
              Translation will appear here…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
