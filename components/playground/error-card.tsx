'use client';
import { AlertCircle, Copy, RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
export type DisplayError = {
  message: string;
  code?: string;
  action?: string;
  model?: string;
  provider?: string;
  status?: number;
  retryAfterSeconds?: number;
};
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  } catch {
    toast.error('Clipboard access is unavailable. Select and copy the text.');
  }
}
export function ErrorCard({
  error,
  onSettings,
  onRetry,
  disabled = false,
}: {
  error: DisplayError;
  onSettings?: () => void;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="error-card" role="alert">
      <AlertCircle size={20} />
      <div>
        <strong>{error.message}</strong>
        {error.action && <p>{error.action}</p>}
        {(error.model || error.provider) && (
          <p className="error-context">
            {error.model}
            {error.provider ? ' · ' + error.provider : ''}
            {error.status ? ' · HTTP ' + error.status : ''}
          </p>
        )}
        {error.retryAfterSeconds && <p>Provider retry delay: {error.retryAfterSeconds} seconds.</p>}
        {error.code && <code className="error-code">{error.code}</code>}
        <div className="error-actions">
          {onSettings && (
            <Button variant="ghost" onClick={onSettings}>
              <Settings2 size={16} />
              Connection settings
            </Button>
          )}
          {onRetry && (
            <Button variant="ghost" disabled={disabled} onClick={onRetry}>
              <RefreshCw size={16} />
              Retry
            </Button>
          )}
          <Button variant="ghost" onClick={() => void copyText(JSON.stringify(error, null, 2))}>
            <Copy size={16} />
            Copy diagnostic
          </Button>
        </div>
      </div>
    </div>
  );
}
