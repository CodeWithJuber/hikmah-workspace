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
import { MAX_INSTRUCTIONS, type ChatSettings } from '@/lib/chat/settings';
import { GATED_TOOLS, withGrant, withoutGrant } from '@/lib/chat/approvals';
import { ConnectionSettings } from './connection-settings';

/** The gated tools, in the words the approval card uses. */
const PERMISSION_LABELS: Record<(typeof GATED_TOOLS)[number], string> = {
  bash: 'Commands on the workspace machine',
  sandbox_run: 'Programs in the sandbox',
  ssh_exec: 'Commands on saved machines',
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
}: {
  settings: ChatSettings;
  /** Applies from the next turn. An answer already written was written under
   * the settings that were in force at the time. */
  onChange: (patch: Partial<ChatSettings>) => Promise<void> | void;
}) {
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

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
      try {
        await onChange(patch);
        setNote('Saved. Applies from your next message.');
      } catch {
        setNote('Could not save that. Try again.');
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
        <p>Which model answers, and the key that pays for it.</p>
        <ConnectionSettings
          connection={settings.connection}
          onChange={(connection) => apply({ connection })}
        />
      </section>
      <section>
        <h3>Tool rounds</h3>
        <p>
          How many times the model may call a tool before it has to answer. Lower is faster and
          cheaper; higher lets it finish longer jobs on its own.
        </p>
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
        <h3>Earlier conversation</h3>
        <p>
          How much of what came before travels with each message. Longer remembers more and costs
          more per answer.
        </p>
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

      <section>
        <label className="chat-settings-toggle">
          <input
            type="checkbox"
            checked={settings.showActivity}
            disabled={saving}
            onChange={(event) => void apply({ showActivity: event.target.checked })}
          />
          <span>
            <strong>Show the working</strong>
            <small>Tool calls, reasoning and what the run cost, under each answer.</small>
          </span>
        </label>
      </section>

      <section>
        <h4>Memory</h4>
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
              A few short excerpts from your other chats that share words with the question, as
              reference. The receipt says when one was used.
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
            <strong>Save preferences in your own words without review</strong>
            <small>
              When the model quotes a preference exactly from your message, keep it at once. Facts
              and anything the model inferred always wait for your review in Memory.
            </small>
          </span>
        </label>
      </section>

      <section>
        <h4>Permissions</h4>
        <p>
          What runs without asking. Everything else shows a card first, and the card can remember
          your answer for one command, one conversation, or for good.
        </p>
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
                        approvals: withoutGrant(settings.approvals, { kind: 'auto', value: tool }),
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
      </section>

      <section className="chat-settings-account">
        <h4>Account</h4>
        <p>
          <a href="/billing">Plan and usage</a> · <a href="/workspace">Workspace</a> ·{' '}
          <a href="/sign-out">Sign out</a>
        </p>
      </section>

      <section>
        <h4>How the answer reads</h4>
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
        <label className="chat-settings-toggle">
          <input
            type="checkbox"
            checked={settings.explainDecisions}
            disabled={saving}
            onChange={(event) => void apply({ explainDecisions: event.target.checked })}
          />
          <span>
            <strong>Explain the decisions</strong>
            <small>A short account of what was chosen, on what evidence, and the trade-offs.</small>
          </span>
        </label>
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
              This project&rsquo;s own syntax compiler annotates your recent messages — who did what
              to whom, negation, attribution, exact numbers — and passes the notes to the model as
              fallible hints. Costs a few tokens a turn.
            </small>
          </span>
        </label>
      </section>

      <section>
        <h4>Your standing instructions</h4>
        {/* This existed in the workspace and reached the model through a
            function that lost its only caller when the browser run loop was
            retired, so for a while the setting was there and did nothing. */}
        <textarea
          className="chat-settings-instructions"
          rows={4}
          maxLength={MAX_INSTRUCTIONS}
          defaultValue={settings.instructions}
          disabled={saving}
          placeholder="Anything you want on every answer — the language to reply in, how to cite, what to avoid."
          onBlur={(event) => {
            if (event.target.value !== settings.instructions)
              void apply({ instructions: event.target.value });
          }}
        />
        <small>
          Added to every run, after the workspace&rsquo;s own rules and before an agent&rsquo;s.
          Saved when you click away.
        </small>
      </section>

      <p className="chat-settings-note" role="status">
        {note}
      </p>
    </div>
  );
}
