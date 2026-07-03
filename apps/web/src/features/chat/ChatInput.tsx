import { useEffect, useRef, useState, type KeyboardEvent, type ChangeEvent } from 'react';
import { uploadFile, type UploadResult } from '../../shared/lib/api';

type Props = {
  onSend: (
    text: string,
    attachmentIds: string[],
    attachmentMeta: { filename: string; previewUrl?: string }[]
  ) => void;
  disabled?: boolean;
};

type PendingAttachment = {
  /** local-only id while uploading */
  key: string;
  filename: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  progress: number;
  serverId?: string;
  previewUrl?: string;
  errorMessage?: string;
};

const ACCEPT = '.pdf,application/pdf,image/png,image/jpeg,image/jpg,image/webp,image/gif';
const ACCEPT_HINT = 'PDF or image · max 25 MB';

export function ChatInput({ onSend, disabled }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composeRef = useRef<HTMLDivElement>(null);

  // Drag-and-drop on the composer itself.
  useEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    function onDragOver(e: DragEvent) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
    async function onDrop(e: DragEvent) {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const f of files) await queueFile(f);
    }
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, []);

  function pickFiles() {
    fileInputRef.current?.click();
  }

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-selecting the same file
    for (const f of files) await queueFile(f);
  }

  async function queueFile(file: File) {
    const key = crypto.randomUUID();
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
    setAttachments((prev) => [
      ...prev,
      { key, filename: file.name, size: file.size, status: 'uploading', progress: 0, previewUrl }
    ]);
    const res: UploadResult = await uploadFile(file, {
      onProgress: (pct) => {
        setAttachments((prev) =>
          prev.map((a) => (a.key === key ? { ...a, progress: pct } : a))
        );
      }
    });
    if (!res.ok) {
      setAttachments((prev) =>
        prev.map((a) =>
          a.key === key ? { ...a, status: 'error', errorMessage: res.error.message } : a
        )
      );
      return;
    }
    setAttachments((prev) =>
      prev.map((a) =>
        a.key === key
          ? { ...a, status: 'ready', progress: 100, serverId: res.data.attachment.id }
          : a
      )
    );
  }

  function removeAttachment(key: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.key === key);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.key !== key);
    });
  }

  function submit() {
    const t = text.trim();
    const ready = attachments.filter((a) => a.status === 'ready' && a.serverId);
    const readyIds = ready.map((a) => a.serverId!);
    const meta = ready.map((a) => ({ filename: a.filename, ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}) }));
    if ((!t && readyIds.length === 0) || disabled) return;
    onSend(t, readyIds, meta);
    setText('');
    // Clean up preview URLs; the ChatWindow now owns the previewUrl per message.
    setAttachments((prev) => {
      prev.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
      return [];
    });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const hasReady = attachments.some((a) => a.status === 'ready');
  const hasUploading = attachments.some((a) => a.status === 'uploading');
  const canSend = !disabled && (text.trim().length > 0 || hasReady);

  return (
    <div className="border-t border-white/10 bg-black/30 p-3 backdrop-blur-xl">
      <div className="mx-auto max-w-3xl">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.key}
                att={a}
                onRemove={() => removeAttachment(a.key)}
              />
            ))}
          </div>
        )}
        <div
          ref={composeRef}
          className="glass-strong relative flex items-end gap-1 rounded-2xl p-1.5 transition focus-within:shadow-[0_0_0_1px_var(--primary-glow-2),0_0_18px_-2px_var(--primary-halo)]"
        >
          <button
            type="button"
            onClick={pickFiles}
            disabled={disabled}
            title={`Attach file — ${ACCEPT_HINT}`}
            aria-label="Attach file"
            className="grid h-9 w-9 shrink-0 place-items-center self-end rounded-xl text-theme-muted transition hover:bg-white/10 hover:text-theme-strong disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={onFiles}
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={disabled}
            placeholder={attachments.length > 0 ? 'Ask about the attached file(s)…' : 'Ask anything…'}
            rows={1}
            className="min-h-[44px] max-h-40 flex-1 resize-y rounded-xl bg-transparent px-3 py-2 text-sm text-theme-strong placeholder:text-theme-muted outline-none"
            aria-label="Message"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
            title="Send (Enter)"
            className="grid h-9 w-9 shrink-0 place-items-center self-end rounded-xl bg-gradient-to-br from-[color:var(--accent-from)] to-[color:var(--accent-to)] text-white shadow-[0_4px_14px_-6px_var(--primary-halo)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="13 6 19 12 13 18" />
            </svg>
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-theme-muted">
          <span>{hasUploading ? 'Uploading…' : ACCEPT_HINT}</span>
          <span className="hidden sm:inline">Enter to send · Shift+Enter for newline · drop files here</span>
        </div>
      </div>
    </div>
  );
}

function AttachmentChip({
  att,
  onRemove
}: {
  att: PendingAttachment;
  onRemove: () => void;
}) {
  const isImg = att.previewUrl !== undefined;
  return (
    <div
      className={
        'glass flex items-center gap-2 rounded-xl py-1 pl-1 pr-2 text-xs ' +
        (att.status === 'error' ? 'border border-red-400/40 text-red-100' : 'text-theme-strong')
      }
      title={att.errorMessage ?? att.filename}
    >
      <div className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-lg bg-white/10">
        {isImg ? (
          <img src={att.previewUrl} alt="" className="h-full w-full object-cover" />
        ) : att.status === 'uploading' ? (
          <span className="block h-3 w-3 animate-spin rounded-full border border-white/40 border-t-transparent" />
        ) : att.status === 'error' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        )}
      </div>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="max-w-[160px] truncate font-medium">{att.filename}</span>
        <span className="text-[10px] text-theme-muted">
          {att.status === 'uploading'
            ? `Uploading… ${att.progress}%`
            : att.status === 'error'
              ? att.errorMessage ?? 'Failed'
              : `${(att.size / 1024).toFixed(0)} KB`}
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${att.filename}`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-theme-muted transition hover:bg-white/10 hover:text-theme-strong"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
