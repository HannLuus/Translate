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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [translationText, segments?.length]);

  const lines = translationText ? translationText.split('\n').filter(Boolean) : [];

  return (
    <div className="conversation-view">
      <div className="conversation-view__panel conversation-view__panel--translation">
        <p className="conversation-view__label">
          Translation{isPlayingTts && ' — playing'}
          {testingMode && ' (testing — full script)'}
        </p>
        <div className="conversation-view__content">
          {testingMode && segments && segments.length > 0 ? (
            <div className="conversation-view__script">
              {segments.map((s) => (
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
          ) : lines.length > 0 ? (
            <div className="conversation-view__live">
              {lines.map((line, i) => (
                <div
                  key={i}
                  className={`conversation-view__live-line${i === lines.length - 1 ? ' conversation-view__live-line--latest' : ''}`}
                >
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <span className="conversation-view__placeholder">
              Translation will appear here…
            </span>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
