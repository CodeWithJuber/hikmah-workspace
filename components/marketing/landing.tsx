/** The page a visitor sees before they have an account.
 *
 * A server component with no client JavaScript: it is a page of words, links
 * and a table, and the fastest first paint is the one that ships no bundle.
 * Everything it claims is something that actually ships — the durable run loop,
 * the workbench, Qur'an grounding through MCP — because the quickest way to
 * lose someone is to promise on this page what the product does not do on the
 * next one.
 */
import Link from 'next/link';
import {
  ArrowRight,
  BookOpenCheck,
  Brain,
  Check,
  Puzzle,
  Search,
  Server,
  Sparkles,
  Terminal,
  Waypoints,
} from 'lucide-react';
import { HikmahIcon } from '@/components/kernel/icons';
import type { PublicAuthConfig } from '@/lib/auth/public-config';
import { priceLabelFor, type Plan } from '@/lib/billing/plans';

/** What it does for the work most people actually bring: writing, questions,
 * research, learning. Listed first, because a visitor who does not write code
 * used to meet a terminal in the first card and leave. */
const EVERYDAY = [
  {
    icon: Brain,
    title: 'Remembers you — on your terms',
    body: 'It keeps what you tell it about yourself and your work, in your own words, and says under each answer which memories it used. Anything it merely inferred waits for your review; nothing is saved behind your back.',
  },
  {
    icon: Search,
    title: 'Research that reads the sources',
    body: 'Ask for deep research and several agents fan out, each reading real pages, and come back with findings and the exact links they opened — and a plain list of what they could not settle.',
  },
  {
    icon: Sparkles,
    title: 'Learns while you do something else',
    body: 'Hand it a topic to learn in the background. It works on its own, files what it found for your review, and writes you a report — no tab to keep open, nothing lost if you close it.',
  },
  {
    icon: BookOpenCheck,
    title: 'Qur’an grounded, not guessed',
    body: 'Verses, translations and tafsir come from quran.com with the edition cited, never from the model’s memory. It can say what a text says, and where.',
  },
];

const CAPABILITIES = [
  {
    icon: Waypoints,
    title: 'Answers that survive a closed tab',
    body: 'A run belongs to the server, not to your browser. Close the laptop mid-answer, open it on your phone, and the work carried on without you.',
  },
  {
    icon: Terminal,
    title: 'A real terminal, and real SSH',
    body: 'Not a simulated shell. A pty in a container, SSH to hosts you add with pinned fingerprints, and every command that changes anything asks you first.',
  },
  {
    icon: Puzzle,
    title: 'Tools that are actually connected',
    body: 'MCP servers with per-tool switches and a re-consent prompt if a tool changes under you. Qur’an grounding through quran.com is on by default.',
  },
  {
    icon: Server,
    title: 'Files, code and a sandbox',
    body: 'Write files, edit them, run JavaScript in an isolated interpreter with no network, and preview a page you just built without leaving the conversation.',
  },
];

const FAQ = [
  {
    q: 'What does “bring your own key” mean?',
    a: 'You open an account with a model provider, paste its key into settings once, and the workspace talks to models using it. You pay that provider directly for what you use — often nothing, since many of them offer free models. We never see the bill and never hold a card. Settings tells you which providers work and where to get a key.',
  },
  {
    q: 'What is the difference on Pro, then?',
    a: 'There is no key to obtain and no second account to top up. You send messages and the models are included, up to a monthly allowance shown on your plan page. Everything else is the same.',
  },
  {
    q: 'What happens when the trial ends, or if I cancel?',
    a: 'You move to the free plan and keep every conversation, file and setting. Add your own key and carry on where you were.',
  },
  {
    q: 'Is my work private?',
    a: 'Your conversations, files and secrets are yours alone, and an API key you save is encrypted with your own account bound into the encryption, so it cannot be read under anyone else’s. Nothing you write is used to train anything.',
  },
];

