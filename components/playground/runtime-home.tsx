'use client';
import { useRef, useState } from 'react';
import { Play, Square, ArrowUpRight, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { usePlayground } from './context';
import { HikmahIcon } from '@/components/kernel/icons';
import { runJavascript } from '@/lib/playground/sandbox-client';
const defaults = [
  {
    id: 'search_web',
    name: 'Web search',
    description: 'Search the web through your configured SearXNG or Brave service.',
    icon: 'search' as const,
  },
  {
    id: 'research_quran',
    name: 'Qur’anic research index',
    description:
      'Find verse-linked research notes and source references, with verification status.',
    icon: 'search' as const,
  },
  {
    id: 'run_javascript',
    name: 'JavaScript sandbox',
    description: 'Run data transforms, algorithms and checks locally. No provider call.',
    icon: 'artifact' as const,
  },
  {
    id: 'search_reference',
    name: 'Reference search',
    description: 'Wikipedia background sources in five languages. No API key.',
    icon: 'search' as const,
  },
  {
    id: 'read_webpage',
    name: 'Read a public page',
    description: 'Retrieve page text through Jina Reader. No login or browser clicks.',
    icon: 'browser' as const,
  },
];
export function RuntimeHome() {
  const { preferences, setPreferences, workspace, connectorTools, setWorkspacePage, isRunning } =
    usePlayground();
  const [code, setCode] = useState(
    'const orders = [120, 80, 240];\nconst total = orders.reduce((a, b) => a + b, 0);\nconsole.log({total, withTax: total * 1.08});',
  );
  const [result, setResult] = useState(''),
    [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const run = async () => {
    setBusy(true);
    setResult('');
    const c = new AbortController();
    abort.current = c;
    try {
      const r = await runJavascript(code, c.signal);
      setResult(
        [r.stdout, r.result, r.error ? 'Error: ' + r.error : 'Completed in ' + r.elapsedMs + ' ms']
          .filter(Boolean)
          .join('\n'),
      );
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Execution failed.');
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };
  return (
    <div className="destination-page">
      <header className="workspace-header">
        <SidebarTrigger />
        <h1>Tools & runtimes</h1>
        <Button variant="outline" onClick={() => setWorkspacePage('admin/connectors')}>
          Manage connections <ArrowUpRight size={15} />
        </Button>
      </header>
      <div className="destination-scroll">
        <section className="destination-hero">
          <span className="eyebrow">FROM ANSWER TO ACTION</span>
          <h2>
            A workspace that can
            <br />
            do the work.
          </h2>
          <p>
            Use built-in tools immediately. Connect your own services for server execution, browser
            automation and business operations.
          </p>
        </section>
        <h3 className="section-label">
          Available in chat <span>Service limits may apply</span>
        </h3>
        <div className="runtime-grid">
          {defaults.map((t) => (
            <section className="runtime-card" key={t.id}>
              <span className="agent-avatar">
                <HikmahIcon name={t.icon} size={24} />
              </span>
              <h3>{t.name}</h3>
              <p>{t.description}</p>
              <label className="agent-switch-row">
                <span>
                  {preferences.enabledTools.includes(t.id)
                    ? 'Enabled in chats'
                    : 'Disabled in chats'}
                </span>
                <Switch
                  aria-label={'Enable ' + t.name}
                  disabled={isRunning}
                  checked={preferences.enabledTools.includes(t.id)}
                  onCheckedChange={(enabled) =>
                    setPreferences((p) => ({
                      ...p,
                      enabledTools: enabled
                        ? [...new Set([...p.enabledTools, t.id])]
                        : p.enabledTools.filter((x) => x !== t.id),
                    }))
                  }
                />
              </label>
            </section>
          ))}
        </div>
        <p className="small-note">
          Files, calculator, task plans and reviewed memory are also built in. Web searches use your
          configured search service; reference searches use Wikimedia and public-page reads use
          Jina. Availability and service limits are reported in chat.
        </p>
        <section className="sandbox-console">
          <header>
            <div>
              <span className="eyebrow">TRY IT HERE</span>
              <h3>JavaScript console</h3>
              <p>Fresh QuickJS runtime per run · 32 MiB · 3 seconds of execution</p>
            </div>
            {busy ? (
              <Button onClick={() => abort.current?.abort()} variant="outline">
                <Square size={15} />
                Stop
              </Button>
            ) : (
              <Button onClick={() => void run()} disabled={!code.trim()}>
                <Play size={15} />
                Run code
              </Button>
            )}
          </header>
          <div className="sandbox-split">
            <Textarea
              aria-label="JavaScript code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={40000}
              spellCheck={false}
            />
            <pre aria-live="polite">
              {busy
                ? 'Starting isolated runtime…'
                : result ||
                  'Output appears here.\nNo network, Node APIs, host files or app credentials.'}
            </pre>
          </div>
        </section>
        <h3 className="section-label">Connect your environment</h3>
        <div className="connection-paths">
          <section>
            <HikmahIcon name="terminal" size={25} />
            <h3>Python, Node & SSH</h3>
            <p>
              Run Python and Node in disposable containers on your own server. Expose only SSH
              actions you configure. Connect the runtime through MCP.
            </p>
            <a className="runtime-download" href="/runtime/hikmah-runtime.zip" download>
              <Download size={16} />
              Download runtime starter
            </a>
            <a href="/runtime/README.md" target="_blank" rel="noreferrer">
              Setup guide <ArrowUpRight size={14} />
            </a>
          </section>
          <section>
            <HikmahIcon name="browser" size={25} />
            <h3>Browser & web search</h3>
            <p>
              Connect Playwright, browser automation, or a search MCP service. Tool discovery shows
              exactly which actions your server exposes.
            </p>
            <Button variant="outline" onClick={() => setWorkspacePage('admin/connectors')}>
              Connect an MCP server
            </Button>
          </section>
          <section>
            <HikmahIcon name="voice" size={25} />
            <h3>Voice, video & operations</h3>
            <p>
              Use chat dictation and read-aloud. For phone calls, CRM actions and media rendering,
              connect the service that owns those capabilities.
            </p>
            <Button variant="outline" onClick={() => setWorkspacePage('agents')}>
              Explore workflow templates
            </Button>
          </section>
        </div>
        <h3 className="section-label">Your connected services</h3>
        {workspace.connectors.length ? (
          workspace.connectors.map((c) => (
            <div className="service-status" key={c.id}>
              <HikmahIcon name="tools" />
              <div>
                <strong>{c.name}</strong>
                <p>
                  {c.enabled && connectorTools[c.id]?.length
                    ? connectorTools[c.id].length +
                      ' discovered tools · ' +
                      (c.approval === 'ask' ? 'approval per call' : 'calls allowed')
                    : 'Tools will be discovered when this connection is used'}
                </p>
              </div>
              <Button variant="ghost" onClick={() => setWorkspacePage('admin/connectors')}>
                Configure
              </Button>
            </div>
          ))
        ) : (
          <div className="plain-callout">
            <strong>No external runtime connected</strong>
            <p>
              Your OpenRouter key supplies the model. A separate runtime supplies Python, Node, SSH
              or browser control. The app never claims those actions ran without a connected tool
              result.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
