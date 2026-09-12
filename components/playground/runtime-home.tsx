'use client';
import { useEffect, useRef, useState } from 'react';
import { Play, Square, ArrowUpRight, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { usePlayground } from './context';
import { HikmahIcon } from '@/components/kernel/icons';
import { runJavascript, warmSandbox } from '@/lib/playground/sandbox-client';
import { ToolSwitches, useToolAvailability } from '@/components/chat/tool-switches';
import { useChatSettings } from '@/hooks/use-chat-settings';
export function RuntimeHome() {
  const { workspace, connectorTools, setWorkspacePage } = usePlayground();
  // The one store a run actually reads. This page used to toggle
  // `preferences.enabledTools` in the workspace blob, which nothing had read
  // since the browser run loop was retired — so the switches looked live and
  // changed nothing.
  const tools = useToolAvailability();
  const { settings, change } = useChatSettings();
  const [code, setCode] = useState(
    'const orders = [120, 80, 240];\nconst total = orders.reduce((a, b) => a + b, 0);\nconsole.log({total, withTax: total * 1.08});',
  );
  const [result, setResult] = useState(''),
    [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  // Compile the runtime while the page is being read rather than when Run is
  // pressed. It takes seconds the first time, and paying for it here is the
  // difference between a slow first run and one that looks broken.
  useEffect(warmSandbox, []);
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
          Available in chat <span>Switching one off applies from your next message</span>
        </h3>
        {/* Every tool the run can offer, not a hand-kept selection of them: the
            list and its availability come from the server, so this page cannot
            drift from what a run actually has. The same switches are on the
            composer's Tools menu, over the same store. */}
        <div className="tools-page-switches">
          <ToolSwitches
            tools={tools}
            disabled={settings.disabledTools}
            onChange={(disabledTools) => change({ disabledTools })}
          />
        </div>
        <p className="small-note">
          Web searches use your configured search service; reference searches use Wikimedia and
          public-page reads use Jina. A tool this deployment cannot run says so rather than being
          offered and failing.
        </p>
        <section className="sandbox-console">
          <header>
            <div>
              <span className="eyebrow">TRY IT HERE</span>
              <h3>JavaScript console</h3>
              <p>Isolated QuickJS runtime per run · 32 MiB · 3 seconds of execution</p>
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