export function Landing({ config, plans }: { config: PublicAuthConfig; plans: Plan[] }) {
  const start = config.signUpOpen ? '/sign-up' : '/sign-in';
  return (
    <div className="landing">
      <a href="#content" className="landing-skip">
        Skip to content
      </a>
      <header className="landing-bar">
        <span className="landing-logo">
          <HikmahIcon name="orbit" size={28} />
          Hikmah
        </span>
        <nav>
          <a href="#pricing">Pricing</a>
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </header>

      <section className="landing-hero" id="content" tabIndex={-1}>
        <p className="landing-eyebrow">YOUR SPACE TO THINK &amp; CREATE</p>
        <h1>
          A workspace that keeps
          <br />
          working when you look away.
        </h1>
        <p className="landing-lede">
          Chat, code, a terminal and your own tools in one place. Runs happen on the server, so an
          answer is not something you have to sit and watch.
        </p>
        <div className="landing-cta">
          <Link href={start} className="landing-primary">
            {config.signUpOpen ? 'Start free' : 'Sign in'}
            <ArrowRight size={18} aria-hidden />
          </Link>
          <a href="#pricing" className="landing-secondary">
            See the plans
          </a>
        </div>
        {config.signUpOpen && (
          <p className="landing-fineprint">
            Free with your own model key. No card, and nothing to cancel.
          </p>
        )}
        <p className="landing-providers">
          Works with OpenRouter’s free models, OpenAI, Anthropic, Kimi, Gemini, DeepSeek, Ollama and
          any OpenAI-compatible server — with the price of each model in view.
        </p>
      </section>

      <section className="landing-grid" aria-label="For everyday work">
        {EVERYDAY.map(({ icon: Icon, title, body }) => (
          <article key={title}>
            <Icon size={20} aria-hidden />
            <h2>{title}</h2>
            <p>{body}</p>
          </article>
        ))}
      </section>

      <h2 className="landing-section-title">And for the builders.</h2>
      <section className="landing-grid" aria-label="For developers">
        {CAPABILITIES.map(({ icon: Icon, title, body }) => (
          <article key={title}>
            <Icon size={20} aria-hidden />
            <h2>{title}</h2>
            <p>{body}</p>
          </article>
        ))}
      </section>

      <section className="landing-pricing" id="pricing">
        <h2>Two ways to pay for the models.</h2>
        <p className="landing-lede">
          The workspace is the same on both. The only question is whose key the models run on.
        </p>
        {/* From the same catalogue the checkout and the entitlement check read,
            so this table cannot advertise something the app will not honour. */}
        <div className="landing-plans">
          {plans.map((plan) => (
            <article key={plan.id} className={plan.tier === 'managed' ? 'is-featured' : undefined}>
              <h3>{plan.name}</h3>
              {/* A card that named no amount at all was the loudest thing a
                  public audit found: the page asks whose key the models run on
                  and then would not say what the answer costs. */}
              <p className="landing-price">
                {priceLabelFor(plan) || (
                  <span className="landing-price-tbd">Price at checkout</span>
                )}
              </p>
              {plan.priceNote && <p className="landing-pricenote">{plan.priceNote}</p>}
              <p className="landing-tagline">{plan.tagline}</p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={15} aria-hidden />
                    {feature}
                  </li>
                ))}
              </ul>
              <Link
                href={start}
                className={plan.tier === 'managed' ? 'landing-primary' : undefined}
              >
                {plan.trialDays ? `Start ${plan.trialDays} days free` : 'Start free'}
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-faq" aria-label="Questions">
        <h2>Before you sign up.</h2>
        <dl>
          {FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="landing-foot">
        <span className="landing-logo">
          <HikmahIcon name="orbit" size={20} />
          Hikmah
        </span>
        <nav>
          <Link href="/sign-in">Sign in</Link>
          {config.signUpOpen && <Link href="/sign-up">Create an account</Link>}
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </footer>
    </div>
  );
}
