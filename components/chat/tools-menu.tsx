'use client';
/** One composer menu for optional help; attachment picking is a direct action. */
import { useId, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Columns2, Globe, Microscope, Telescope, Wrench } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ToolSwitches, useToolAvailability, activeToolCount } from './tool-switches';
import { researchCapabilities } from '@/lib/client/research-brief';

export function ToolsMenu({
  disabled,
  onChange,
  busy,
  webSearch,
  onWebSearch,
  deepResearch,
  onDeepResearch,
  compare,
  onCompare,
  onBackgroundTask,
  onResearchBrief,
}: {
  disabled: string[];
  onChange?: (disabledTools: string[]) => Promise<void> | void;
  busy?: boolean;
  webSearch: boolean;
  onWebSearch: (enabled: boolean) => void;
  deepResearch: boolean;
  onDeepResearch: (enabled: boolean) => void;
  compare: boolean;
  onCompare: (enabled: boolean) => void;
  onBackgroundTask?: () => void;
  onResearchBrief?: (capabilities: ReturnType<typeof researchCapabilities>) => void;
}) {
  const tools = useToolAvailability();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const openingDialog = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const options = [
    {
      label: 'Search the web',
      description: 'Look for current information online.',
      Icon: Globe,
      checked: webSearch,
      change: onWebSearch,
    },
    {
      label: 'Research in parallel',
      description: 'Check multiple sources with several model calls.',
      Icon: Telescope,
      checked: deepResearch,
      change: onDeepResearch,
    },
    {
      label: 'Compare answers',
      description: 'Make one extra model call for an answer without tools.',
      Icon: Columns2,
      checked: compare,
      change: onCompare,
    },
  ];

  const saveTools = async (next: string[]) => {
    if (!onChange || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await onChange(next);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Tool permissions could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="chat-composer-options-trigger"
          disabled={busy}
          title="Tools and extra help"
        >
          <Wrench size={16} aria-hidden="true" />
          <span>Tools</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="chat-composer-options"
        align="start"
        side="top"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCloseAutoFocus={(event) => {
          // A newly opened dialog owns focus; returning it to Tools would
          // interrupt the keyboard handoff from the menu.
          if (openingDialog.current) {
            event.preventDefault();
            openingDialog.current = false;
          }
        }}
      >
        <h2 id={titleId}>Extra help</h2>
        <p id={descriptionId} className="chat-options-description">
          For this conversation, until turned off. Research and comparison use extra model calls.
        </p>
        <div className="chat-composer-options-list n-stagger">
          {options.map(({ label, description, Icon, checked, change }, index) => (
            <label
              key={label}
              className="chat-composer-action chat-composer-option n-action-row n-press"
              style={{ '--i': index } as CSSProperties}
            >
              <Icon size={20} aria-hidden="true" />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              <input
                type="checkbox"
                checked={checked}
                disabled={busy}
                onChange={(event) => change(event.target.checked)}
              />
            </label>
          ))}
        </div>
        {onResearchBrief && (
          <button
            type="button"
            className="chat-composer-action chat-background-task-action n-action-row n-press"
            disabled={busy}
            onClick={() => {
              openingDialog.current = true;
              setOpen(false);
              onResearchBrief(researchCapabilities(tools, disabled));
            }}
          >
            <Microscope size={20} aria-hidden="true" />
            <span>
              <strong>Research brief</strong>
              <small>Review evidence, challenge a hypothesis, or plan a test.</small>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
        )}
        {onBackgroundTask && (
          <button
            type="button"
            className="chat-composer-action chat-background-task-action n-action-row n-press"
            disabled={busy}
            onClick={() => {
              openingDialog.current = true;
              setOpen(false);
              onBackgroundTask();
            }}
          >
            <Telescope size={20} aria-hidden="true" />
            <span>
              <strong>Background research task</strong>
              <small>Work on another topic while you keep chatting.</small>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
        )}
        {onChange && tools.length > 0 && (
          <Collapsible className="chat-composer-permissions">
            <CollapsibleTrigger className="chat-composer-permissions-trigger">
              Tool permissions · {activeToolCount(tools, disabled)} enabled
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p>Hikmah chooses from these tools when needed. Changes apply to future messages.</p>
              <ToolSwitches
                tools={tools}
                disabled={disabled}
                onChange={saveTools}
                busy={busy || saving}
              />
              {saveError && <p role="alert">{saveError}</p>}
            </CollapsibleContent>
          </Collapsible>
        )}
      </PopoverContent>
    </Popover>
  );
}
