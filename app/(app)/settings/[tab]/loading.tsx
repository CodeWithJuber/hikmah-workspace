/** Loading state for /settings/[tab] — mirrors the settings shell: the
 * header, the chip tab row, and the tab body's skeleton. */
export default function AdminTabLoading() {
  return (
    <div className="n-page" aria-label="Loading settings">
      <header className="n-header">
        <span className="n-shimmer-line" style={{ width: '45%', height: 28 }} aria-hidden="true" />
        <div className="n-header-actions" aria-hidden="true" />
      </header>
      <div className="n-chip-row" aria-hidden="true" style={{ marginTop: 12 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <span key={i} className="n-chip n-shimmer" style={{ width: 96, border: 0 }} />
        ))}
      </div>
      <div role="status" style={{ padding: '12px var(--space-page-x)', display: 'grid', gap: 12 }}>
        <span className="n-shimmer-line" style={{ width: '40%' }} />
        <span className="n-shimmer-line" style={{ width: '70%' }} />
        <span className="n-shimmer-line" style={{ width: '100%', height: 96 }} />
        <span className="n-shimmer-line" style={{ width: '100%', height: 64 }} />
      </div>
    </div>
  );
}
