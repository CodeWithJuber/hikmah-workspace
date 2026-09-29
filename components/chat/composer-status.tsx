'use client';
/** Small composer-status surfaces: the polite live region and the attachment
 * error alert. Kept out of chat-view.tsx so the UI boundary stays renderable
 * and unit-testable without the whole chat (useChat, transport, transcript).
 */
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { usePromptInputAttachments } from '@/components/ai-elements/prompt-input';
import { busyAnnouncement, type SettledOutcome } from '@/lib/chat/announce';

/** The transcript's polite live region: "Working on your request." while a
 * run is busy, then exactly one settled announcement, cleared after a second
 * so it doesn't linger for assistive tech.
 *
 * Per-chunk updates would break VoiceOver, so only the transition is
 * announced — never the answer text itself (the 2026 kubaik finding). A stop
 * is announced as stopped and a failure as failed, never as ready: the
 * region must say what happened, not just that something happened. */
export function RunStatusLiveRegion({
  busy,
  outcome,
}: {
  busy: boolean;
  outcome: false | SettledOutcome;
}) {
  return (
    <div aria-live="polite" className="sr-only">
      {busyAnnouncement(busy, outcome)}
    </div>
  );
}

/** Why an attachment never made it into the composer. The three picker
 * validation failures are retryable; 'image' is an /image turn that failed
 * server-side, which the file picker cannot fix. */
export type AttachmentIssue = {
  code: 'max_files' | 'max_file_size' | 'accept' | 'image';
  message: string;
};

const RETRYABLE: AttachmentIssue['code'][] = ['max_files', 'max_file_size', 'accept'];

/** A failed attachment can be retried: the picker reopens so the owner can
 * pick different files, and the draft is untouched — the error path never
 * writes it. A non-retryable failure only dismisses. */
export function AttachmentErrorAlert({
  issue,
  onDismiss,
}: {
  issue: AttachmentIssue;
  onDismiss: () => void;
}) {
  const attachments = usePromptInputAttachments();
  const retryable = RETRYABLE.includes(issue.code);
  return (
    <Alert variant="destructive" className="mt-3">
      <AlertDescription className="flex items-center justify-between gap-2">
        <span>{issue.message}</span>
        {/* Wraps on a phone: the message keeps its line, the buttons stack
          after it rather than squeezing it out. */}
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {retryable && (
            <Button type="button" variant="outline" size="sm" onClick={attachments.openFileDialog}>
              Try again
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            aria-label="Dismiss attachment error"
          >
            Dismiss
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
