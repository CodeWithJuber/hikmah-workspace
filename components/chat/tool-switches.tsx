'use client';
/** Which tools a run may use, as switches.
 *
 * The list comes from `GET /api/agents` — the server's own `BUILT_IN_TOOLS`
 * with its availability — so a screen can never offer a switch for a tool the
 * run does not have. That was the original point of building the chat's menu
 * this way, and it is why the workspace's Tools screen now renders this rather
 * than its own list: that one named five tools out of twenty-one and wrote a
 * preference nothing had read since the browser run loop was retired.
 *
 * Both callers write the same field of the same store, `disabledTools` in
 * `chat_settings`, so the two screens agree by construction.
 */
import { useEffect, useState } from 'react';

export type Availability = { name: string; available: boolean; reason?: string };

/** Plain names for tools whose identifiers are not sentences. Anything absent
 * falls back to its identifier with the underscores taken out, which is worse
 * but never wrong. */
const LABELS: Record<string, string> = {
  ask_user: 'Ask you a question',
  bash: 'Run shell commands',
  calculate: 'Arithmetic',
  delete_file: 'Delete a workspace file',
  generate_image: 'Generate images',
  generate_speech: 'Generate speech',
  interpret_meaning: 'Interpret a sentence',
  list_files: 'List workspace files',
  list_ssh_hosts: 'List saved SSH hosts',
  read_file: 'Read a workspace file',
  read_principle: 'Look up an operating principle',
  remember: 'Remember something you said',
  read_webpage: 'Read a web page',
  research_quran: "Look up Qur'an references",
  run_javascript: 'Run JavaScript, isolated',
  sandbox_run: 'Run code in the workbench',
  search_reference: 'Search reference works',
  search_web: 'Search the web',
  simulate_plan: 'Simulate a plan',
  ssh_exec: 'Run a command over SSH',
  transition_estimate: 'Estimate a transition',
  update_plan: 'Keep a task plan',
  write_file: 'Write a workspace file',
};

export const toolLabel = (name: string) => LABELS[name] ?? name.replace(/_/g, ' ');

/** The tools this deployment can offer, or an empty list while unknown. */
export function useToolAvailability() {
  const [tools, setTools] = useState<Availability[]>([]);
  useEffect(() => {
    let live = true;
    void fetch('/api/agents', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!live || !payload) return;
        // Availability travels with the list, so nothing offers a switch for a
        // tool this deployment cannot run.
        setTools(
          (payload.availability as Availability[] | undefined) ??
            ((payload.tools as string[] | undefined) ?? []).map((name) => ({
              name,
              available: true,
            })),
        );
      })
      // No list means no switches, which is better than switches that lie
      // about what is on.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return tools;
}

export function ToolSwitches({
  tools,
  disabled,
  onChange,
  busy,
}: {
  tools: Availability[];
  /** Tool names the owner has switched off. */
  disabled: string[];
  onChange: (disabledTools: string[]) => Promise<void> | void;
  busy?: boolean;
}) {
  const off = new Set(disabled);
  const toggle = (name: string, on: boolean) =>
    void onChange(
      on ? disabled.filter((tool) => tool !== name) : [...new Set([...disabled, name])],
    );

  return (
    <ul className="chat-tool-switches">
      {tools.map((tool) => (
        <li key={tool.name}>
          <label title={tool.reason}>
            <input
              type="checkbox"
              checked={tool.available && !off.has(tool.name)}
              disabled={!tool.available || busy}
              onChange={(event) => toggle(tool.name, event.target.checked)}
            />
            <span>
              {toolLabel(tool.name)}
              <code>{tool.name}</code>
            </span>
          </label>
          {!tool.available && <small>{tool.reason}</small>}
        </li>
      ))}
    </ul>
  );
}

/** How many of the offered tools are currently on. */
export const activeToolCount = (tools: Availability[], disabled: string[]) => {
  const off = new Set(disabled);
  return tools.filter((tool) => tool.available && !off.has(tool.name)).length;
};
