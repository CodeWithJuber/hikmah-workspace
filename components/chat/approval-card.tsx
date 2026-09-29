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
import { ChevronDown, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { partToolName, toolProvenance } from '@/lib/chat/working';
import { isGrantableCommand, type Grant } from '@/lib/chat/approvals';
import type { RespondToApproval } from './message-parts';

/** Saves a grant before the run is answered, so the resumed run reads it. */
export type GrantHandler = (grant: Grant) => Promise<void> | void;

/** What "always allow" would cover, in words. */
const GRANT_LABELS: Record<string, string> = {
  bash: 'commands on the workspace machine',
  sandbox_run: 'programs in the sandbox',
  ssh_exec: 'commands on saved machines',
};

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

/** The plain-words reason the tool gave, the literal command, and the rest of
 * the payload — read separately so each is shown in the form it belongs in.
 *
 * Every parameter is shown, not only the ones with a dedicated line: a card
 * that says "run this" while hiding what "this" takes is a prompt to approve
 * something unstated. The description and the command are read out above; the
 * parameters carry everything else. A tool that gave neither is shown as its
 * input: an empty card would be a prompt to approve something unstated. */
function requestDetails(part: ApprovalPart): { why: string; command: string; params: string } {
  const rawInput = part.input;
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const why = typeof input.description === 'string' ? input.description.trim() : '';
  const command =
    typeof input.command === 'string'
      ? input.command.trim()
      : typeof input.code === 'string'
        ? input.code.trim()
        : '';
  const rest = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        key !== 'description' &&
        key !== 'command' &&
        key !== 'code' &&
        value !== undefined &&
        value !== null,
    ),
  );
  // The whole input when the tool gave nothing else to read out; the
  // parameters beside the description when it did.
  const params =
    Object.keys(rest).length > 0
      ? JSON.stringify(rest, null, 2)
      : why || command
        ? ''
        : JSON.stringify(rawInput ?? {}, null, 2);
  return { why, command, params };
}

/** The run's recorded budget, when the run published one. The action's cost
 * is what the system actually knows: a metered tool call against that budget.
 * With no budget recorded the card says nothing about cost rather than
 * inventing a price. */
export type ApprovalBudget = { maxCalls: number };

/** The remembered-yes options this card may offer, in menu order.
 *
 * Pure content logic, kept out of the JSX so it is unit-testable: a closed
 * Radix menu renders nothing to static markup, so the options a card offers
 * cannot be asserted from the HTML. Each option is the grant the menu item
 * would save.
 *
 * An MCP tool offers none: without the approved definition's fingerprint
 * there is nothing to bind the consent to, so `withGrant` parks the id as
 * unbound — honored never, shown nowhere. A command the settings cannot
 * store (a separator in it, past the length bound) is not offered either: a
 * grant offered but never stored is a dead button wearing a promise. */
export function grantOptions(part: ApprovalPart, conversationId?: string): Grant[] {
  const toolId = partToolName(part).replace(/^tool-/, '');
  const { server } = toolProvenance(toolId);
  if (server) return [];
  const { command } = requestDetails(part);
  const options: Grant[] = [];
  if (toolId === 'bash' && command && isGrantableCommand(command))
    options.push({ scope: 'command', tool: 'bash', command });
  if (conversationId) options.push({ scope: 'conversation', tool: toolId, conversationId });
  options.push({ scope: 'always', tool: toolId });
  return options;
}

