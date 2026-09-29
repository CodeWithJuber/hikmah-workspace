/** The two pages a stranger looks for before trusting a workspace with their
 * work: what is kept, and on what terms.
 *
 * Keep the description of learning aligned with its separate controls for
 * interaction capture, reviewed-example reuse and local syntax training.
 *
 * Everything stated here is read off what this codebase actually does. Where a
 * fact belongs to the operator rather than the code — who they are, where they
 * are, how long they keep things — the page says the operator sets it and
 * prints the contact address the deployment was configured with, rather than
 * inventing one.
 */
import Link from 'next/link';
import { HikmahIcon } from '@/components/kernel/icons';
import { contactAddress } from '@/lib/marketing/contact';

function Contact() {
  const address = contactAddress();
  return (
    <p>
      {address ? (
        <>
          Questions, or a request about your own data: <a href={`mailto:${address}`}>{address}</a>.
        </>
      ) : (
        <>
          Questions, or a request about your own data, go to the person who runs this deployment.
          Their address is on the workspace they gave you access with.
        </>
      )}
    </p>
  );
}

export function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="landing">
      <a href="#content" className="landing-skip">
        Skip to content
      </a>
      <header className="landing-bar">
        <Link href="/" className="landing-logo">
          <HikmahIcon name="orbit" size={32} />
          Hikmah
        </Link>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </header>
      <main className="landing-legal" id="content" tabIndex={-1}>
        <h1>{title}</h1>
        {children}
        <h2>Getting in touch</h2>
        <Contact />
      </main>
      <footer className="landing-foot">
        <span className="landing-logo">
          <HikmahIcon name="orbit" size={20} />
          Hikmah
        </span>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </footer>
    </div>
  );
}

export function PrivacyBody() {
  return (
    <>
      <p className="landing-lede">
        What this workspace keeps, where it goes, and how you control its use.
      </p>

      <h2>What is stored</h2>
      <ul>
        <li>
          <strong>Your account.</strong> The email address you signed up with, a name if you gave
          one, and a hash of your password. Never the password itself.
        </li>
        <li>
          <strong>Your work.</strong> Conversations and their messages, the files your workspace
          holds, the notes you keep in Memory, and the settings you choose.
        </li>
        <li>
          <strong>Learning examples, if you enable capture.</strong> Completed model requests and
          responses can be saved for your review with their source conversation and model details.
          Syntax-example collection has its own setting. Both collection settings are off by
          default.
        </li>
        <li>
          <strong>Your provider keys.</strong> Encrypted before they are written, with your own
          account bound into the encryption, so a key saved under your account cannot be read under
          anyone else&rsquo;s.
        </li>
        <li>
          <strong>What runs cost.</strong> Token counts per run, which is what an allowance is
          measured against.
        </li>
        <li>
          <strong>How fast the pages were.</strong> Five standard timing measurements taken by your
          own browser — how long the main content took to appear, how quickly the page answered a
          tap, how much it moved while loading — with the page they came from, and whether the
          window was narrow. No address, no browser name, no session. They are kept here, in the
          same database as everything else, and they are how a slow page gets noticed without
          somebody having to report it.
        </li>
      </ul>

      <h2>Who else sees it</h2>
      <ul>
        <li>
          <strong>The model provider you choose.</strong> Your request and any selected context,
          including memories or approved examples used in the request, are sent to the provider set
          in your Connection settings, under that provider&rsquo;s own terms. Choosing the provider
          is choosing who sees that context.
        </li>
        <li>
          <strong>Stripe</strong>, if you subscribe to a paid plan. Card details go to Stripe and
          are never held here.
        </li>
        <li>
          <strong>An email provider</strong>, for the confirmation and password-reset messages, when
          the deployment is configured to send them.
        </li>
        <li>
          <strong>Nobody else.</strong> Your work is not sold, and it is not shared for advertising.
          There is no analytics company here: the timing measurements above are sent to this
          deployment and nowhere else, which is why they are five numbers rather than a profile.
        </li>
      </ul>

      <h2>Learning and training</h2>
      <p>
        Interaction capture is off by default. If you enable it, captured examples wait for your
        review. Approved examples can guide later responses when example reuse is enabled; this does
        not change a provider model&rsquo;s weights. Turning capture off stops new collection;
        example reuse is a separate control.
      </p>
      <p>
        Collecting syntax examples is a separate opt-in. Training the local syntax co-model requires
        reviewed annotations and an explicit training action. It changes that local model, not the
        external provider&rsquo;s model. Provider handling of requests remains subject to that
        provider&rsquo;s own terms.
      </p>
      <p>
        Web search runs through this deployment&rsquo;s own search service rather than sending your
        query to a search company under your name.
      </p>

      <h2>Your control</h2>
      <p>
        You can read, edit and delete your conversations, files and memories from inside the
        workspace at any time, and remove a saved provider key from Settings. Deleting a
        conversation removes its messages. Learning settings let you review or delete captured
        examples and control capture and example reuse separately. To have an account and everything
        under it removed, ask below.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Your conversations, files and memories are kept until you delete them or ask for the account
        to be removed. Captured learning examples have their own retention setting. Backups of the
        whole deployment are kept for a short window so a failure can be recovered from, and roll
        off after that. The operator of this deployment sets the exact window.
      </p>

      <h2>Changes</h2>
      <p>
        What applies is the version of this page published here. If it changes, the new version
        takes effect when published — check back if it matters to you.
      </p>
    </>
  );
}

export function TermsBody() {
  return (
    <>
      <p className="landing-lede">
        The short version of what you agree to by using this workspace.
      </p>

      <h2>The account</h2>
      <p>
        One account is one person. Keep your password to yourself; anything done through your
        account is treated as done by you. You must be old enough to enter a contract where you
        live.
      </p>

      <h2>What you may do with it</h2>
      <p>
        Use it for your own work, personal or commercial. What you write and what the models write
        back for you is yours. No claim is made over it.
      </p>

      <h2>What you may not do</h2>
      <ul>
        <li>Break the law with it, or use it to harm or harass someone.</li>
        <li>
          Attack the service: no attempt to reach another person&rsquo;s workspace, no probing for
          holes without permission, no load meant to take it down.
        </li>
        <li>Resell access, or run it as a proxy for people who have no account here.</li>
        <li>Work around an allowance, a rate limit, or a payment.</li>
      </ul>

      <h2>Models, and what they say</h2>
      <p>
        The models are third-party services, and their answers can be wrong. Check anything that
        matters before you rely on it — particularly anything religious, legal, medical or
        financial. Which models are reachable depends on the provider and the key in use, and can
        change without notice when a provider changes theirs.
      </p>

      <h2>Paying</h2>
      <p>
        The free plan runs on your own provider key and costs nothing here; you pay your provider
        directly. A paid plan runs on this deployment&rsquo;s key against a monthly allowance, is
        billed through Stripe, and can be cancelled at any time — access then runs to the end of the
        period already paid for. Prices are shown before you are charged.
      </p>

      <h2>Ending it</h2>
      <p>
        You can stop using the service and ask for your account to be removed at any time. An
        account may be suspended for the things listed above under what you may not do.
      </p>

      <h2>No warranty</h2>
      <p>
        The service is provided as it is, without a guarantee that it will always be available or
        always correct. Keep your own copy of anything you cannot afford to lose.
      </p>
    </>
  );
}
