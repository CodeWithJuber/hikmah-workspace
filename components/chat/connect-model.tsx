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
            <small>
              Get a free key at{' '}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer noopener">
                openrouter.ai
              </a>
              , paste it once. No card.
            </small>
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
    </section>
  );
}
