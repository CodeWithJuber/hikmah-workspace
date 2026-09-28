'use client';
/** Choosing a model, with what it costs in view.
 *
 * A `<select>` of ids was the whole picker: no prices, no context sizes, no
 * way to search four hundred OpenRouter rows, and on a phone a label clipped
 * to "Free Models Ro…". This is a searchable dialog — cmdk in the same Dialog
 * the rest of the chat uses, so it works at 360px — with one row per model:
 * name, id, the context window, the price per million tokens in and out, and
 * chips for free, tools and reasoning. A price that came from OpenRouter's
 * listing rather than the provider's own catalogue is marked as an estimate.
 *
 * The rows are whatever the caller loaded; this component holds no fetch, so
 * the composer and the settings screen share it over different catalogues.
 */
import { useMemo, useState } from 'react';
import { BrainCircuit, Check, ChevronDown, Eye, LoaderCircle, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import {
  contextLabel,
  formatPrice,
  priceKind,
  type ModelInfo,
} from '@/lib/playground/model-catalog';

export type PickerModel = ModelInfo & { label: string };

type Filter = 'all' | 'free' | 'tools' | 'reasoning';

/** "$3 in · $15 out per 1M", "Free", or nothing when unknown. A model on a
 * local server is free whatever its listing says, because nothing bills it. */
function priceLine(model: ModelInfo, local = false): string {
  if (local) return 'Free';
  const kind = priceKind(model);
  if (kind === 'free') return 'Free';
  const p = model.pricing;
  if (!p || (p.input === undefined && p.output === undefined)) return '';
  const approx = p.source === 'route_estimate' ? '≈ ' : '';
  return `${approx}${formatPrice(p.input)} in · ${formatPrice(p.output)} out / 1M tokens`;
}

export function ModelPicker({
  models,
  value,
  onSelect,
  loading = false,
  error = '',
  title = 'Choose a model',
  className = '',
  allowCustom = true,
  local = false,
  id,
  disabled = false,
  active = true,
}: {
  models: readonly PickerModel[];
  /** The id in use. Shown by its name when the list has it. */
  value: string;
  onSelect: (id: string) => void;
  /** The catalogue is still being fetched. */
  loading?: boolean;
  /** Why the catalogue could not be fetched, in words. */
  error?: string;
  title?: string;
  /** Class for the trigger, so the composer can size it as part of its row. */
  className?: string;
  /** Offer the typed text as a model id when the list does not have it. */
  allowCustom?: boolean;
  /** Every model here is free — a local server, or a provider free within
   * its limits — and is said to be, whatever the listing says. */
  local?: boolean;
  id?: string;
  disabled?: boolean;
  /** Close portalled UI when a persistent settings panel is hidden. */
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  if (!active && open) {
    setOpen(false);
    setQuery('');
  }
  const selected = models.find((model) => model.id === value);
  const hasFree = useMemo(
    () => local || models.some((model) => priceKind(model) === 'free'),
    [models, local],
  );
  const rows = useMemo(
    () =>
      models.filter((model) =>
        filter === 'free'
          ? local || priceKind(model) === 'free'
          : filter === 'tools'
            ? model.tools === true
            : filter === 'reasoning'
              ? model.reasoning === true
              : true,
      ),
    [models, filter, local],
  );
  const typed = query.trim();
  const exact = typed && models.some((model) => model.id === typed);
  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
    setQuery('');
  };

  return (
    <>
      <Button
        id={id}
        type="button"
        variant="outline"
        className={'chat-model-trigger ' + className}
        disabled={disabled}
        onClick={() => {
          setFilter('all');
          setOpen(true);
        }}
        aria-label={value ? 'Model: ' + (selected?.label || value) : 'Choose a model'}
        title={selected ? priceLine(selected, local) || selected.id : value}
      >
        <span>{selected?.label || value || 'Choose a model'}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
      <CommandDialog
        open={active && open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
        title={title}
        description="Search by name or paste an exact model ID. Prices are per million tokens."
        className="model-dialog"
      >
        <CommandInput
          placeholder="Search models or paste an ID…"
          value={query}
          onValueChange={setQuery}
        />
        {/* The summary rules in chat.css target `> summary`; the trigger keeps
            the disclosure's footprint with utilities instead. */}
        <Collapsible
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          className="model-dialog-filter-disclosure"
        >
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-sm">
            <span className="flex items-center gap-1.5">
              <ChevronDown
                size={16}
                aria-hidden="true"
                className={'shrink-0 transition-transform' + (filtersOpen ? ' rotate-180' : '')}
              />
              Filter models
            </span>
            {loading ? (
              <Skeleton className="h-4 w-20" aria-label="Loading model count" role="status" />
            ) : (
              <span className="text-muted-foreground">{models.length} available</span>
            )}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-wrap gap-2 px-3 pb-3" role="group" aria-label="Filter models">
              {(
                [
                  ['all', 'All'],
                  ['free', 'Free'],
                  ['tools', 'Tools'],
                  ['reasoning', 'Reasoning'],
                ] as [Filter, string][]
              )
                .filter(([key]) => key !== 'free' || hasFree)
                .map(([key, label]) => (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={filter === key ? 'secondary' : 'outline'}
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                  >
                    {label}
                  </Button>
                ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        <CommandList className="model-dialog-list">
          {loading && !models.length ? (
            <div className="model-dialog-empty" role="status">
              <LoaderCircle className="spin" size={20} aria-hidden="true" />
              <p>Loading the provider’s catalogue…</p>
            </div>
          ) : (
            <CommandEmpty>
              <div className="model-dialog-empty">
                <strong>{models.length ? 'No matching models' : 'No catalogue yet'}</strong>
                <p>
                  {error ||
                    (models.length
                      ? 'Try another word, or type the exact id.'
                      : 'Return to Connection and save your API key, or paste an exact model ID here.')}
                </p>
              </div>
            </CommandEmpty>
          )}
          {allowCustom && typed && !exact && (
            <CommandGroup heading="Exact id">
              <CommandItem value={'custom ' + typed} forceMount onSelect={() => choose(typed)}>
                <span className="model-row">
                  <span className="model-row-name">Use “{typed}”</span>
                  <span className="model-row-id">as the model id, exactly as typed</span>
                </span>
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading={rows.length ? 'Models' : undefined}>
            {rows.map((model) => {
              const price = priceLine(model, local);
              const kind = local ? 'free' : priceKind(model);
              return (
                <CommandItem
                  key={model.id}
                  value={model.id + ' ' + model.label}
                  onSelect={() => choose(model.id)}
                  className={model.id === value ? 'is-selected' : ''}
                >
                  <span className="model-row">
                    <span className="model-row-head">
                      <span className="model-row-name" dir="auto">
                        {model.label}
                      </span>
                      {model.id === value && <Check size={16} aria-label="Current" />}
                    </span>
                    {model.label !== model.id && <span className="model-row-id">{model.id}</span>}
                    <span className="model-row-meta">
                      {model.context_length ? (
                        <span>{contextLabel(model.context_length)} context</span>
                      ) : null}
                      {price ? (
                        <span className={kind === 'free' ? 'model-chip is-free' : ''}>{price}</span>
                      ) : (
                        <span className="model-row-unpriced">Price not listed</span>
                      )}
                      {model.tools && (
                        <span className="model-chip">
                          <Wrench size={12} aria-hidden="true" /> tools
                        </span>
                      )}
                      {model.reasoning && (
                        <span className="model-chip">
                          <BrainCircuit size={12} aria-hidden="true" /> reasoning
                        </span>
                      )}
                      {model.vision && (
                        <span className="model-chip">
                          <Eye size={12} aria-hidden="true" /> images
                        </span>
                      )}
                    </span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
        {models.some((model) => model.pricing?.source === 'route_estimate') && (
          <p className="model-dialog-note">
            ≈ marks a price taken from OpenRouter’s public listing of the same model; the provider
            bills at its own rate.
          </p>
        )}
      </CommandDialog>
    </>
  );
}
