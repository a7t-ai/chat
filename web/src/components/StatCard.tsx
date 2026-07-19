// A single telemetry stat — a big value over a small uppercase label. Used by the Telemetry panel
// (StatsPanel) and demoed in the design-system gallery. Lay several out in a `.stat-cards` grid.
export function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
