'use client';
import { randomId } from '../../lib/id.ts';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties } from 'react';
import {
  Settings2,
  Plug,
  BrainCircuit,
  Image as ImageIcon,
  Workflow,
  Plus,
  Trash2,
  Download,
  Upload,
  LoaderCircle,
  ExternalLink,
  ArrowRight,
  ArrowLeft,
  KeyRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { usePlayground } from './context';
import { ModelPicker, ModelDetails } from './model-picker';
import { Choice, downloadJson, errorMessage } from './common';
import { MessageContent } from './message-content';
import { SavedSecretSelect, SecretsSettings } from './secrets-settings';
import { AdminBreadcrumb } from '@/components/admin/admin-breadcrumb';
import { mcpSecretDestination } from '@/lib/playground/secret-reference';
import {
  parseWorkspaceConfig,
  type McpConnection,
  type PromptSkill,
} from '@/lib/playground/workspace-config';
import { validateMcpUrl } from '@/lib/playground/mcp-client';
import { mediaModels, type MediaKind, type MediaModel } from '@/lib/playground/media-client';
import { toast } from 'sonner';
import { clientFetch } from '@/lib/client/request';
export function WorkspaceAdmin({ initialTab = 'overview' }: { initialTab?: string }) {
  // The breadcrumb follows the live tab state, not the route's initialTab:
  // several overview shortcuts switch tabs in place without navigating.
  const tabLabels: Record<string, string> = {
    overview: 'Overview',
    providers: 'Models',
    media: 'Media',
    connectors: 'Connectors',
    secrets: 'Secrets',
    skills: 'Skills',
    plan: 'Product plan',
  };
  const {
    workspace,
    setWorkspace,
    provider,
    models,
    openSettings,
    conversations,
    files,
    connectorTools,
    connectConnector,
  } = usePlayground();
  const router = useRouter();
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState('');
  const [connection, setConnection] = useState<McpConnection | null>(null);
  const [skill, setSkill] = useState<PromptSkill | null>(null);
  const [remove, setRemove] = useState<{ kind: 'skill' | 'connector'; id: string } | null>(null);
  const [catalogs, setCatalogs] = useState<Partial<Record<MediaKind, MediaModel[]>>>({});
  const [plan, setPlan] = useState('');
  // Media runs on OpenRouter, so a workspace already connected to it needs no
  // second credential. The `mediaKey` these used to fall back to was the
  // session-only field, which is gone: a media key is a saved secret now.
  const onOpenRouter = provider.baseUrl.replace(/\/+$/, '') === 'https://openrouter.ai/api/v1';
  const effectiveSecret = workspace.media.secretRef || (onOpenRouter ? provider.apiKeySecret : '');
  const effectiveKey = onOpenRouter ? provider.apiKey : '';
  useEffect(() => {
    if (tab === 'plan' && !plan)
      void clientFetch('/research/product-plan.md')
        .then((r) => {
          if (!r.ok) throw Error('Plan unavailable');
          return r.text();
        })
        .then(setPlan)
        .catch(() =>
          setPlan('The product plan could not be loaded. Please refresh and try again.'),
        );
  }, [tab, plan]);
  const loadCatalog = async (kind: MediaKind) => {
    setBusy(kind);
    try {
      const rows = await mediaModels(effectiveKey, kind, undefined, effectiveSecret);
      setCatalogs((p) => ({ ...p, [kind]: rows }));
      toast.success(rows.length + ' ' + kind + ' models loaded');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy('');
    }
  };
  const mediaFields = [
    {
      kind: 'image',
      field: 'imageModel',
      title: 'Image generation',
      description: 'Create images from prompts.',
    },
    {
      kind: 'speech',
      field: 'speechModel',
      title: 'Text to speech',
      description: 'Turn text into a playable audio file.',
    },
    {
      kind: 'transcription',
      field: 'transcriptionModel',
      title: 'Audio transcription',
      description: 'Transcribe a WAV or MP3 file.',
    },
    {
      kind: 'video',
      field: 'videoModel',
      title: 'Video generation',
      description: 'Create a clip and retrieve its saved job.',
    },
  ] as const;
  return (
    <div className="n-page n-screen-in">
      <header className="n-header">
        <h1>Workspace settings</h1>
        <div className="n-header-actions">
          <Link href="/chat" className="n-icon-btn n-press" aria-label="Back to chat">
            <ArrowLeft size={20} aria-hidden="true" />
          </Link>
        </div>
      </header>
      <div className="admin-scroll">
        <AdminBreadcrumb
          trail={[
            { label: 'Settings', href: '/settings/overview' },
            { label: tabLabels[tab] ?? tab },
          ]}
        />
        <div className="admin-intro">
          <div>
            <h2>Your workspace, your controls</h2>
            <p>
              Your model connections, media and reusable skills. Owner training and model releases
              are in the Owner console.
            </p>
          </div>
          <span className="admin-privacy">Personal workspace</span>
        </div>
        {/* Settings tabs are routes (/settings/<tab>); the page remounts per tab
            via key, so navigation alone switches the tab. The chip row is the
            native tab control — 40px targets, horizontally scrollable. */}
        <div className="n-chip-row" role="tablist" aria-label="Settings sections">
          {(
            ['overview', 'providers', 'media', 'connectors', 'secrets', 'skills', 'plan'] as const
          ).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={'n-chip n-press' + (tab === value ? ' is-active' : '')}
              onClick={() => router.push('/settings/' + value)}
            >
              {tabLabels[value]}
            </button>
          ))}
        </div>
        {tab === 'overview' && (
          <div className="n-tab-panel" role="tabpanel">
            <div className="admin-stats">
              <div>
                <strong>{conversations.length}</strong>
                <span>Conversations</span>
              </div>
              <div>
                <strong>{Object.keys(files).length}</strong>
                <span>Workspace files</span>
              </div>
              <div>
                <strong>
                  {
                    workspace.connectors.filter((c) => c.enabled && connectorTools[c.id]?.length)
                      .length
                  }
                </strong>
                <span>Connected tool servers</span>
              </div>
            </div>
            <ul className="n-list n-stagger" aria-label="Settings shortcuts">
              <li key="0" style={{ '--i': 0 } as CSSProperties}>
                <button
                  type="button"
                  className="n-row n-press-tint"
                  onClick={() => router.push('/tools')}
                  aria-label="Tools & runtimes"
                >
                  <span className="n-row-avatar" aria-hidden="true">
                    <Plug size={20} />
                  </span>
                  <span className="n-row-body">
                    <span className="n-row-title">Tools & runtimes</span>
                    <span className="n-row-snippet">
                      Built-in JavaScript, reference search and your server connections.
                    </span>
                  </span>
                  <span className="n-row-side" aria-hidden="true">
                    <ArrowRight size={20} />
                  </span>
                </button>
              </li>
              <li key="1" style={{ '--i': 1 } as CSSProperties}>
                <button
                  type="button"
                  className="n-row n-press-tint"
                  onClick={() => router.push('/agents')}
                  aria-label="Your agents"
                >
                  <span className="n-row-avatar" aria-hidden="true">
                    <Workflow size={20} />
                  </span>
                  <span className="n-row-body">
                    <span className="n-row-title">Your agents</span>
                    <span className="n-row-snippet">
                      Create reusable roles, instructions and tool permissions.
                    </span>
                  </span>
                  <span className="n-row-side" aria-hidden="true">
                    <ArrowRight size={20} />
                  </span>
                </button>
              </li>
              <li key="2" style={{ '--i': 2 } as CSSProperties}>
                <button
                  type="button"
                  className="n-row n-press-tint"
                  onClick={() => router.push('/superadmin')}
                  aria-label="Owner console · Super Admin"
                >
                  <span className="n-row-avatar" aria-hidden="true">
                    <BrainCircuit size={20} />
                  </span>
                  <span className="n-row-body">
                    <span className="n-row-title">Owner console · Super Admin</span>
                    <span className="n-row-snippet">
                      Owner controls, reviewed learning and model releases.
                    </span>
                  </span>
                  <span className="n-row-side" aria-hidden="true">
                    <ArrowRight size={20} />
                  </span>
                </button>
              </li>
              <li key="3" style={{ '--i': 3 } as CSSProperties}>
                <button
                  type="button"
                  className="n-row n-press-tint"
                  onClick={() => setTab('providers')}
                  aria-label="Models & connection"
                >
                  <span className="n-row-avatar" aria-hidden="true">
                    <Settings2 size={20} />
                  </span>
                  <span className="n-row-body">
                    <span className="n-row-title">Models & connection</span>
                    <span className="n-row-snippet">
                      {provider.model || 'Choose a model to start'}
                    </span>
                  </span>
                  <span className="n-row-side" aria-hidden="true">
                    <ArrowRight size={20} />
                  </span>
                </button>
              </li>
              <li key="4" style={{ '--i': 4 } as CSSProperties}>
                <button
                  type="button"
                  className="n-row n-press-tint"
                  onClick={() => setTab('media')}
                  aria-label="Images, audio & video"
                >
                  <span className="n-row-avatar" aria-hidden="true">
                    <ImageIcon size={20} />
                  </span>
                  <span className="n-row-body">
                    <span className="n-row-title">Images, audio & video</span>
                    <span className="n-row-snippet">Set a model for each media operation.</span>
                  </span>
                  <span className="n-row-side" aria-hidden="true">
                    <ArrowRight size={20} />
                  </span>
                </button>
              </li>
              <li key="5" style={{ '--i': 5 } as CSSProperties}>
                <button
                  type="button"
                  className="n-row n-press-tint"
                  onClick={() => setTab('connectors')}
                  aria-label="Connected tools"
                >
                  <span className="n-row-avatar" aria-hidden="true">
                    <Plug size={20} />
                  </span>
                  <span className="n-row-body">
                    <span className="n-row-title">Connected tools</span>
                    <span className="n-row-snippet">
                      Add an HTTP MCP server with its own credentials.
                    </span>
                  </span>
                  <span className="n-row-side" aria-hidden="true">
                    <ArrowRight size={20} />
                  </span>
                </button>
              </li>
              <li key="6" style={{ '--i': 6 } as CSSProperties}>
                <button
                  type="button"
                  className="n-row n-press-tint"
                  onClick={() => setTab('skills')}
                  aria-label="Agent skills"
                >
                  <span className="n-row-avatar" aria-hidden="true">
                    <BrainCircuit size={20} />
                  </span>
                  <span className="n-row-body">
                    <span className="n-row-title">Agent skills</span>
                    <span className="n-row-snippet">
                      Reusable instructions for the work you do.
                    </span>
                  </span>
                  <span className="n-row-side" aria-hidden="true">
                    <ArrowRight size={20} />
                  </span>
                </button>
              </li>
            </ul>
            <section className="admin-launch-note">
              <h3>Before a commercial launch</h3>
              <p>
                This private workspace saves your conversations and knowledge to your signed-in
                account. Session keys stay in browser memory. Save reusable credentials in the
                Secrets tab. Shared teams, subscription billing, server-side job workers and tenant
                isolation are separate launch milestones. The product plan includes acceptance gates
                and a customer-validation path.
              </p>
              <Button variant="outline" onClick={() => setTab('plan')}>
                Read the product plan
              </Button>
            </section>
          </div>
        )}
        {tab === 'providers' && (
          <div className="n-tab-panel" role="tabpanel">
            <div className="admin-section-heading">
              <div>
                <h3>Chat and reasoning models</h3>
                <p>Prices and capabilities come from your connected provider.</p>
              </div>
              <Button onClick={openSettings}>
                <KeyRound size={16} />
                Connection settings
              </Button>
            </div>
            <div className="admin-model-config">
              <ModelPicker />
              <ModelDetails model={models.find((m) => m.id === provider.model)} />
            </div>
            <p className="small-note">
              OpenRouter and Experiential Labs use the app’s server connection. Custom
              OpenAI-compatible chat endpoints use browser CORS. Session keys stay in browser
              memory. Save reusable credentials in the Secrets tab.
            </p>
          </div>
        )}
        {tab === 'media' && (
          <div className="n-tab-panel" role="tabpanel">
            <div className="admin-section-heading">
              <div>
                <h3>Media models</h3>
                <p>Use an OpenRouter account for the supported media adapters.</p>
              </div>
            </div>
            <SavedSecretSelect
              destination="provider:openrouter"
              value={workspace.media.secretRef}
              label="Saved media secret"
              onChange={(secretRef) =>
                setWorkspace((p) => ({ ...p, media: { ...p.media, secretRef } }))
              }
            />
            {/* A "Session only" key field used to be here. It held the key in
                this tab's memory until a reload, which is not storage, and it
                was one of three fields in this app that pretended otherwise.
                A media key is a saved secret like every other credential: name
                it in the Secrets tab and pick it above. */}
            <p className="small-note">
              No saved secret yet? Add one under <strong>Settings → Secrets</strong> and choose it
              here. It is encrypted before it is stored, which a field on this page could not
              promise.
            </p>
            <p className="small-note">
              Models and charges differ by operation. Generating media makes a provider request;
              catalog loading does not generate content.
            </p>
            <div className="media-provider-list">
              {mediaFields.map((item) => (
                <section key={item.kind}>
                  <div className="admin-section-heading">
                    <div>
                      <h4>{item.title}</h4>
                      <p>{item.description}</p>
                    </div>
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => void loadCatalog(item.kind)}
                    >
                      {busy === item.kind ? <LoaderCircle size={16} className="spin" /> : null}Load
                      models
                    </Button>
                  </div>
                  {catalogs[item.kind]?.length ? (
                    <Choice
                      label={item.title + ' model'}
                      value={workspace.media[item.field]}
                      onChange={(v) =>
                        setWorkspace((p) => ({ ...p, media: { ...p.media, [item.field]: v } }))
                      }
                      options={catalogs[item.kind]!.map((m) => ({
                        value: m.id,
                        label: m.name || m.id,
                      }))}
                    />
                  ) : null}
                  <Input
                    aria-label={item.title + ' model ID'}
                    value={workspace.media[item.field]}
                    onChange={(e) =>
                      setWorkspace((p) => ({
                        ...p,
                        media: { ...p.media, [item.field]: e.target.value },
                      }))
                    }
                    placeholder="Exact model ID"
                  />
                  {item.kind === 'speech' && (
                    <div className="field">
                      <label htmlFor="speech-voice">Voice</label>
                      <Input
                        id="speech-voice"
                        value={workspace.media.voice}
                        onChange={(e) =>
                          setWorkspace((p) => ({
                            ...p,
                            media: { ...p.media, voice: e.target.value },
                          }))
                        }
                        placeholder="Voice supported by your chosen model"
                      />
                    </div>
                  )}
                  {item.kind === 'video' &&
                    catalogs.video?.find((m) => m.id === workspace.media.videoModel)
                      ?.pricing_skus && (
                      <details>
                        <summary>Listed video prices</summary>
                        <pre>
                          {JSON.stringify(
                            catalogs.video.find((m) => m.id === workspace.media.videoModel)
                              ?.pricing_skus,
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                </section>
              ))}
            </div>
            <p className="small-note">
              These adapters use provider defaults for image/video size and duration. Experiential
              chat compatibility does not establish media-generation support. Generated files save
              in this browser; download them before moving devices.
            </p>
          </div>
        )}
        {tab === 'connectors' && (
          <div className="n-tab-panel" role="tabpanel">
            <div className="admin-section-heading">
              <div>
                <h3>MCP tool servers</h3>
                <p>Discover and call tools through a compatible HTTP endpoint.</p>
              </div>
              <Button
                onClick={() =>
                  setConnection({
                    id: randomId(),
                    name: '',
                    url: '',
                    protocol: '2025-11-25',
                    enabled: true,
                    approval: 'ask',
                  })
                }
              >
                <Plus size={16} />
                Add server
              </Button>
            </div>
            {!workspace.connectors.length && (
              <div className="n-empty">
                <span className="n-empty-icon" aria-hidden="true">
                  <Plug size={32} />
                </span>
                <h2>Connect your first tool server</h2>
                <p>Use a server endpoint provided by your service or your own hosted adapter.</p>
                <button
                  type="button"
                  className="n-cta n-press"
                  onClick={() =>
                    setConnection({
                      id: randomId(),
                      name: '',
                      url: '',
                      protocol: '2025-11-25',
                      enabled: true,
                      approval: 'ask',
                    })
                  }
                >
                  <Plus size={16} aria-hidden="true" />
                  Add server
                </button>
              </div>
            )}
            {workspace.connectors.map((c) => (
              <section className="connector-row" key={c.id}>
                <div className="admin-section-heading">
                  <div>
                    <h4>{c.name}</h4>
                    <p className="mono">{c.url}</p>
                  </div>
                  <Switch
                    aria-label={'Enable ' + c.name}
                    checked={c.enabled}
                    onCheckedChange={(v) =>
                      setWorkspace((p) => ({
                        ...p,
                        connectors: p.connectors.map((x) =>
                          x.id === c.id ? { ...x, enabled: v } : x,
                        ),
                      }))
                    }
                  />
                </div>
                <div className="connector-info">
                  <span>MCP {c.protocol}</span>
                  <span>{connectorTools[c.id]?.length ?? 0} tools connected</span>
                  <span>{c.approval === 'ask' ? 'Ask before each call' : 'Calls allowed'}</span>
                </div>
                {/* Likewise: a bearer token that lived until the tab reloaded.
                    A server that needs one is configured under Connections,
                    where its ${VARIABLE} resolves from the encrypted vault. */}
                <div className="connector-actions">
                  <Button
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(c.id);
                      try {
                        await connectConnector(c.id);
                        toast.success('Tool catalog connected');
                      } catch (e) {
                        toast.error(errorMessage(e));
                      } finally {
                        setBusy('');
                      }
                    }}
                  >
                    {busy === c.id ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Plug size={16} />
                    )}
                    Connect & discover
                  </Button>
                  <Button variant="outline" onClick={() => setConnection({ ...c })}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={'Remove ' + c.name}
                    onClick={() => setRemove({ kind: 'connector', id: c.id })}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
                {connectorTools[c.id]?.length > 0 && (
                  <details>
                    <summary>Available tools</summary>
                    <div className="connector-tool-list">
                      {connectorTools[c.id].map((t) => (
                        <div key={t.name}>
                          <strong>{t.name}</strong>
                          <p>{t.description}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </section>
            ))}
            <div className="admin-info-note">
              <h4>Connection requirements</h4>
              <p>
                Saved-secret connections use the app server and a public HTTPS endpoint. Session-key
                connections must allow this app’s origin and MCP headers through CORS.
                Bearer-token/public HTTP tools are supported; OAuth sign-in, stdio processes,
                interactive MCP Apps, sampling and elicitation need dedicated adapters. ChatGPT
                connectors are not automatically installed into this app.
              </p>
              <a
                href="https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http"
                target="_blank"
                rel="noreferrer"
              >
                MCP connection documentation <ExternalLink size={12} />
              </a>
            </div>
          </div>
        )}
        {tab === 'secrets' && (
          <div className="n-tab-panel" role="tabpanel">
            <SecretsSettings />
          </div>
        )}
        {tab === 'skills' && (
          <div className="n-tab-panel" role="tabpanel">
            <div className="admin-section-heading">
              <div>
                <h3>Skills & instruction bundles</h3>
                <p>
                  Enable reusable guidance for new requests. Tools still follow their configured
                  permissions.
                </p>
              </div>
              <Button
                onClick={() =>
                  setSkill({
                    id: randomId(),
                    name: '',
                    description: '',
                    instructions: '',
                    enabled: false,
                  })
                }
              >
                <Plus size={16} />
                New skill
              </Button>
            </div>
            <div className="skill-list">
              {workspace.skills.map((s) => (
                <section className="skill-row" key={s.id}>
                  <BrainCircuit size={20} />
                  <div>
                    <h4>{s.name}</h4>
                    <p>{s.description}</p>
                    <button className="text-link" onClick={() => setSkill({ ...s })}>
                      Edit instructions
                    </button>
                  </div>
                  <Switch
                    aria-label={'Enable skill ' + s.name}
                    checked={s.enabled}
                    onCheckedChange={(v) =>
                      setWorkspace((p) => ({
                        ...p,
                        skills: p.skills.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)),
                      }))
                    }
                  />
                  <Button
                    variant="ghost"
                    className="icon-button"
                    aria-label={'Delete skill ' + s.name}
                    onClick={() => setRemove({ kind: 'skill', id: s.id })}
                  >
                    <Trash2 size={16} />
                  </Button>
                </section>
              ))}
            </div>
            {/* Unlike connectors, this tab never had an empty state: with no
                skills the section rendered as a bare export/import row. */}
            {!workspace.skills.length && (
              <div className="n-empty">
                <span className="n-empty-icon" aria-hidden="true">
                  <BrainCircuit size={32} />
                </span>
                <h2>No skills yet</h2>
                <p>Write reusable instructions for the work you do, then switch them on here.</p>
                <button
                  type="button"
                  className="n-cta n-press"
                  onClick={() =>
                    setSkill({
                      id: randomId(),
                      name: '',
                      description: '',
                      instructions: '',
                      enabled: false,
                    })
                  }
                >
                  <Plus size={16} aria-hidden="true" />
                  New skill
                </button>
              </div>
            )}
            <div className="bundle-controls">
              <Button
                variant="outline"
                onClick={() => downloadJson(workspace, 'hikmah-workspace-bundle.json')}
              >
                <Download size={16} />
                Export configuration bundle
              </Button>
              <label>
                <span>
                  <Upload size={16} />
                  Import JSON bundle
                </span>
                <Input
                  aria-label="Import configuration bundle"
                  type="file"
                  accept="application/json,.json"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      try {
                        if (file.size > 500000) throw Error('Choose a bundle under 500 KB.');
                        setWorkspace(parseWorkspaceConfig(JSON.parse(await file.text())));
                        toast.success('Configuration restored; credentials are not imported.');
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            <p className="small-note">
              Bundles replace this workspace’s skills, connector definitions and media model
              settings. They contain no API keys. Skills are instruction text; importing a bundle
              does not install executable plugins.
            </p>
          </div>
        )}
        {tab === 'plan' && (
          <div className="n-tab-panel" role="tabpanel">
            <div className="admin-section-heading">
              <div>
                <h3>Product & architecture plan</h3>
                <p>Research, launch gates and a focused route to paying customers.</p>
              </div>
              <a className="download-plan" href="/research/product-plan.md" download>
                <Download size={16} />
                Download plan
              </a>
            </div>
            <div className="product-plan">
              {/* An empty `plan` is the only loading signal: the fetch either
                  fills it or sets an error sentence into it. */}
              {plan ? (
                <MessageContent text={plan} />
              ) : (
                <div role="status" aria-label="Loading product plan">
                  <span className="n-shimmer-line" style={{ width: '40%', height: 20 }} />
                  <span
                    className="n-shimmer-line"
                    style={{ width: '100%', marginTop: 12, display: 'block' }}
                  />
                  <span
                    className="n-shimmer-line"
                    style={{ width: '100%', marginTop: 8, display: 'block' }}
                  />
                  <span
                    className="n-shimmer-line"
                    style={{ width: '80%', marginTop: 8, display: 'block' }}
                  />
                  <span
                    className="n-shimmer-line"
                    style={{ width: '60%', marginTop: 8, display: 'block' }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <Dialog open={!!connection} onOpenChange={(v) => !v && setConnection(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {workspace.connectors.some((c) => c.id === connection?.id)
                ? 'Edit tool server'
                : 'Add tool server'}
            </DialogTitle>
            <DialogDescription>
              Connect a server you trust. Its tools can access the permissions granted by its
              credential.
            </DialogDescription>
          </DialogHeader>
          <div className="field">
            <label htmlFor="mcp-name">Name</label>
            <Input
              id="mcp-name"
              value={connection?.name ?? ''}
              onChange={(e) => setConnection((c) => (c ? { ...c, name: e.target.value } : null))}
            />
          </div>
          <div className="field">
            <label htmlFor="mcp-url">HTTP endpoint</label>
            <Input
              id="mcp-url"
              value={connection?.url ?? ''}
              onChange={(e) =>
                setConnection((c) => (c ? { ...c, url: e.target.value, secretRef: '' } : null))
              }
              placeholder="https://your-service.example/mcp"
            />
          </div>
          <SavedSecretSelect
            destination={mcpSecretDestination(connection?.url ?? '')}
            value={connection?.secretRef}
            onChange={(secretRef) => setConnection((c) => (c ? { ...c, secretRef } : null))}
          />
          <Choice
            label="Service type"
            value={connection?.purpose ?? 'general'}
            onChange={(v) =>
              setConnection((c) => (c ? { ...c, purpose: v as McpConnection['purpose'] } : null))
            }
            options={[
              { value: 'general', label: 'General tools' },
              { value: 'browser', label: 'Browser automation' },
              { value: 'search', label: 'Web search' },
              { value: 'ssh', label: 'SSH / terminal bridge' },
            ]}
          />
          <Choice
            label="MCP revision"
            value={connection?.protocol ?? '2025-11-25'}
            onChange={(v) =>
              setConnection((c) => (c ? { ...c, protocol: v as McpConnection['protocol'] } : null))
            }
            options={[
              { value: '2025-11-25', label: '2025-11-25 · initialize/session' },
              { value: '2026-07-28', label: '2026-07-28 · stateless tools' },
            ]}
          />
          <Choice
            label="Tool-call permission"
            value={connection?.approval ?? 'ask'}
            onChange={(v) =>
              setConnection((c) => (c ? { ...c, approval: v as 'ask' | 'allow' } : null))
            }
            options={[
              { value: 'ask', label: 'Ask before each external call' },
              { value: 'allow', label: 'Allow calls to this configured server' },
            ]}
          />
          <Button
            disabled={!connection?.name.trim()}
            className="pointer-coarse:min-h-11"
            onClick={() => {
              if (!connection) return;
              try {
                validateMcpUrl(connection.url);
                // The per-server bearer token this used to clear was the
                // session-only field, which is gone: a server that needs one
                // names a ${VARIABLE} resolved from the encrypted vault.
                setWorkspace((p) => ({
                  ...p,
                  connectors: [...p.connectors.filter((c) => c.id !== connection.id), connection],
                }));
                setConnection(null);
                toast.success('Server saved. Connect to load its tools.');
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Save server
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={!!skill} onOpenChange={(v) => !v && setSkill(null)}>
        <DialogContent className="skill-editor-dialog">
          <DialogHeader>
            <DialogTitle>Edit skill</DialogTitle>
            <DialogDescription>
              Write concrete instructions and acceptance criteria.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Skill name"
            value={skill?.name ?? ''}
            maxLength={80}
            placeholder="Skill name"
            onChange={(e) => setSkill((s) => (s ? { ...s, name: e.target.value } : null))}
          />
          <Input
            aria-label="Skill description"
            value={skill?.description ?? ''}
            maxLength={300}
            placeholder="Short description"
            onChange={(e) => setSkill((s) => (s ? { ...s, description: e.target.value } : null))}
          />
          <Textarea
            aria-label="Skill instructions"
            value={skill?.instructions ?? ''}
            maxLength={12000}
            placeholder="How should the agent approach this work?"
            onChange={(e) => setSkill((s) => (s ? { ...s, instructions: e.target.value } : null))}
          />
          <Button
            disabled={!skill?.name.trim() || !skill?.instructions.trim()}
            className="pointer-coarse:min-h-11"
            onClick={() => {
              if (!skill) return;
              setWorkspace((p) => ({
                ...p,
                skills: [...p.skills.filter((s) => s.id !== skill.id), skill],
              }));
              setSkill(null);
            }}
          >
            Save skill
          </Button>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!remove} onOpenChange={(v) => !v && setRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this {remove?.kind}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes its configuration from this workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="pointer-coarse:min-h-11">Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="pointer-coarse:min-h-11"
              onClick={() => {
                if (!remove) return;
                setWorkspace((p) =>
                  remove.kind === 'skill'
                    ? { ...p, skills: p.skills.filter((s) => s.id !== remove.id) }
                    : { ...p, connectors: p.connectors.filter((c) => c.id !== remove.id) },
                );
                setRemove(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
