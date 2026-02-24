import { useEffect, useRef } from 'react';

interface ConversationViewProps {
  translationText: string;
  isPlayingTts: boolean;
}

export function ConversationView({
  translationText,
  isPlayingTts,
}: ConversationViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [translationText]);

  return (
    <div className="conversation-view">
      <div className="conversation-view__panel conversation-view__panel--translation">
        <p className="conversation-view__label">
          Translation{isPlayingTts && ' — playing'}
        </p>
        <div ref={contentRef} className="conversation-view__content">
          {translationText || (
            <span className="conversation-view__placeholder">
              Translation will appear here…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
