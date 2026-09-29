'use client';

/** The disagreement banner: when the run's own research found sources that
 * disagree, the disagreement is shown explicitly — both sides, in the lanes'
 * words — instead of the answer silently cherry-picking one side. Rendered
 * only from admitted `data-disagreement` parts (see lib/chat/verifiability.ts);
 * a malformed record never reaches this component.
 */
import type { SourceDisagreement } from '@/lib/chat/verifiability';

function partyLabel(party: { source: string; title?: string }): string {
  if (party.title) return party.title;
  try {
    return new URL(party.source).hostname.replace(/^www\./, '');
  } catch {
    return party.source;
  }
}

export function DisagreementBanner({ disagreements }: { disagreements: SourceDisagreement[] }) {
  if (disagreements.length === 0) return null;
  return (
    <div className="chat-disagreement" role="note" aria-label="Sources disagree">
      <p className="chat-disagreement-title">Sources disagree</p>
      {disagreements.map((disagreement, index) => (
        <div key={index} className="chat-disagreement-item">
          <p className="chat-disagreement-claim">{disagreement.claim}</p>
          <ul className="chat-disagreement-parties">
            {disagreement.parties.map((party, partyIndex) => (
              <li key={partyIndex}>
                <span className="chat-disagreement-source">{partyLabel(party)}</span>
                <span className="chat-disagreement-says">{party.says}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
