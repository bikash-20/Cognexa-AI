export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="border-b border-rose-300/30 bg-rose-700/30 px-4 py-2 text-sm text-rose-50">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
        <span>{message}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
