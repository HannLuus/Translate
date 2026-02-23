interface ConversationViewProps {
  burmeseText: string;
  englishText: string;
  isPlayingTts: boolean;
}

export function ConversationView({
  burmeseText,
  englishText,
  isPlayingTts,
}: ConversationViewProps) {
  return (
    <div className="conversation-view">
      <div className="conversation-view__panel conversation-view__panel--burmese">
        <p className="conversation-view__label">Burmese (speaker)</p>
        <div className="conversation-view__content">
          {burmeseText || (
            <span className="conversation-view__placeholder">
              Transcribed Burmese will appear here…
            </span>
          )}
        </div>
      </div>
      <div className="conversation-view__panel conversation-view__panel--english">
        <p className="conversation-view__label">
          English (you){isPlayingTts && ' — playing'}
        </p>
        <div className="conversation-view__content">
          {englishText || (
            <span className="conversation-view__placeholder">
              Translated English will appear here…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
