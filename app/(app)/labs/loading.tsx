/** Loading state for /labs — mirrors the labs list layout with the native
 * skeleton primitives: fixed boxes so nothing shifts when the cards land. */
export default function LabsLoading() {
  return (
    <div className="n-page" aria-label="Loading labs">
      <header className="n-header">
        <span className="n-shimmer-line" style={{ width: '40%', height: 28 }} aria-hidden="true" />
      </header>
      <div className="n-card-grid" role="status">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="n-card" aria-hidden="true">
            <span className="n-card-icon n-shimmer" />
            <span className="n-row-body" style={{ gap: 8 }}>
              <span className="n-shimmer-line" style={{ width: '55%' }} />
              <span className="n-shimmer-line" style={{ width: '90%' }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
