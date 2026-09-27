'use client';

import { useRouter } from 'next/navigation';
import {
  BookOpen,
  Bot,
  Database,
  FileText,
  MessageSquare,
  Plus,
  Settings,
  TerminalSquare,
} from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { ConversationSummary } from './conversation-list';

export function WorkspaceCommands({
  open,
  onOpenChange,
  conversations,
  onNew,
  onPanel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: ConversationSummary[];
  onNew: () => void;
  onPanel: (panel: 'files' | 'agents' | 'memory' | 'settings') => void;
}) {
  const router = useRouter();
  const select = (action: () => void) => {
    onOpenChange(false);
    action();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace-command-dialog" showCloseButton={false}>
        <DialogTitle className="sr-only">Search workspace</DialogTitle>
        <DialogDescription className="sr-only">
          Find a conversation or open a workspace tool. Use arrow keys to move and Enter to open.
        </DialogDescription>
        <Command>
          <CommandInput
            placeholder="Find a conversation or action…"
            aria-label="Search workspace"
          />
          <CommandList>
            <CommandEmpty>No conversations or actions found.</CommandEmpty>
            <CommandGroup heading="Actions">
              <CommandItem onSelect={() => select(onNew)}>
                <Plus />
                New chat
              </CommandItem>
              <CommandItem onSelect={() => select(() => router.push('/learning'))}>
                <BookOpen />
                Learning
              </CommandItem>
              <CommandItem onSelect={() => select(() => router.push('/terminal'))}>
                <TerminalSquare />
                Terminal & SSH
              </CommandItem>
              <CommandItem onSelect={() => select(() => onPanel('agents'))}>
                <Bot />
                Agents
              </CommandItem>
              <CommandItem onSelect={() => select(() => onPanel('files'))}>
                <FileText />
                Files
              </CommandItem>
              <CommandItem onSelect={() => select(() => onPanel('memory'))}>
                <Database />
                Saved memory
              </CommandItem>
              <CommandItem onSelect={() => select(() => onPanel('settings'))}>
                <Settings />
                Settings and model connections
              </CommandItem>
            </CommandGroup>
            {conversations.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Conversations">
                  {conversations.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={`${entry.title} ${entry.id}`}
                      onSelect={() =>
                        select(() => router.push(`/chat/${encodeURIComponent(entry.id)}`))
                      }
                    >
                      <MessageSquare />
                      <span>{entry.title || 'Untitled conversation'}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
        <p className="workspace-command-hint">↑ ↓ to navigate · Enter to open · Esc to close</p>
      </DialogContent>
    </Dialog>
  );
}