export function ApprovalCard({
  part,
  conversationId,
  onApproval,
  onGrant,
  budget,
  callsUsed = 0,
}: {
  part: ApprovalPart;
  conversationId?: string;
  onApproval?: RespondToApproval;
  /** Remembers a yes with a scope. Absent, the card offers a yes for now only. */
  onGrant?: GrantHandler;
  /** The run's recorded budget, when the run published one. */
  budget?: ApprovalBudget | null;
  /** Tool calls so far in this run, on the plan card's own counting. */
  callsUsed?: number;
}) {
  // Answered once. The response flips the part to `approval-responded` and this
  // card unmounts, but a second tap in the gap before that render would send a
  // second answer to a question that no longer has one.
  const [sent, setSent] = useState(false);
  const { title, where } = describeRequest(part);
  const { why, command, params } = requestDetails(part);
  const id = part.approval?.id;
  // An approval that can still be answered: one the run is actually waiting
  // on, with a handler to take the answer. Anything else — a question whose
  // run is gone, a transcript rendered without the handler — gets no live
  // buttons, and says so instead of leaving dead ones.
  const answerable = !!id && !!onApproval && !sent;
  const answer = (approved: boolean) => {
    if (!answerable) return;
    setSent(true);
    onApproval?.({ id: id as string, approved });
  };
  // The grant is saved first and the run answered after, in that order: the
  // resumed run reads the settings when it is driven, and a grant that landed
  // a moment later would have applied to the call after this one.
  const grant = async (scope: Grant) => {
    if (!answerable || !onGrant) return;
    setSent(true);
    try {
      await onGrant(scope);
    } catch {
      /* the yes still stands for this call */
    }
    onApproval?.({ id: id as string, approved: true });
  };
  const toolId = partToolName(part).replace(/^tool-/, '');
  const { server, tool } = toolProvenance(toolId);
  // An MCP tool id can never be remembered from here: without the approved
  // definition's fingerprint there is nothing to bind the consent to, so
  // `withGrant` parks it as unbound — visible nowhere, honored never. The
  // menu would be a promise the settings cannot keep, so it is not offered.
  // See grantOptions above for the testable form of this rule.
  const isMcp = !!server;
  const label = GRANT_LABELS[toolId] ?? tool.replace(/_/g, ' ');
  const heading = 'approval-' + (part.toolCallId ?? id ?? 'card');
  const showBudget = !!budget && typeof budget.maxCalls === 'number';
  // The menu items, from the same options the tests assert on.
  const options = onGrant && !isMcp ? grantOptions(part, conversationId) : [];
  const commandOption = options.find((option) => option.scope === 'command');
  const conversationOption = options.find((option) => option.scope === 'conversation');
  const alwaysOption = options.find((option) => option.scope === 'always');
  return (
    <section className="chat-approval" role="group" aria-labelledby={heading}>
      <header className="chat-approval-head">
        <ShieldQuestion size={20} aria-hidden="true" />
        <span id={heading}>
          {title}
          {where && <span className="chat-approval-source"> {where}</span>}
        </span>
      </header>
      {why && <p className="chat-approval-why">{why}</p>}
      {command && (
        <pre className="chat-approval-command" dir="ltr" aria-label="Command to run">
          {command}
        </pre>
      )}
      {params && (
        <pre className="chat-approval-params" dir="ltr" aria-label="Tool parameters">
          {params}
        </pre>
      )}
      {/* The cost type of the action, in the system's own terms: one metered
          tool call against the run's recorded budget. No budget recorded, no
          line — a price would be invented. */}
      {showBudget && (
        <p className="chat-approval-cost">
          One tool call against this run&rsquo;s budget · {callsUsed} of {budget.maxCalls} used
        </p>
      )}
      {id && !onApproval && (
        <p className="chat-approval-note">
          This approval can&rsquo;t be answered from here — the run it belongs to isn&rsquo;t
          attached.
        </p>
      )}
      {/* An MCP tool id can never be remembered from here (see isMcp above),
          so the card says what the only option is instead of offering the
          remembered yes the settings could not keep. */}
      {onGrant && isMcp && (
        <p className="chat-approval-note">
          Only this call can be approved here — remembering this tool needs its approved definition
          bound first, which this chat can&rsquo;t do.
        </p>
      )}
      <div className="chat-approval-actions">
        <Button
          type="button"
          variant="outline"
          disabled={!answerable}
          onClick={() => answer(false)}
        >
          Don&rsquo;t allow
        </Button>
        {/* A yes that is remembered, with its scope chosen here rather than
            in a settings screen nobody has opened yet: this command, this tool
            in this conversation, or this tool anywhere. Not for MCP tools —
            see isMcp above. */}
        {onGrant && !isMcp && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" disabled={!answerable}>
                <ShieldCheck size={16} aria-hidden="true" />
                Always allow
                <ChevronDown size={16} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="chat-approval-menu">
              <DropdownMenuLabel>Don&rsquo;t ask again for</DropdownMenuLabel>
              {/* Only a command the settings can actually store: anything
                  else would be a choice that silently keeps nothing. */}
              {commandOption?.scope === 'command' && (
                <DropdownMenuItem
                  onSelect={() =>
                    void grant({ scope: 'command', tool: 'bash', command: commandOption.command })
                  }
                >
                  <span>
                    This command, with any arguments
                    <code dir="ltr">{commandOption.command}</code>
                  </span>
                </DropdownMenuItem>
              )}
              {conversationOption && (
                <DropdownMenuItem
                  onSelect={() =>
                    void grant({
                      scope: 'conversation',
                      tool: conversationOption.tool,
                      conversationId: conversationOption.conversationId,
                    })
                  }
                >
                  <span>{label[0].toUpperCase() + label.slice(1)} in this conversation</span>
                </DropdownMenuItem>
              )}
              {alwaysOption && (
                <DropdownMenuItem
                  onSelect={() => void grant({ scope: 'always', tool: alwaysOption.tool })}
                >
                  <span>{label[0].toUpperCase() + label.slice(1)}, anywhere</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button type="button" disabled={!answerable} onClick={() => answer(true)}>
          {onGrant ? 'Allow once' : 'Allow'}
        </Button>
      </div>
    </section>
  );
}
