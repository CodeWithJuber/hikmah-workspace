'use client';
/** Which tools the run may use, as a menu on the composer.
 *
 * The switches themselves are `components/chat/tool-switches.tsx`, shared with
 * the workspace's Tools screen so the two cannot name different tools or write
 * different stores. This file is the popover around them.
 *
 * Not a port of the old `components/playground/tools-menu.tsx`, which toggled a
 * different set of names — half with no server equivalent — and whose connector
 * half drove the browser MCP client, a decision the server now makes for itself
 * in `lib/mcp/run-context.ts`.
 */
import { Wrench } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { ToolSwitches, useToolAvailability, activeToolCount } from './tool-switches';

export function ToolsMenu({
  disabled,
  onChange,
  busy,
}: {
  /** Tool names the owner has switched off. */
  disabled: string[];
  onChange: (disabledTools: string[]) => Promise<void> | void;
  busy?: boolean;
}) {
  const tools = useToolAvailability();
  if (!tools.length) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="chat-tools-trigger" disabled={busy}>
          <Wrench size={16} />
          Tools
          <span>{activeToolCount(tools, disabled)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="chat-tools-menu" align="start">
        <p className="chat-tools-note">
          Applies from your next message. Connectors are managed under Connections in the workspace.
        </p>
        <ToolSwitches tools={tools} disabled={disabled} onChange={onChange} busy={busy} />
      </PopoverContent>
    </Popover>
  );
}
