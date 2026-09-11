'use client';
import { SavedSecretSelect, SecretsSettings } from './secrets-settings';
import { useEffect, useRef, useState } from 'react';
import {
  Plug,
  SlidersHorizontal,
  Database,
  Eye,
  EyeOff,
  LoaderCircle,
  CheckCircle2,
  Sun,
  Moon,
  Download,
  Upload,
  KeyRound,
  ArrowRight,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from '@/components/ui/command';
import { complete, listModels, ProviderTransportError } from '@/lib/playground/transport';
import { RELAY_PROVIDERS, relayProviderFor } from '@/lib/playground/provider-routes';
import { usePlayground } from './context';
import { Choice, Notice, errorMessage, downloadJson } from './common';
import { ModelPicker, ModelDetails } from './model-picker';
import { ErrorCard, type DisplayError } from './error-card';
import { toast } from 'sonner';
export function Settings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const {
    provider,
    setProvider,
    models,
    setModels,
    session,
    importSession,
    storageMessage,
    preferences,
    setPreferences,
    isRunning,
  } = usePlayground();
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ message: string; kind: 'catalog' | 'generation' } | null>(
    null,
  );
  const [error, setError] = useState<DisplayError | null>(null);
  const [reveal, setReveal] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const relay = relayProviderFor(provider.baseUrl);
  useEffect(() => {
    abortRef.current?.abort();
    setBusy('');
    setResult(null);
    setError(null);
  }, [
    provider.baseUrl,
    provider.apiKey,
    provider.apiKeySecret,
    provider.model,
    provider.maxTokens,
    provider.temperature,
    provider.customSampling,
    provider.stream,
    provider.tokenParameter,
    provider.reasoningEffort,
    provider.freeOnly,
  ]);
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setBusy('');
      setReveal(false);
    }
  }, [open]);
  const check = async (kind: 'catalog' | 'generation') => {
    if (busy || isRunning) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(kind);
    setResult(null);
    setError(null);
    const start = performance.now();
    try {
      if (kind === 'catalog') {
        const rows = await listModels(provider, controller.signal);
        if (controller.signal.aborted) return;
        setModels(rows);
        setResult({
          kind,
          message: `${rows.length} available models loaded. Choose a model, then test generation.`,
        });
      } else {
        const answer = await complete(
          { ...provider, maxTokens: Math.min(provider.maxTokens, 512) },
          [{ role: 'user', content: 'Reply briefly with the word Connected.' }],
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!answer.content.trim())
          throw Error(
            'The model returned no visible text. Increase the output limit or choose another model.',
          );
        setResult({
          kind,
          message: `Generation succeeded in ${((performance.now() - start) / 1000).toFixed(1)}s. ${answer.usage.total_tokens !== undefined ? answer.usage.total_tokens + ' tokens reported.' : ''} Your selected model can answer.`,
        });
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setError({
        message: errorMessage(e),
        code: e instanceof ProviderTransportError ? (e.diagnostic?.code ?? e.code) : undefined,
        action: e instanceof ProviderTransportError ? e.diagnostic?.action : undefined,
        model: provider.model,
        provider: relay?.name,
        status:
          e instanceof ProviderTransportError ? (e.diagnostic?.status ?? e.status) : undefined,
        retryAfterSeconds:
          e instanceof ProviderTransportError ? e.diagnostic?.retryAfterSeconds : undefined,
      });
    } finally {
      if (abortRef.current === controller) {
        setBusy('');
        abortRef.current = null;
      }
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog">
        <DialogHeader className="settings-heading">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Make this workspace work for you.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="connection" className="settings-tabs">
          <TabsList className="settings-tabs-list">
            <TabsTrigger value="connection">
              <Plug size={16} />
              Connection
            </TabsTrigger>
            <TabsTrigger value="secrets">
              <KeyRound size={16} />
              Secrets
            </TabsTrigger>
            <TabsTrigger value="preferences">
              <SlidersHorizontal size={16} />
              Preferences
            </TabsTrigger>
            <TabsTrigger value="data">
              <Database size={16} />
              Your data
            </TabsTrigger>
          </TabsList>
          <div className="settings-scroll">
            <TabsContent value="connection">
              <div className="settings-section-title">
                <span className="step-number">1</span>
                <div>
                  <h3>Connect a provider</h3>
                  <p>Use your own account and API key.</p>
                </div>
              </div>
              <Choice
                label="Provider"
                value={relay?.id ?? 'custom'}
                onChange={(v) => {
                  setProvider((p) => ({
                    ...p,
                    baseUrl: RELAY_PROVIDERS.find((x) => x.id === v)?.baseUrl ?? '',
                    apiKey: '',
                    apiKeySecret: '',
                    model: '',
                    customSampling: false,
                  }));
                }}
                options={[
                  ...RELAY_PROVIDERS.map((p) => ({ value: p.id, label: p.name })),
                  { value: 'custom', label: 'Custom OpenAI-compatible API' },
                ]}
              />
              <div className="field">
                <label htmlFor="provider-url">API base URL</label>
                <Input
                  id="provider-url"
                  value={provider.baseUrl}
                  onChange={(e) =>
                    setProvider((p) => ({
                      ...p,
                      baseUrl: e.target.value,
                      apiKey: '',
                      apiKeySecret: '',
                      model: '',
                    }))
                  }
                  placeholder="https://api.experientiallabs.ai/v1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {relay && (
                <SavedSecretSelect
                  destination={'provider:' + relay.id}
                  value={provider.apiKeySecret}
                  disabled={isRunning}
                  onChange={(apiKeySecret) =>
                    setProvider((p) => ({ ...p, apiKeySecret, apiKey: '' }))
                  }
                />
              )}
              <div className="field">
                <label htmlFor="provider-key">
                  API key <span className="optional-label">Session only</span>
                </label>
                <div className="password-input">
                  <Input
                    id="provider-key"
                    type={reveal ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={provider.apiKey}
                    onChange={(e) =>
                      setProvider((p) => ({ ...p, apiKey: e.target.value, apiKeySecret: '' }))
                    }
                    placeholder="Paste your provider key"
                  />
                  <Button
                    variant="ghost"
                    className="icon-button"
                    aria-label={reveal ? 'Hide API key' : 'Show API key'}
                    onClick={() => setReveal(!reveal)}
                  >
                    {reveal ? <EyeOff size={17} /> : <Eye size={17} />}
                  </Button>
                </div>
              </div>
              <p className="connection-route">
                <KeyRound size={14} />
                {relay
                  ? `${relay.name} connects through the app server.`
                  : 'Custom endpoints connect from your browser and require CORS support.'}{' '}
                Save reusable keys in the Secrets tab. Session keys are excluded from saved
                settings.
              </p>
              <div className="settings-section-title separated">
                <span className="step-number">2</span>
                <div>
                  <h3>Choose a model</h3>
                  <p>Use an exact model ID from your provider.</p>
                </div>
                <Button
                  variant="outline"
                  disabled={!!busy || isRunning}
                  onClick={() => void check('catalog')}
                >
                  {busy === 'catalog' ? <LoaderCircle className="spin" size={16} /> : null}Load
                  models
                </Button>
              </div>
              <div className="field">
                <label>Selected model</label>
                <ModelPicker label="Select your model" />
              </div>
              <label className="setting-switch">
                <div>
                  <strong>Free models only</strong>
                  <span>
                    Blocks paid models, unknown routes and media generation. OpenRouter requests
                    carry a zero-price ceiling.
                  </span>
                </div>
                <Switch
                  aria-label="Free models only"
                  checked={provider.freeOnly === true}
                  onCheckedChange={(freeOnly) => setProvider((p) => ({ ...p, freeOnly }))}
                />
              </label>
              {provider.freeOnly && (
                <Button
                  variant="outline"
                  onClick={() =>
                    setProvider((p) => ({
                      ...p,
                      baseUrl: 'https://openrouter.ai/api/v1',
                      apiKey: p.baseUrl === 'https://openrouter.ai/api/v1' ? p.apiKey : '',
                      apiKeySecret:
                        p.baseUrl === 'https://openrouter.ai/api/v1' ? p.apiKeySecret : '',
                      model: 'openrouter/free',
                      reasoningEffort: 'default',
                      customSampling: false,
                    }))
                  }
                >
                  Use OpenRouter Free Router
                </Button>
              )}
              <ModelDetails model={models.find((m) => m.id === provider.model)} />
              <details className="manual-model-id">
                <summary>Enter a model ID manually</summary>
                <Input
                  id="provider-model"
                  aria-label="Model ID"
                  value={provider.model}
                  onChange={(e) =>
                    setProvider((p) => ({
                      ...p,
                      model: e.target.value,
                      reasoningEffort: 'default',
                    }))
                  }
                  placeholder="Exact provider model ID"
                  autoComplete="off"
                  spellCheck={false}
                />
              </details>
              <div className="settings-section-title separated">
                <span className="step-number">3</span>
                <div>
                  <h3>Test a real response</h3>
                  <p>One short model request. Provider usage may apply.</p>
                </div>
                <Button
                  disabled={!!busy || isRunning || !provider.model}
                  onClick={() => void check('generation')}
                >
                  {busy === 'generation' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ArrowRight size={16} />
                  )}
                  Test generation
                </Button>
              </div>
              {result && (
                <div className="connection-success" role="status">
                  <CheckCircle2 size={19} />
                  <span>{result.message}</span>
                </div>
              )}
              {error && <ErrorCard error={error} />}
              <details className="settings-advanced">
                <summary>Advanced connection</summary>
                <div className="settings-grid">
                  <div className="field">
                    <label htmlFor="max-output">Maximum output tokens</label>
                    <Input
                      id="max-output"
                      type="number"
                      min={128}
                      max={131072}
                      value={provider.maxTokens}
                      onChange={(e) =>
                        setProvider((p) => ({
                          ...p,
                          maxTokens: Math.min(131072, Math.max(128, Number(e.target.value) || 128)),
                        }))
                      }
                    />
                  </div>
                  <Choice
                    label="Token parameter"
                    value={provider.tokenParameter ?? 'max_tokens'}
                    onChange={(v) =>
                      setProvider((p) => ({
                        ...p,
                        tokenParameter: v as 'max_tokens' | 'max_completion_tokens',
                      }))
                    }
                    options={[
                      { value: 'max_tokens', label: 'max_tokens (gateway default)' },
                      { value: 'max_completion_tokens', label: 'max_completion_tokens' },
                    ]}
                  />
                </div>
                <label className="setting-switch">
                  <div>
                    <strong>Stream responses</strong>
                    <span>Show the answer as it arrives.</span>
                  </div>
                  <Switch
                    checked={provider.stream !== false}
                    onCheckedChange={(v) => setProvider((p) => ({ ...p, stream: v }))}
                  />
                </label>
                <label className="setting-switch">
                  <div>
                    <strong>Custom sampling</strong>
                    <span>Leave off for the widest model compatibility.</span>
                  </div>
                  <Switch
                    checked={provider.customSampling === true}
                    onCheckedChange={(v) => setProvider((p) => ({ ...p, customSampling: v }))}
                  />
                </label>
                {provider.customSampling && (
                  <div className="field">
                    <label htmlFor="temperature">Temperature</label>
                    <Input
                      id="temperature"
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={provider.temperature}
                      onChange={(e) =>
                        setProvider((p) => ({
                          ...p,
                          temperature: Math.min(2, Math.max(0, Number(e.target.value) || 0)),
                        }))
                      }
                    />
                    <p className="small-note">
                      Some models reject this field or only accept a fixed value.
                    </p>
                  </div>
                )}
                <p className="small-note">
                  The server forwards requests only to the two provider presets. Other endpoints use
                  a direct browser connection. Messages and requested file contents go to your
                  provider; its rates and data policies apply. Failures are not retried
                  automatically. When enabled, unfinished text and agent work continue with
                  additional billable requests. Models are never switched silently.
                </p>
                <Button
                  variant="outline"
                  disabled={!provider.apiKey}
                  onClick={() => {
                    setProvider((p) => ({ ...p, apiKey: '' }));
                    toast.success('Session key cleared');
                  }}
                >
                  Clear session key
                </Button>
              </details>
            </TabsContent>
            <TabsContent value="secrets">
              <SecretsSettings />
            </TabsContent>
            <TabsContent value="preferences">
              <h3>Appearance</h3>
              <div className="theme-options">
                <Button
                  variant={preferences.theme === 'light' ? 'default' : 'outline'}
                  onClick={() => setPreferences((p) => ({ ...p, theme: 'light' }))}
                >
                  <Sun size={19} />
                  Light
                </Button>
                <Button
                  variant={preferences.theme === 'dark' ? 'default' : 'outline'}
                  onClick={() => setPreferences((p) => ({ ...p, theme: 'dark' }))}
                >
                  <Moon size={19} />
                  Dark
                </Button>
              </div>
              <div className="separated">
                <Choice
                  label="Response style"
                  value={preferences.responseStyle}
                  onChange={(v) =>
                    setPreferences((p) => ({ ...p, responseStyle: v as typeof p.responseStyle }))
                  }
                  options={[
                    { value: 'concise', label: 'Concise' },
                    { value: 'balanced', label: 'Balanced' },
                    { value: 'detailed', label: 'Detailed' },
                  ]}
                />
                <label className="setting-switch">
                  <div>
                    <strong>Enter to send</strong>
                    <span>Shift + Enter adds a new line. Ctrl/⌘ + Enter always sends.</span>
                  </div>
                  <Switch
                    checked={preferences.enterToSend}
                    onCheckedChange={(v) => setPreferences((p) => ({ ...p, enterToSend: v }))}
                  />
                </label>
              </div>
              <div className="field separated">
                <label htmlFor="custom-instructions">Your instructions</label>
                <Textarea
                  id="custom-instructions"
                  value={preferences.instructions}
                  onChange={(e) => setPreferences((p) => ({ ...p, instructions: e.target.value }))}
                  maxLength={4000}
                  placeholder="For example: Use simple English. For coding, prefer TypeScript and explain how to test."
                />
                <p className="small-note">
                  Applied to new requests. Your instructions are saved to your private workspace.
                </p>
              </div>
            </TabsContent>
            <TabsContent value="data">
              <h3>Your saved workspace</h3>
              <p className="muted">
                Conversations, knowledge, run checkpoints, files and preferences sync to your
                signed-in workspace. A device copy supports recovery. Session keys stay in browser
                memory. Saved secret values remain in encrypted server storage and are excluded from
                exports.
              </p>
              <div className="data-action">
                <Download size={24} />
                <div>
                  <strong>Export workspace session</strong>
                  <p>
                    Chats, files and preferences. Download generated media separately. No API keys.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => downloadJson(session(), 'hikmah-session.json')}
                >
                  Export
                </Button>
              </div>
              <div className="data-action">
                <Upload size={24} />
                <div>
                  <strong>Import workspace session</strong>
                  <p>Replaces the current workspace session. Export it first if needed.</p>
                </div>
              </div>
              <Input
                aria-label="Import session file"
                type="file"
                accept="application/json,.json"
                disabled={isRunning}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    try {
                      if (file.size > 20000000) throw Error('Choose a session file under 20 MB.');
                      importSession(await file.text());
                      toast.success('Session restored. Re-enter your provider key to connect.');
                      onOpenChange(false);
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }
                  e.target.value = '';
                }}
              />
              <p className="small-note separated">{storageMessage}</p>
            </TabsContent>
          </div>
        </Tabs>
        <footer className="settings-footer">
          <span>Changes save automatically</span>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
