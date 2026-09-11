'use client';
import { useState } from 'react';
import {
  ChevronDown,
  Check,
  Settings2,
  RefreshCw,
  LoaderCircle,
  BrainCircuit,
  Wrench,
} from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { usePlayground } from './context';
import { priceKind, rateLabel, contextLabel, type ModelInfo } from '@/lib/playground/model-catalog';
export function ModelDetails({ model }: { model?: ModelInfo }) {
  if (!model)
    return (
      <p className="model-detail-empty">
        Load the provider catalog to see prices and model capabilities.
      </p>
    );
  return (
    <div className="selected-model-details">
      <dl>
        <div>
          <dt>Context window</dt>
          <dd>
            {contextLabel(model.context_length)}
            {model.context_length ? ' tokens' : ''}
          </dd>
        </div>
        <div>
          <dt>Maximum output</dt>
          <dd>
            {contextLabel(model.max_output_tokens)}
            {model.max_output_tokens ? ' tokens' : ''}
          </dd>
        </div>
        <div>
          <dt>Input / 1M tokens</dt>
          <dd>{rateLabel(model, 'input')}</dd>
        </div>
        <div>
          <dt>Output / 1M tokens</dt>
          <dd>{rateLabel(model, 'output')}</dd>
        </div>
      </dl>
      <p>
        {model.pricing?.source === 'route_estimate'
          ? 'Public route prices. Your account routing and provider billing can differ.'
          : 'Catalog text rates in USD. Quotas, conditional pricing and other media charges can apply.'}
      </p>
    </div>
  );
}
export function ModelPicker({
  label,
  value,
  onSelect,
}: {
  label?: string;
  value?: string;
  onSelect?: (id: string) => void;
}) {
  const {
    provider,
    setProvider,
    models,
    openSettings,
    isRunning,
    modelsLoading,
    modelsError,
    modelsLoadedAt,
    refreshModels,
  } = usePlayground();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'free' | 'paid'>('all');
  const [toolsOnly, setToolsOnly] = useState(false);
  const selectedId = value ?? provider.model;
  const selected = models.find((m) => m.id === selectedId);
  const effectiveFilter = provider.freeOnly ? 'free' : filter;
  const rows = models.filter(
    (m) =>
      (!provider.freeOnly ||
        (priceKind(m) === 'free' && (m.id === 'openrouter/free' || m.id.endsWith(':free')))) &&
      (effectiveFilter === 'all' || priceKind(m) === effectiveFilter) &&
      (!toolsOnly || m.tools === true),
  );
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (
      value &&
      (provider.apiKey || provider.apiKeySecret) &&
      !models.length &&
      !modelsLoading &&
      !modelsError
    )
      void refreshModels();
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="model-picker"
          disabled={isRunning}
          aria-label={label ?? 'Choose model'}
        >
          <span>{selected?.name || selectedId || 'Choose model'}</span>
          <ChevronDown size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="model-popover model-directory" align="end" sideOffset={8}>
        <div className="model-directory-heading">
          <h2>{provider.freeOnly ? 'Choose a free model' : 'Choose a model'}</h2>
          <Button
            variant="ghost"
            className="icon-button"
            aria-label="Refresh model catalog"
            disabled={modelsLoading || !(provider.apiKey || provider.apiKeySecret)}
            onClick={() => void refreshModels()}
          >
            {modelsLoading ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}
          </Button>
        </div>
        <Command>
          <CommandInput placeholder="Search models by name or ID…" />
          <div className="model-filters" role="group" aria-label="Model filters">
            {(provider.freeOnly ? (['free'] as const) : (['all', 'free', 'paid'] as const)).map(
              (f) => (
                <button
                  key={f}
                  aria-pressed={provider.freeOnly || filter === f}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : f === 'free' ? 'Free' : 'Paid'}
                </button>
              ),
            )}
            <button
              className="tools-filter"
              aria-pressed={toolsOnly}
              onClick={() => setToolsOnly(!toolsOnly)}
            >
              <Wrench size={14} />
              Tools
            </button>
          </div>
          <CommandList className="model-directory-list">
            {modelsLoading && !models.length ? (
              <div className="catalog-empty" role="status">
                <LoaderCircle className="spin" size={24} />
                <strong>Loading your available models</strong>
                <p>Checking prices and capabilities with your provider.</p>
              </div>
            ) : (
              <CommandEmpty>
                <div className="catalog-empty">
                  <strong>{models.length ? 'No matching models' : 'Connect your provider'}</strong>
                  <p>
                    {modelsError ||
                      (!(provider.apiKey || provider.apiKeySecret)
                        ? 'Add your API key in Settings to load available models.'
                        : 'Load your catalog or enter an exact model ID in Settings.')}
                  </p>
                  {!models.length && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setOpen(false);
                        openSettings();
                      }}
                    >
                      Open connection settings
                    </Button>
                  )}
                </div>
              </CommandEmpty>
            )}
            {rows.map((m) => (
              <CommandItem
                key={m.id}
                className="catalog-model-row"
                value={m.id + ' ' + (m.name ?? '')}
                onSelect={() => {
                  if (onSelect) onSelect(m.id);
                  else
                    setProvider((p) => ({
                      ...p,
                      model: m.id,
                      reasoningEffort: 'default',
                      maxTokens: Math.min(p.maxTokens, m.max_output_tokens ?? 131072),
                    }));
                  setOpen(false);
                }}
              >
                <div className="catalog-model-info">
                  <div className="catalog-model-title">
                    <strong>{m.name ?? m.id}</strong>
                    <span className={'price-label ' + priceKind(m)}>
                      {priceKind(m) === 'unknown'
                        ? 'Price not listed'
                        : priceKind(m) === 'free'
                          ? 'Free'
                          : 'Paid'}
                    </span>
                  </div>
                  {m.name && m.name !== m.id && <small className="catalog-model-id">{m.id}</small>}
                  <div className="catalog-rates">
                    <span>Input {rateLabel(m, 'input')}</span>
                    <span>Output {rateLabel(m, 'output')}</span>
                    <small>/ 1M tokens</small>
                  </div>
                  <div className="catalog-capabilities">
                    <span>{contextLabel(m.context_length)} context</span>
                    <span>{contextLabel(m.max_output_tokens)} output</span>
                    {m.tools && (
                      <span>
                        <Wrench size={13} />
                        Tools
                      </span>
                    )}
                    {m.reasoning && (
                      <span>
                        <BrainCircuit size={13} />
                        Reasoning
                      </span>
                    )}
                  </div>
                </div>
                {selectedId === m.id && <Check className="model-selected-check" size={19} />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <footer className="catalog-footer">
          <p>
            {models.length
              ? rows.length +
                ' models · ' +
                (modelsLoadedAt
                  ? 'updated ' +
                    new Date(modelsLoadedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'provider catalog')
              : 'Your provider controls access and usage limits.'}
          </p>
          <p>Listed USD text rates; account billing may differ.</p>
          <Button
            variant="ghost"
            className="manage-connection"
            onClick={() => {
              setOpen(false);
              openSettings();
            }}
          >
            <Settings2 size={16} />
            Manage connection
          </Button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}
