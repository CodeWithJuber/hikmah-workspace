'use client';
/** One save convention for settings forms.
 *
 * The rule: a settings form never saves on its own. The user edits freely —
 * every control writes to a local draft — and a single sticky bar appears at
 * the bottom of the viewport the moment the draft differs from what the
 * server has. Save sends one request for the whole form; Discard reverts to
 * the server state. No per-toggle PATCH, no auto-save timer, no "your changes
 * were saved automatically" surprise.
 *
 * Usage:
 *   const [draft, setDraft] = useState<FormState | null>(null); // null = clean
 *   const dirty = draft !== null && differs(draft, serverState);
 *   <SaveBar dirty={dirty} busy={busy} onSave={save} onDiscard={() => setDraft(null)} />
 *
 * Sub-page audit (2026-09-29, P1-10) — where the convention applies:
 * - kernel Owner controls: this SaveBar (draft + one configure request).
 * - connections MCP servers: this SaveBar (row toggles edit a draft).
 * - billing: read-only billing details; nothing editable, no form.
 * - tools (Tools & runtimes): ToolSwitches are independent toggles, not a
 *   form — each persists immediately and the page says so ("Switching one
 *   off applies from your next message"). A save bar would add a second step
 *   to a one-step action, so this is the documented immediate-persist
 *   exception to the rule above.
 * - terminal SSH hosts: the add-server form carries its own explicit
 *   "Save and connect once" / Cancel buttons — explicit save with discard,
 *   same rule, form-local because it is a creation flow rather than an
 *   edit-draft of server state.
 */
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

export function SaveBar({
  dirty,
  busy = false,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  busy?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!dirty) return null;
  return (
    <div className="save-bar" role="status">
      <p>You have unsaved changes.</p>
      <div className="save-bar-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
