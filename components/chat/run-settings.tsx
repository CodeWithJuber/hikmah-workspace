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
import { Button } from '@/components/ui/button';
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
        <div className="chat-settings-choices" role="group" aria-label="Response style">
          {STYLES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              disabled={saving}
              aria-pressed={settings.responseStyle === choice.value}
              onClick={() => void apply({ responseStyle: choice.value })}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </section>

      <Collapsible className="chat-settings-disclosure">
        <CollapsibleTrigger className="chat-settings-disclosure-trigger">
          Personalization <span>Instructions & display</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="chat-settings-disclosure-body">
          <label className="chat-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showActivity}
              disabled={saving}
              onChange={(event) => void apply({ showActivity: event.target.checked })}
            />
            <span>
              <strong>Show activity</strong>
              <small>Tool activity and usage details beneath each answer.</small>
            </span>
          </label>
          <label className="chat-settings-toggle">
            <input
              type="checkbox"
              checked={settings.explainDecisions}
              disabled={saving}
              onChange={(event) => void apply({ explainDecisions: event.target.checked })}
            />
            <span>
              <strong>Explain decisions</strong>
              <small>Include the evidence and trade-offs behind recommendations.</small>
            </span>
          </label>
          <div className="chat-setting">
            <label htmlFor="chat-instructions">Your instructions</label>
            <textarea
              id="chat-instructions"
              className="chat-settings-instructions"
              rows={4}
              maxLength={MAX_INSTRUCTIONS}
              value={instructions}
              disabled={saving}
              placeholder="For example: reply in Hindi, keep explanations brief, cite sources."
              onChange={(event) => setInstructions(event.target.value)}
            />
            <small>Included in future chats. Save to apply your changes.</small>
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
          <label className="chat-settings-toggle">
            <input
              type="checkbox"
              checked={settings.memory.recallConversations}
              disabled={saving}
              onChange={(event) =>
                void apply({
                  memory: { ...settings.memory, recallConversations: event.target.checked },
                })
              }
            />
            <span>
              <strong>Recall earlier conversations</strong>
              <small>
                Use relevant excerpts from your other chats. Usage appears below the answer.
              </small>
            </span>
          </label>
          <label className="chat-settings-toggle">
            <input
              type="checkbox"
              checked={settings.memory.autoSaveQuotes}
              disabled={saving}
              onChange={(event) =>
                void apply({ memory: { ...settings.memory, autoSaveQuotes: event.target.checked } })
              }
            />
            <span>
              <strong>Save quoted preferences automatically</strong>
              <small>
                Exact preference quotes from your messages are saved without review. Facts and
                inferred preferences still need your approval in Memory.
              </small>
            </span>
          </label>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible className="chat-settings-disclosure">
        <CollapsibleTrigger className="chat-settings-disclosure-trigger">
          Tool permissions <span>Approval rules</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="chat-settings-disclosure-body">
          <p>Choose what can run without asking. Other tools still request approval in chat.</p>
          <ul className="chat-permissions" aria-label="Tools that reach a machine">
            {GATED_TOOLS.map((tool) => {
              const auto = settings.approvals.auto.includes(tool);
              return (
                <li key={tool}>
                  <span>{PERMISSION_LABELS[tool]}</span>
                  <div
                    className="chat-settings-choices"
                    role="group"
                    aria-label={PERMISSION_LABELS[tool]}
                  >
                    <button
                      type="button"
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
                    </button>
                    <button
                      type="button"
                      aria-pressed={auto}
                      disabled={saving}
                      onClick={() =>
                        void apply({
                          approvals: withGrant(settings.approvals, { scope: 'always', tool }),
                        })
                      }
                    >
                      Auto
                    </button>
                  </div>
                </li>
              );
            })}
            {settings.approvals.auto
              .filter((tool) => !(GATED_TOOLS as readonly string[]).includes(tool))
              .map((tool) => (
                <li key={tool}>
                  <code>{tool}</code>
                  <button
                    type="button"
                    className="chat-permissions-remove"
                    disabled={saving}
                    onClick={() =>
                      void apply({
                        approvals: withoutGrant(settings.approvals, { kind: 'auto', value: tool }),
                      })
                    }
                  >
                    Ask again
                  </button>
                </li>
              ))}
          </ul>
          {settings.approvals.commands.length > 0 && (
            <>
              <p>Commands allowed without asking, with any arguments after them:</p>
              <ul className="chat-permissions" aria-label="Commands allowed without asking">
                {settings.approvals.commands.map((command) => (
                  <li key={command}>
                    <code dir="ltr">{command}</code>
                    <button
                      type="button"
                      className="chat-permissions-remove"
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
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {Object.keys(settings.approvals.conversations).length > 0 && (
            <p>
              {Object.keys(settings.approvals.conversations).length === 1
                ? 'One conversation has'
                : `${Object.keys(settings.approvals.conversations).length} conversations have`}{' '}
              their own grants.{' '}
              <button
                type="button"
                className="chat-permissions-remove"
                disabled={saving}
                onClick={() =>
                  void apply({ approvals: { ...settings.approvals, conversations: {} } })
                }
              >
                Clear them
              </button>
            </p>
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
            <div className="chat-settings-choices" role="group" aria-label="Tool rounds">
              {STEP_CHOICES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={settings.maxSteps === value}
                  disabled={saving}
                  onClick={() => void apply({ maxSteps: value })}
                >
                  {value}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h4>Conversation context</h4>
            <p>How much of the current chat accompanies each message. Longer context costs more.</p>
            <div className="chat-settings-choices" role="group" aria-label="Earlier conversation">
              {CONTEXT_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={settings.contextCharacters === choice.value}
                  disabled={saving}
                  onClick={() => void apply({ contextCharacters: choice.value })}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </section>
          {/* The workspace called this the co-model and had it on. It reached the
            run through the same function the standing instructions did, so it
            stopped doing anything at the same moment and for the same reason. */}
          <label className="chat-settings-toggle">
            <input
              type="checkbox"
              checked={settings.contextModel}
              disabled={saving}
              onChange={(event) => void apply({ contextModel: event.target.checked })}
            />
            <span>
              <strong>Local context notes</strong>
              <small>
                Add locally generated syntax hints from your recent messages. They may be wrong and
                add a few tokens per turn.
              </small>
            </span>
          </label>
        </CollapsibleContent>
      </Collapsible>

      {failure && (
        <p className="chat-connection-error" role="alert">
          {failure}
        </p>
      )}
      {note && (
        <p className="chat-settings-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
