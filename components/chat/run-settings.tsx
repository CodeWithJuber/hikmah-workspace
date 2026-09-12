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
import type { ChatSettings } from '@/lib/chat/settings';
import { ConnectionSettings } from './connection-settings';

const STEP_CHOICES = [2, 4, 8, 12, 20, 32];
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

      <p className="chat-settings-note" role="status">
        {note}
      </p>
    </div>
  );
}
