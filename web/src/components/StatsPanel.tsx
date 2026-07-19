import { useEffect, useState } from "react";
import { fetchStats, type Stats } from "../lib/admin";
import { isNetworkError } from "../lib/errors";
import { useT } from "../lib/i18n";
import { Button, InlineMessage, Modal, SectionHeading } from "./ui";
import { StatCard } from "./StatCard";

export function StatsPanel({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setStats(await fetchStats());
    } catch (e) {
      // Never leak a raw "/api/admin/stats -> 500" / "Failed to fetch" string (#42): tell the
      // admin whether the box was unreachable or the load itself failed, and what to do next.
      setError(isNetworkError(e) ? t("error.network") : t("stats.loadError"));
    }
  }
  useEffect(() => {
    load();
  }, []);

  const jano = stats?.backend.jano ?? null;

  return (
    <Modal
      bare={embedded}
      title={t("nav.telemetry")}
      onClose={onClose}
      closeLabel={t("common.close")}
      headerActions={
        <Button variant="ghost" size="sm" onClick={load}>
          {t("common.refresh")}
        </Button>
      }
    >
      {embedded && (
        <div className="embedded-head-actions">
          <Button variant="ghost" size="sm" onClick={load}>
            {t("common.refresh")}
          </Button>
        </div>
      )}
      {error && <InlineMessage variant="danger" role="alert">{error}</InlineMessage>}
        {!stats ? (
          <p className="muted">{t("common.loading")}</p>
        ) : (
          <>
            <div className="stat-cards">
              <StatCard label={t("stats.users")} value={stats.totals.users} />
              <StatCard label={t("stats.conversations")} value={stats.totals.conversations} />
              <StatCard label={t("stats.messages")} value={stats.totals.messages} />
              <StatCard label={t("stats.activeKeys")} value={stats.totals.activeKeys} />
              <StatCard label={t("stats.requests")} value={stats.totals.requests} />
              <StatCard label={t("stats.tokensInOut")} value={`${stats.totals.tokensIn} / ${stats.totals.tokensOut}`} />
            </div>

            <SectionHeading>{t("stats.janoRouter")}</SectionHeading>
            {jano ? (
              <div className="stat-cards">
                <StatCard label={t("stats.currentModel")} value={jano.currentModel ?? t("common.dash")} />
                <StatCard label={t("stats.queueDepth")} value={jano.queueDepth ?? 0} />
                <StatCard label={t("stats.inFlight")} value={jano.inFlight ?? 0} />
                <StatCard label={t("stats.swaps")} value={`${jano.swapsLast15m ?? 0} / ${jano.swapsLastHour ?? 0}`} />
                <StatCard label={t("stats.genTokS")} value={Math.round(jano.recentGenTokS ?? 0)} />
                <StatCard label={t("stats.errors15m")} value={jano.errorsLast15m ?? 0} />
              </div>
            ) : (
              <p className="muted small">{t("stats.janoUnreachable")}</p>
            )}
            {jano?.backendHealth && (
              <p className="muted small">
                {t("stats.backends")}{" "}
                {Object.entries(jano.backendHealth)
                  .map(([m, s]) => `${m}=${s}`)
                  .join("  ·  ")}
              </p>
            )}

            <SectionHeading>{t("stats.last24h")}</SectionHeading>
            <div className="stat-cards">
              <StatCard label={t("stats.requests")} value={stats.last24h.requests} />
              <StatCard label={t("stats.tokensIn")} value={stats.last24h.tokensIn} />
              <StatCard label={t("stats.tokensOut")} value={stats.last24h.tokensOut} />
            </div>

            <SectionHeading>{t("stats.byModel")}</SectionHeading>
            <table className="keys-table">
              <thead>
                <tr>
                  <th>{t("stats.model")}</th>
                  <th>{t("stats.requests")}</th>
                  <th>{t("stats.tokensIn")}</th>
                  <th>{t("stats.tokensOut")}</th>
                </tr>
              </thead>
              <tbody>
                {stats.byModel.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td>{m.requests}</td>
                    <td>{m.tokensIn}</td>
                    <td>{m.tokensOut}</td>
                  </tr>
                ))}
                {stats.byModel.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {t("stats.noUsage")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <SectionHeading>{t("stats.backendModels")}</SectionHeading>
            <p className="muted small">{stats.backend.models.join(", ") || t("common.dash")}</p>
          </>
        )}
    </Modal>
  );
}
