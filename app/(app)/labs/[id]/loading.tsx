/** Loading state for /labs/[id] — mirrors the lab detail shell: the header
 * with its back affordance, then the lab body's skeleton. */
export default function LabDetailLoading() {
  return (
    <div className="n-page" aria-label="Loading lab">
      <header className="n-header">
        <span className="n-icon-btn n-shimmer" aria-hidden="true" />
        <span className="n-shimmer-line" style={{ width: '35%', height: 28 }} aria-hidden="true" />
        <div className="n-header-actions" aria-hidden="true" />
      </header>
      <div role="status" style={{ padding: '0 var(--space-page-x)', display: 'grid', gap: 12 }}>
        <span className="n-shimmer-line" style={{ width: '70%' }} />
        <span className="n-shimmer-line" style={{ width: '100%', height: 120 }} />
        <span className="n-shimmer-line" style={{ width: '85%' }} />
      </div>
    </div>
  );
}
