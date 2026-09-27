'use client';

import { useId, useState, type FormEvent } from 'react';
import { ArrowUpRight, FlaskConical, Globe, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  prepareResearchBrief,
  RESEARCH_LIMITS,
  RESEARCH_OUTPUTS,
  researchBriefError,
  type PreparedResearchBrief,
  type ResearchCapabilities,
  type ResearchOutput,
} from '@/lib/client/research-brief';
import { assessTask } from '@/lib/agentic/preflight';

export type ResearchBriefDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialQuestion?: string;
  capabilities: ResearchCapabilities;
  /** Adds a reviewable draft; the normal Send action starts the durable run. */
  onPrepare: (brief: PreparedResearchBrief) => void | Promise<void>;
};

export function ResearchBriefDialog({ open, onOpenChange, ...props }: ResearchBriefDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="research-brief-dialog">
        {open && <ResearchBriefForm {...props} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Remounting with the dialog creates a fresh form without overwriting the
 * conversation's draft or attachments. No requests run until the person sends. */
function ResearchBriefForm({
  initialQuestion = '',
  capabilities,
  onPrepare,
  onClose,
}: Omit<ResearchBriefDialogProps, 'open' | 'onOpenChange'> & { onClose: () => void }) {
  const formId = useId();
  const [question, setQuestion] = useState(initialQuestion);
  const [context, setContext] = useState('');
  const [output, setOutput] = useState<ResearchOutput>('evidence');
  const [useWeb, setUseWeb] = useState(capabilities.webSearch);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const input = { question, context, output, useWeb };
  const validationError = researchBriefError(input);
  const preview = validationError ? null : prepareResearchBrief(input, capabilities);
  const preflight = question.trim() ? assessTask(question) : null;
  const hasSources = useWeb && capabilities.webSearch;

  const prepare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (preparing) return;
    if (validationError) {
      setError(validationError);
      return;
    }
    setPreparing(true);
    setError('');
    try {
      await onPrepare(prepareResearchBrief(input, capabilities));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The brief could not be added. Try again.');
    } finally {
      setPreparing(false);
    }
  };

  return (
    <form onSubmit={prepare} className="research-brief-form">
      <DialogHeader className="research-brief-header">
        <span className="research-brief-mark" aria-hidden="true">
          <FlaskConical size={24} />
        </span>
        <DialogTitle className="research-brief-title">Research brief</DialogTitle>
        <DialogDescription className="research-brief-description">
          Turn a question into a clear investigation. Continue with the findings in this chat.
        </DialogDescription>
      </DialogHeader>

      <div className="research-brief-field">
        <label htmlFor={`${formId}-question`}>What would you like to investigate?</label>
        <textarea
          id={`${formId}-question`}
          name="research-question"
          rows={3}
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
            setError('');
          }}
          placeholder="For example, does spaced practice improve learning more than rereading?"
          maxLength={RESEARCH_LIMITS.question}
          required
          disabled={preparing}
          aria-describedby={error ? `${formId}-error` : undefined}
        />
        {preflight?.shouldAsk && preflight.questions[0] && (
          <p className="research-brief-hint">
            A clearer brief will improve the investigation: {preflight.questions[0]}
          </p>
        )}
      </div>

      <fieldset className="research-brief-outcomes" disabled={preparing}>
        <legend>What do you need?</legend>
        <div className="research-brief-outcome-list">
          {RESEARCH_OUTPUTS.map((choice) => (
            <label key={choice.value} className={output === choice.value ? 'is-selected' : ''}>
              <input
                type="radio"
                name={`${formId}-output`}
                value={choice.value}
                checked={output === choice.value}
                onChange={() => setOutput(choice.value)}
              />
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.detail}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <details className="research-brief-context">
        <summary>
          Add context or constraints <span>Optional</span>
        </summary>
        <div className="research-brief-field">
          <label htmlFor={`${formId}-context`}>Useful background</label>
          <textarea
            id={`${formId}-context`}
            name="research-context"
            rows={3}
            value={context}
            onChange={(event) => {
              setContext(event.target.value);
              setError('');
            }}
            maxLength={RESEARCH_LIMITS.context}
            placeholder="Field, audience, existing evidence, timeframe, resources, or what you have already tried."
            disabled={preparing}
          />
          <p>Files already attached in chat will stay attached.</p>
        </div>
      </details>

      <div className="research-brief-sources">
        <Globe size={20} aria-hidden="true" />
        {capabilities.webSearch ? (
          <label>
            <span>
              <strong>Research live sources</strong>
              <small>
                {hasSources && capabilities.parallelResearch
                  ? 'Uses research agents and additional model calls when helpful.'
                  : hasSources
                    ? 'Search and read sources with your selected model.'
                    : 'Prepare an unverified outline from your context.'}
              </small>
            </span>
            <input
              type="checkbox"
              checked={useWeb}
              onChange={(event) => setUseWeb(event.target.checked)}
              disabled={preparing}
            />
          </label>
        ) : (
          <p>
            <strong>Live source access is not available</strong>
            <span>You can prepare an unverified outline and identify what to check next.</span>
          </p>
        )}
      </div>

      {preview && (
        <details className="research-brief-preview">
          <summary>Preview the research brief</summary>
          <p>{preview.prompt}</p>
        </details>
      )}

      {error && (
        <p id={`${formId}-error`} className="research-brief-error" role="alert">
          {error}
        </p>
      )}

      <div className="research-brief-footer">
        <p>
          Edit the brief in chat, then send it. Experiment plans are proposals, not executed tests.
        </p>
        <Button type="submit" disabled={preparing || !question.trim()}>
          {preparing ? (
            <LoaderCircle className="animate-spin" size={16} aria-hidden="true" />
          ) : (
            <ArrowUpRight size={16} aria-hidden="true" />
          )}
          Add to chat
        </Button>
      </div>
    </form>
  );
}
