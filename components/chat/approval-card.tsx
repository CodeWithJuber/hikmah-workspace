'use client';
/** A run has stopped and is asking. This is the card it asks with.
 *
 * It used to be the AI Elements `Confirmation` block inside the tool's
 * Collapsible, opened with `defaultOpen` when the part was waiting. That works
 * for a part that *mounts* waiting — a reload — and for no other case: the SDK
 * creates the part on `tool-input-start` and later mutates the same part to
 * `approval-requested` (ai/dist/index.js, the `tool-approval-request` case),
 * and Radix reads `defaultOpen` once, at mount. So on a live stream the card
 * mounted closed and stayed closed, and Allow was behind a tap nobody knew to
 * make. Reported as: the button only shows after expanding.
 *
 * A control the run is blocked on is not inside a disclosure at all. This is a
 * block in the transcript: what the tool wants to do, where, the exact command,
 * and two buttons.
 */
import { useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { partToolName, toolProvenance } from '@/lib/chat/working';
import type { RespondToApproval } from './message-parts';

export type ApprovalPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  approval?: { id: string };
};

/** What the tool would do, as the header of a question rather than the
 * past-tense label the working uses once it has been done. */
const WANTS: Record<string, string> = {
  bash: 'Run a command',
  sandbox_run: 'Run a program',
  ssh_exec: 'Run a command on a saved machine',
};

/** The header line and, where it is not obvious, where it would happen. */
function describeRequest(part: ApprovalPart): { title: string; where: string } {
  const { server, tool } = toolProvenance(partToolName(part));
  const input = (part.input ?? {}) as Record<string, unknown>;
  if (server)
    return { title: 'Use ' + tool.replace(/_/g, ' '), where: 'through the ' + server + ' server' };
  if (tool === 'ssh_exec' && typeof input.host_id === 'string' && input.host_id)
    return { title: WANTS[tool], where: 'on ' + input.host_id };
  if (tool === 'bash' || tool === 'sandbox_run')
    return { title: WANTS[tool], where: 'on the workspace machine' };
  return { title: WANTS[tool] ?? tool.replace(/_/g, ' '), where: '' };
}

/** The plain-words reason the tool gave, and the literal command, read
 * separately so each can be shown in the form it belongs in. A tool that gave
 * neither is shown as its input: an empty card would be a prompt to approve
 * something unstated. */
function requestDetails(part: ApprovalPart): { why: string; command: string; raw: string } {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const why = typeof input.description === 'string' ? input.description.trim() : '';
  const command =
    typeof input.command === 'string'
      ? input.command.trim()
      : typeof input.code === 'string'
        ? input.code.trim()
        : '';
  const raw = why || command ? '' : JSON.stringify(part.input ?? {}, null, 2);
  return { why, command, raw };
}

export function ApprovalCard({
  part,
  onApproval,
}: {
  part: ApprovalPart;
  onApproval?: RespondToApproval;
}) {
  // Answered once. The response flips the part to `approval-responded` and this
  // card unmounts, but a second tap in the gap before that render would send a
  // second answer to a question that no longer has one.
  const [sent, setSent] = useState(false);
  const { title, where } = describeRequest(part);
  const { why, command, raw } = requestDetails(part);
  const id = part.approval?.id;
  const answer = (approved: boolean) => {
    if (!id || sent) return;
    setSent(true);
    onApproval?.({ id, approved });
  };
  const heading = 'approval-' + (part.toolCallId ?? id ?? 'card');
  return (
    <section className="chat-approval" role="group" aria-labelledby={heading}>
      <header className="chat-approval-head">
        <ShieldQuestion size={18} aria-hidden="true" />
        <span id={heading}>
          {title}
          {where && <span className="chat-approval-source"> {where}</span>}
        </span>
      </header>
      {why && <p className="chat-approval-why">{why}</p>}
      {(command || raw) && (
        <pre className="chat-approval-command" dir="ltr">
          {command || raw}
        </pre>
      )}
      <div className="chat-approval-actions">
        <Button
          type="button"
          variant="outline"
          disabled={!id || sent}
          onClick={() => answer(false)}
        >
          Don&rsquo;t allow
        </Button>
        <Button type="button" disabled={!id || sent} onClick={() => answer(true)}>
          Allow
        </Button>
      </div>
    </section>
  );
}
