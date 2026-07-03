import { Markdown } from '../../shared/ui/Markdown';
import type { ChatMessage } from '../../shared/types/contracts';

type BubbleAttachment = { filename: string; previewUrl?: string };

export function MessageBubble({
  message,
  attachments
}: {
  message: ChatMessage;
  /**
   * Optional UI-only metadata for messages that included files. The server
   * contract is `ChatMessage`; this is purely visual context that the
   * ChatWindow threads in from optimistic state.
   */
  attachments?: BubbleAttachment[];
}) {
  const isUser = message.role === 'user';
  const hasAttachments = isUser && attachments && attachments.length > 0;
  return (
    <article
      className={
        (isUser ? 'self-end max-w-[80%]' : 'self-start max-w-[92%]') + ' animate-fade-in'
      }
      aria-label={isUser ? 'Your message' : 'Assistant message'}
    >
      <div
        className={
          (isUser
            ? 'rounded-2xl rounded-br-sm border border-white/10 px-4 py-2.5 text-sm text-white shadow-[0_4px_18px_-8px_var(--primary-halo)] '
            : 'glass rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-theme-main ')
        }
        style={
          isUser
            ? {
                backgroundImage:
                  'linear-gradient(135deg, var(--accent-from), var(--accent-to))',
              }
            : undefined
        }
      >
        {hasAttachments && (
          <div className="mb-2 flex flex-wrap gap-1.5 border-b border-white/15 pb-2">
            {attachments!.map((a, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-md bg-black/30 px-2 py-0.5 text-[11px] font-medium"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                {a.filename}
              </span>
            ))}
          </div>
        )}
        {message.content
          ? <Markdown source={message.content} />
          : <span className="inline-block h-3 w-24 animate-pulse rounded bg-white/20" />}
      </div>
    </article>
  );
}