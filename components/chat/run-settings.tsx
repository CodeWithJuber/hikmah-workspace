'use client';
/** What the owner can change about how a run behaves.
 *
 * Not a port of `components/playground/run-settings.tsx`. Most of that panel
 * describes the browser run loop — continuous versus stepwise execution,
 * auto-continue, reasoning effort — and none of it has a server equivalent, so
 * carrying it across would be controls that quietly do nothing. These three
 * each land somewhere real: `maxSteps` and `contextCharacters` are read by
 * `buildRunAgent`, and `showActivity` decides what the transcript renders.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MAX_INSTRUCTIONS, type ChatSettings } from '@/lib/chat/settings';
import { GATED_TOOLS, withGrant, withoutGrant } from '@/lib/chat/approvals';
import { ConnectionSettings } from './connection-settings';

/** The gated tools, in the words the approval card uses. */
const PERMISSION_LABELS: Record<(typeof GATED_TOOLS)[number], string> = {
  bash: 'Commands on the workspace machine',
  sandbox_run: 'Programs in the sandbox',
  ssh_exec: 'Commands on saved machines',
  typeform_read_responses: 'Read Typeform responses',
};

const STEP_CHOICES = [2, 4, 8, 12, 20, 32];
const STYLES = [
  { value: 'concise' as const, label: 'Concise' },
  { value: 'balanced' as const, label: 'Balanced' },
  { value: 'detailed' as const, label: 'Detailed' },
];
const CONTEXT_CHOICES = [
  { value: 16_000, label: 'Short' },
  { value: 60_000, label: 'Medium' },
  { value: 120_000, label: 'Long' },
  { value: 240_000, label: 'Very long' },
];

