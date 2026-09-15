'use client';
/** The first thing a new person sees when nothing would pay for a model.
 *
 * They used to see three starters, tap one, and get a red card that named an
 * environment variable. Now the empty conversation says the one thing that is
 * actually in the way and offers the two ways past it: a free key from
 * OpenRouter (a minute, no card), or the provider they already use. Both lead
 * to the same Settings tab; the card only opens it.
 */
import { ArrowRight, KeyRound } from 'lucide-react';

export function ConnectModelCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <section className="chat-connect" aria-labelledby="chat-connect-title">
      <KeyRound size={20} aria-hidden="true" />
      <h3 id="chat-connect-title">Connect a model to start</h3>
      <p>
        Hikmah talks to models with a key of your own, and none is saved yet. It takes about a
        minute and there is nothing to pay.
      </p>
      <div className="chat-connect-choices">
        <button type="button" className="is-primary" onClick={onOpenSettings}>
          <span>
            <strong>Use free models</strong>
            {/* The openrouter.ai link used to be an <a> inside this <button>.
                A link inside a button is a control inside a control: pressing
                it fired BOTH — the settings dialog opened and a tab opened —
                and a screen reader could not reach the link at all, because a
                button's contents are its label. It is now the sentence under
                the two choices, where it is one thing that does one thing. */}
            <small>Get a free key at openrouter.ai, paste it once. No card.</small>
          </span>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={onOpenSettings}>
          <span>
            <strong>Use my own provider</strong>
            <small>OpenAI, Anthropic, Kimi, Gemini, DeepSeek, Ollama and more.</small>
          </span>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="chat-connect-note">
        Free keys come from{' '}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer noopener">
          openrouter.ai
        </a>
        .
      </p>
    </section>
  );
}
