import { useState, type KeyboardEvent } from 'react';

type Props = {
  onSend: (text: string) => void;
  disabled?: boolean;
};

export function ChatInput({ onSend, disabled }: Props) {
  const [text, setText] = useState('');

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="border-t border-white/10 bg-wine-900/40 p-3 backdrop-blur-xl">
      <div className="glass-strong mx-auto flex max-w-3xl items-end gap-2 p-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled}
          placeholder="Ask anything…  (use $…$ for inline math, $$…$$ for blocks)"
          rows={1}
          className="glass-input min-h-[44px] max-h-40 flex-1 resize-y"
          aria-label="Message"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="btn-primary"
          aria-label="Send message"
        >
          Send
        </button>
      </div>
    </div>
  );
}