export function RunSettings({
  settings,
  onChange,
  active = true,
}: {
  settings: ChatSettings;
  /** Applies from the next turn. An answer already written was written under
   * the settings that were in force at the time. */
  onChange: (patch: Partial<ChatSettings>) => Promise<void> | void;
  active?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState('');
  const [instructions, setInstructions] = useState(settings.instructions);
  const [seenInstructions, setSeenInstructions] = useState(settings.instructions);
  if (seenInstructions !== settings.instructions) {
    setSeenInstructions(settings.instructions);
    if (instructions === seenInstructions) setInstructions(settings.instructions);
  }

  // The note is a transient acknowledgement, so it clears itself rather than
  // sitting there implying the last save is still recent.
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(''), 2500);
    return () => clearTimeout(timer);
  }, [note]);

  const apply = useCallback(
    async (patch: Partial<ChatSettings>) => {
      setSaving(true);
      setFailure('');
      setNote('');
      try {
        await onChange(patch);
        setNote('Saved. Applies from your next message.');
        return true;
      } catch {
        setFailure('Settings were not saved. Check your connection and try again.');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [onChange],
  );

  return (
    <div className="chat-settings-panel">
      {/* First, because nothing else in this panel matters until a run can
          reach a provider at all. */}
      <section>
        <h3>Connection</h3>
        <p>Choose the provider and model for your chats.</p>
        <ConnectionSettings
          connection={settings.connection}
          onChange={(connection) => onChange({ connection })}
          active={active}
        />
      </section>
      <section>
        <h3>Response length</h3>
        <ButtonGroup aria-label="Response style">
          {STYLES.map((choice) => (
            <Button
              key={choice.value}
              type="button"
              variant={settings.responseStyle === choice.value ? 'secondary' : 'outline'}
              aria-pressed={settings.responseStyle === choice.value}
              disabled={saving}
              onClick={() => void apply({ responseStyle: choice.value })}
            >
              {choice.label}
            </Button>
          ))}
        </ButtonGroup>
      </section>

      <Collapsible className="chat-settings-disclosure">
        <CollapsibleTrigger className="chat-settings-disclosure-trigger">
          Personalization <span>Instructions & display</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="chat-settings-disclosure-body">
          <div className="flex items-start justify-between gap-4 py-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">Show activity</p>
              <p className="text-sm text-muted-foreground">
                Tool activity and usage details beneath each answer.
              </p>
            </div>
            <Switch
              checked={settings.showActivity}
              disabled={saving}
              aria-label="Show activity"
              onCheckedChange={(checked) => void apply({ showActivity: checked })}
            />
          </div>
          <div className="flex items-start justify-between gap-4 py-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">Explain decisions</p>
              <p className="text-sm text-muted-foreground">
                Include the evidence and trade-offs behind recommendations.
              </p>
            </div>
            <Switch
              checked={settings.explainDecisions}
              disabled={saving}
              aria-label="Explain decisions"
              onCheckedChange={(checked) => void apply({ explainDecisions: checked })}
            />
          </div>
          <div className="space-y-2 pt-2">
            <label htmlFor="chat-instructions" className="text-sm font-medium">
              Your instructions
            </label>
            <Textarea
              id="chat-instructions"
              rows={4}
              maxLength={MAX_INSTRUCTIONS}
              value={instructions}
              disabled={saving}
              placeholder="For example: reply in Hindi, keep explanations brief, cite sources."
              onChange={(event) => setInstructions(event.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Included in future chats. Save to apply your changes.
            </p>
            {instructions !== settings.instructions && (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => void apply({ instructions })}
              >
                Save instructions
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible className="chat-settings-disclosure">
        <CollapsibleTrigger className="chat-settings-disclosure-trigger">
          Memory <span>Previous chats & preferences</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="chat-settings-disclosure-body">
          <div className="flex items-start justify-between gap-4 py-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">Recall earlier conversations</p>
              <p className="text-sm text-muted-foreground">
                Use relevant excerpts from your other chats. Usage appears below the answer.
              </p>
            </div>
            <Switch
              checked={settings.memory.recallConversations}
              disabled={saving}
              aria-label="Recall earlier conversations"
              onCheckedChange={(checked) =>
                void apply({
                  memory: { ...settings.memory, recallConversations: checked },
                })
              }
            />
          </div>
          <div className="flex items-start justify-between gap-4 py-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">Save quoted preferences automatically</p>
              <p className="text-sm text-muted-foreground">
                Exact preference quotes from your messages are saved without review. Facts and
                inferred preferences still need your approval in Memory.
              </p>
            </div>
            <Switch
              checked={settings.memory.autoSaveQuotes}
              disabled={saving}
              aria-label="Save quoted preferences automatically"
              onCheckedChange={(checked) =>
                void apply({ memory: { ...settings.memory, autoSaveQuotes: checked } })
              }
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible className="chat-settings-disclosure">
        <CollapsibleTrigger className="chat-settings-disclosure-trigger">
          Tool permissions <span>Approval rules</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="chat-settings-disclosure-body">
          <p>Choose what can run without asking. Other tools still request approval in chat.</p>
          <ul className="space-y-3" aria-label="Tools that reach a machine">
            {GATED_TOOLS.map((tool) => {
              const auto = settings.approvals.auto.includes(tool);
              return (
                <li key={tool} className="flex items-center justify-between gap-4">
                  <span className="text-sm">{PERMISSION_LABELS[tool]}</span>
                  <ButtonGroup aria-label={PERMISSION_LABELS[tool]}>
                    <Button
                      type="button"
                      size="sm"
                      variant={!auto ? 'secondary' : 'outline'}
                      aria-pressed={!auto}
                      disabled={saving}
                      onClick={() =>
                        void apply({
                          approvals: withoutGrant(settings.approvals, {
                            kind: 'auto',
                            value: tool,
                          }),
                        })
                      }
                    >
                      Ask
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={auto ? 'secondary' : 'outline'}
                      aria-pressed={auto}
                      disabled={saving}
                      onClick={() =>
                        void apply({
                          approvals: withGrant(settings.approvals, { scope: 'always', tool }),
                        })
                      }
                    >
                      Auto
                    </Button>
                  </ButtonGroup>
                </li>
              );
            })}
            {settings.approvals.auto
              .filter((tool) => !(GATED_TOOLS as readonly string[]).includes(tool))
              .map((tool) => (
                <li key={tool} className="flex items-center justify-between gap-4">
                  <code className="text-sm">{tool}</code>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() =>
                      void apply({
                        approvals: withoutGrant(settings.approvals, { kind: 'auto', value: tool }),
                      })
                    }
                  >
                    Ask again
                  </Button>
                </li>
              ))}
          </ul>
          {settings.approvals.commands.length > 0 && (
            <>
              <p>Commands allowed without asking, with any arguments after them:</p>
              <ul className="space-y-2" aria-label="Commands allowed without asking">
                {settings.approvals.commands.map((command) => (
                  <li key={command} className="flex items-center justify-between gap-4">
                    <code dir="ltr" className="text-sm">
                      {command}
                    </code>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Ask again for ${command}`}
                      disabled={saving}
                      onClick={() =>
                        void apply({
                          approvals: withoutGrant(settings.approvals, {
                            kind: 'command',
                            value: command,
                          }),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {Object.keys(settings.approvals.conversations).length > 0 && (
            <div className="flex items-center justify-between gap-4 pt-2">
              <p className="text-sm text-muted-foreground">
                {Object.keys(settings.approvals.conversations).length === 1
                  ? 'One conversation has'
                  : `${Object.keys(settings.approvals.conversations).length} conversations have`}{' '}
                their own grants.
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() =>
                  void apply({ approvals: { ...settings.approvals, conversations: {} } })
                }
              >
                Clear them
              </Button>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible className="chat-settings-disclosure">
        <CollapsibleTrigger className="chat-settings-disclosure-trigger">
          Advanced <span>Run limits & context</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="chat-settings-disclosure-body">
          <section>
            <h4>Tool rounds</h4>
            <p>Maximum tool rounds per answer. Higher limits can take longer and cost more.</p>
            <ButtonGroup aria-label="Tool rounds">
              {STEP_CHOICES.map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={settings.maxSteps === value ? 'secondary' : 'outline'}
                  aria-pressed={settings.maxSteps === value}
                  disabled={saving}
                  onClick={() => void apply({ maxSteps: value })}
                >
                  {value}
                </Button>
              ))}
            </ButtonGroup>
          </section>
          <section>
            <h4>Conversation context</h4>
            <p>How much of the current chat accompanies each message. Longer context costs more.</p>
            <ButtonGroup aria-label="Earlier conversation">
              {CONTEXT_CHOICES.map((choice) => (
                <Button
                  key={choice.value}
                  type="button"
                  size="sm"
                  variant={settings.contextCharacters === choice.value ? 'secondary' : 'outline'}
                  aria-pressed={settings.contextCharacters === choice.value}
                  disabled={saving}
                  onClick={() => void apply({ contextCharacters: choice.value })}
                >
                  {choice.label}
                </Button>
              ))}
            </ButtonGroup>
          </section>
          <div className="flex items-start justify-between gap-4 py-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">Local context notes</p>
              <p className="text-sm text-muted-foreground">
                Add locally generated syntax hints from your recent messages. They may be wrong and
                add a few tokens per turn.
              </p>
            </div>
            <Switch
              checked={settings.contextModel}
              disabled={saving}
              aria-label="Local context notes"
              onCheckedChange={(checked) => void apply({ contextModel: checked })}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {failure && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden="true" />
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {note && (
        <Alert>
          <Check className="size-4" aria-hidden="true" />
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
