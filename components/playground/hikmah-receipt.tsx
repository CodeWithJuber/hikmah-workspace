'use client';
import { HikmahIcon } from '@/components/kernel/icons';
import type { ChatEntry } from '@/lib/playground/session';
export function HikmahReceipt({ message: m }: { message: ChatEntry }) {
  if (!m.execution) return null;
  const tools = m.trace?.filter((t) => !t.name.startsWith('kernel_')) ?? [];
  const good = tools.filter((t) => t.status === 'success');
  const reviews = m.execution.stages.filter((s) => s.name === 'Review' && s.status === 'complete');
  const c = m.execution.contribution;
  return (
    <details className="hikmah-receipt">
      <summary>
        <HikmahIcon name="orbit" size={16} />
        <strong>Hikmah contribution</strong>
        <span>
          {good.length} actions · {m.memoryUsed?.length ?? 0} memories
          {reviews.length ? ' · reviewed' : ''}
        </span>
      </summary>
      <div className="receipt-grid">
        <div>
          <strong>Agent</strong>
          <span>{c?.agentName ?? 'General assistant'}</span>
        </div>
        <div>
          <strong>Memory</strong>
          <span>
            {c?.memory === false
              ? 'Off for this agent'
              : m.memoryUsed?.length
                ? m.memoryUsed.map((x) => x.title).join(', ')
                : 'No matching saved items used'}
          </span>
        </div>
        <div>
          <strong>Local context model</strong>
          <span>
            {c?.context === 'used'
              ? 'Context interpretation added to the request'
              : c?.context === 'unavailable'
                ? 'Could not load; original messages retained'
                : 'Not used for this request'}
          </span>
        </div>
        <div>
          <strong>Tools</strong>
          <span>
            {good.length
              ? good.map((t) => t.name.replaceAll('_', ' ')).join(', ')
              : 'No successful tool actions'}
            {tools.length > good.length ? ' · ' + (tools.length - good.length) + ' failed' : ''}
          </span>
        </div>
        <div>
          <strong>Draft review</strong>
          <span>{reviews.length ? 'Provider review completed' : 'No completed review'}</span>
        </div>
        <div>
          <strong>Instructions</strong>
          <span>{c?.skills.length ? c.skills.join(', ') : 'Hikmah operating principles'}</span>
        </div>
      </div>
      <p>
        These are recorded actions, not a measured improvement score. Compare can help you judge
        whether this workflow improved your result.
      </p>
    </details>
  );
}
