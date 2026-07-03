import { Markdown } from '../../shared/ui/Markdown';
import type { ChatMessage } from '../../shared/types/contracts';

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <article
      className={isUser ? 'self-end max-w-[85%] animate-fade-in' : 'self-start max-w-[92%] animate-fade-in'}
      aria-label={isUser ? 'Your message' : 'Assistant message'}
    >
      <div
        className={
          'glass px-4 py-3 text-sm ' +
          (isUser ? 'rounded-2xl rounded-br-sm bg-rose-500/20' : 'rounded-2xl rounded-bl-sm')
        }
      >
        {message.content
          ? <Markdown source={message.content} />
          : <span className="inline-block h-3 w-24 animate-pulse rounded bg-white/20" />}
        
        {message.layer && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-widest text-rose-100/50 items-center">
            <span>via</span>
            {(message.sources?.length ? message.sources : [message.layer]).map((s) => (
              <span key={s} className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}