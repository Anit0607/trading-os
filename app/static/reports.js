import { safeJson } from "./api.js";
import {
  compactDateTime,
  compactList,
  compactValue,
  escapeHtml,
  formatAgeSeconds,
  formatDateTime,
  formatInr,
  formatPct,
  formatPrice,
  formatQty,
  formatSignedInr,
  qs,
  qsa,
  setText,
} from "./formatters.js";

let auditState = {};
let auditRefreshInFlight = false;

function auditTone(levelOrStatus) {
  const value = String(levelOrStatus || "").toLowerCase();
  if (["ok", "safe", "complete", "completed", "delivered", "filled", "ready", "fresh", "installed", "enabled"].includes(value)) return "ok";
  if (["warning", "warn", "partial_coverage", "blocked", "skipped", "risk off", "stale", "running"].includes(value)) return "warn";
  if (["failed", "critical", "error", "missing"].includes(value)) return "danger";
  return "muted";
}

function renderReportShelf(report = auditState) {
  const target = qs("#reportShelf");
  if (!target) return;
  const summary = report.summary || {};
  const broker = report.broker || {};
  const brokerCache = broker.cache || {};
  const tasks = report.tasks || {};
  const taskRows = Array.isArray(tasks.tasks) ? tasks.tasks : [];
  const scannerCoverage = Number(summary.scanner_coverage || 0);
  const scannerFailures = Number(summary.scanner_failure_count || 0);
  const installedTasks = Number(summary.task_installed_count ?? tasks.installed_count ?? 0);
  const expectedTasks = Number(summary.task_expected_count ?? tasks.expected_count ?? 0);
  const nextTask = taskRows.find((row) => row.next_run_time) || {};
  const brokerOk = Boolean(broker.ok || summary.broker_snapshot_ok);
  const orderPlacement = compactValue(broker.order_placement || broker.orderPlacement || "blocked");
  const readOnlyOk = orderPlacement.toLowerCase() === "blocked" || broker.read_only_guard === "enabled";
  const timelineCount = Array.isArray(report.timeline) ? report.timeline.length : 0;
  const notificationCount = Number(summary.notifications_delivered || 0) + Number(summary.notifications_failed || 0) + Number(summary.notifications_skipped || 0);
  const cards = [
    {
      tone: report.generated_at ? "ok" : "warn",
      label: "Audit Packet",
      value: report.generated_at ? compactDateTime(report.generated_at) : "LOADING",
      detail: `${timelineCount} timeline rows · ${notificationCount} alert records`,
    },
    {
      tone: scannerCoverage >= 0.95 && scannerFailures === 0 ? "ok" : "warn",
      label: "Scanner Quality",
      value: summary.scanner_run_id ? `Run #${summary.scanner_run_id}` : compactValue(summary.scanner_status, "NO RUN"),
      detail: `${scannerCoverage ? formatPct(scannerCoverage, 2) : "--"} coverage · ${scannerFailures} failures`,
    },
    {
      tone: brokerOk && readOnlyOk ? "ok" : brokerOk ? "warn" : "danger",
      label: "Dhan Read-Only",
      value: readOnlyOk ? "ORDERS BLOCKED" : orderPlacement.toUpperCase(),
      detail: `${compactValue(summary.broker_snapshot_status || brokerCache.status, "cache")} · ${brokerCache.age_seconds !== undefined ? formatAgeSeconds(brokerCache.age_seconds) : "age --"}`,
    },
    {
      tone: expectedTasks && installedTasks >= expectedTasks ? "ok" : "warn",
      label: "Schedulers",
      value: expectedTasks ? `${installedTasks}/${expectedTasks} installed` : `${installedTasks} installed`,
      detail: nextTask.name ? `${nextTask.name}: ${nextTask.next_run_time || "--"}` : "No next task time found",
    },
  ];
  target.innerHTML = cards
    .map(
      (card) => `
        <article class="report-card ${card.tone}">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <small>${escapeHtml(card.detail)}</small>
        </article>
      `,
    )
    .join("");
}

function renderAuditStats(report = auditState) {
  const summary = report.summary || {};
  const stats = qsa("#auditStats .audit-stat");
  const scannerStatus = compactValue(summary.scanner_status, "unknown");
  const rebalanceReason = compactValue(summary.rebalance_reason, "No rebalance status");
  const rebalanceDone = summary.rebalance_last_completed_month || rebalanceReason.toLowerCase().includes("completed");
  const failedAlerts = Number(summary.notifications_failed || 0);
  const skippedAlerts = Number(summary.notifications_skipped || 0);
  const values = [
    {
      tone: auditTone(scannerStatus),
      strong: summary.scanner_run_id ? `#${summary.scanner_run_id}` : scannerStatus.toUpperCase(),
      small: `${scannerStatus} / ${summary.scanner_coverage ? formatPct(summary.scanner_coverage, 2) : "--"}`,
    },
    {
      tone: rebalanceDone ? "ok" : summary.rebalance_allowed ? "ok" : "warn",
      strong: rebalanceDone ? "DONE" : summary.rebalance_allowed ? "OPEN" : "BLOCKED",
      small: rebalanceReason,
    },
    {
      tone: Number(summary.paper_total_pnl_pct || 0) >= 0 ? "ok" : "warn",
      strong: summary.paper_equity ? formatInr(summary.paper_equity) : "--",
      small: summary.paper_total_pnl_pct !== undefined ? formatPct(summary.paper_total_pnl_pct, 2, true) : "Paper portfolio",
    },
    {
      tone: Number(summary.paper_drawdown || 0) > 0.15 ? "danger" : Number(summary.paper_drawdown || 0) > 0.07 ? "warn" : "ok",
      strong: summary.paper_drawdown !== undefined ? formatPct(summary.paper_drawdown, 2) : "--",
      small: compactValue(summary.pdd_state, "PDD state"),
    },
    {
      tone: failedAlerts ? "danger" : skippedAlerts ? "warn" : "ok",
      strong: `${Number(summary.notifications_delivered || 0)} ok`,
      small: `${failedAlerts} failed / ${skippedAlerts} skipped`,
    },
  ];
  values.forEach((item, index) => {
    const stat = stats[index];
    if (!stat) return;
    stat.className = `audit-stat ${item.tone}`;
    setText("strong", item.strong, stat);
    setText("small", item.small, stat);
  });
}

export function auditKvRows(rows = []) {
  return rows
    .map(
      (row) => `
        <div class="audit-kv-row ${row.tone || "info"}">
          <span>${escapeHtml(row.label)}</span>
          <strong>${escapeHtml(row.value ?? "--")}</strong>
        </div>
      `,
    )
    .join("");
}

function renderAuditDetails(report = auditState) {
  const summary = report.summary || {};
  const scanner = report.scanner || {};
  const paper = report.paper || {};
  const portfolio = paper.portfolio || {};
  const pdd = paper.pdd || {};
  const regime = paper.regime || scanner.regime || {};
  const plan = paper.plan || {};
  const rebalance = paper.rebalance_status || {};
  const generated = qs("#auditGeneratedAt");
  if (generated) {
    generated.textContent = report.generated_at ? compactDateTime(report.generated_at) : "LOADING";
    generated.className = "safe-lock ok";
  }
  const regimePill = qs("#auditRegimePill");
  if (regimePill) {
    regimePill.textContent = compactValue(regime.state || summary.market_regime, "REGIME").toUpperCase();
    regimePill.className = `safe-lock ${auditTone(regime.state || summary.market_regime)}`;
  }
  const pddPill = qs("#auditPddPill");
  if (pddPill) {
    pddPill.textContent = compactValue(pdd.state || summary.pdd_state, "PDD").toUpperCase();
    pddPill.className = `safe-lock ${pdd.stress ? "warn" : "ok"}`;
  }
  const deliveryPill = qs("#auditDeliveryPill");
  if (deliveryPill) {
    const failed = Number(summary.notifications_failed || 0);
    deliveryPill.textContent = failed ? "CHECK ALERTS" : "DELIVERY OK";
    deliveryPill.className = `safe-lock ${failed ? "danger" : "ok"}`;
  }

  qs("#auditStrategyDetails").innerHTML = auditKvRows([
    { label: "Scanner status", value: summary.scanner_status, tone: auditTone(summary.scanner_status) },
    { label: "Run / month", value: `#${summary.scanner_run_id || "--"} / ${summary.scanner_as_of_month || "--"}`, tone: "info" },
    { label: "Coverage", value: summary.scanner_coverage !== undefined ? formatPct(summary.scanner_coverage, 2) : "--", tone: Number(summary.scanner_coverage || 0) > 0.95 ? "ok" : "warn" },
    { label: "Failures", value: summary.scanner_failure_count ?? "--", tone: Number(summary.scanner_failure_count || 0) ? "warn" : "ok" },
    { label: "Target symbols", value: compactList(summary.target_symbols || []), tone: "info" },
    { label: "Retain symbols", value: compactList(summary.retain_symbols || []), tone: "info" },
    { label: "Regime reason", value: regime.reason || "--", tone: regime.risk_on ? "ok" : "warn" },
  ]);
  renderAuditRanks(scanner.top_ranks || []);

  qs("#auditPortfolioDetails").innerHTML = auditKvRows([
    { label: "Equity", value: portfolio.equity ? formatInr(portfolio.equity) : "--", tone: "info" },
    { label: "Market value", value: portfolio.market_value ? formatInr(portfolio.market_value) : "--", tone: "info" },
    { label: "Total P&L", value: portfolio.total_pnl !== undefined ? `${formatSignedInr(portfolio.total_pnl)} (${formatPct(portfolio.total_pnl_pct, 2, true)})` : "--", tone: Number(portfolio.total_pnl || 0) >= 0 ? "ok" : "warn" },
    { label: "Current drawdown", value: portfolio.current_drawdown !== undefined ? formatPct(portfolio.current_drawdown, 2) : "--", tone: Number(portfolio.current_drawdown || 0) > 0.15 ? "danger" : "warn" },
    { label: "Holdings", value: portfolio.holding_count ?? "--", tone: "info" },
    { label: "Rebalance gate", value: rebalance.reason || "--", tone: rebalance.allowed ? "ok" : "warn" },
    { label: "Planned orders", value: `${(plan.orders || []).length} current / ${summary.paper_order_count || 0} historical`, tone: "info" },
  ]);
  renderAuditOrders(paper.orders || []);
  renderAuditEvents(report.events || []);
  renderAuditNotifications(report.notifications || []);
  renderAuditTimeline(report.timeline || []);
}

function renderAuditRanks(rows = []) {
  const target = qs("#auditRankRows");
  if (!target) return;
  const visible = rows.slice(0, 10);
  target.innerHTML = `
    <h4>Top ROC Evidence</h4>
    ${visible.length ? visible
      .map(
        (row) => `
          <div class="audit-table-row">
            <span>#${escapeHtml(row.rank)}</span>
            <strong>${escapeHtml(row.symbol)}</strong>
            <em>${formatPct(row.roc_12, 2)}</em>
          </div>
        `,
      )
      .join("") : `<div class="audit-empty">No rank rows available.</div>`}
  `;
}

function renderAuditOrders(rows = []) {
  const target = qs("#auditOrderRows");
  if (!target) return;
  const visible = rows.slice(0, 8);
  target.innerHTML = `
    <h4>Recent Paper Orders</h4>
    ${visible.length ? visible
      .map(
        (row) => `
          <div class="audit-table-row">
            <span>${escapeHtml(row.action || "--")}</span>
            <strong>${escapeHtml(row.symbol || "--")}</strong>
            <em>${formatQty(row.quantity)} @ ${formatPrice(row.price)}</em>
          </div>
        `,
      )
      .join("") : `<div class="audit-empty">No paper orders recorded yet.</div>`}
  `;
}

function renderAuditEvents(rows = []) {
  const target = qs("#auditEventRows");
  if (!target) return;
  const visible = rows.slice(0, 7);
  target.innerHTML = `
    <h4>Latest Events</h4>
    ${visible.length ? visible
      .map(
        (row) => `
          <div class="audit-log-row ${auditTone(row.level)}">
            <strong>${escapeHtml(row.event_type || "--")}</strong>
            <span>${escapeHtml(row.message || "--")}</span>
            <em>${formatDateTime(row.created_at)}</em>
          </div>
        `,
      )
      .join("") : `<div class="audit-empty">No event rows available.</div>`}
  `;
}

function renderAuditNotifications(rows = []) {
  const target = qs("#auditNotificationRows");
  if (!target) return;
  const visible = rows.slice(0, 7);
  target.innerHTML = `
    <h4>Alert Delivery</h4>
    ${visible.length ? visible
      .map(
        (row) => `
          <div class="audit-log-row ${auditTone(row.status || row.level)}">
            <strong>${escapeHtml(String(row.channel || "").toUpperCase())} / ${escapeHtml(row.status || "--")}</strong>
            <span>${escapeHtml(row.title || row.message || "--")}</span>
            <em>${formatDateTime(row.created_at)}</em>
          </div>
        `,
      )
      .join("") : `<div class="audit-empty">No notification rows available.</div>`}
  `;
}

function renderAuditTimeline(rows = []) {
  const target = qs("#auditTimelineRows");
  if (!target) return;
  const visible = rows.slice(0, 30);
  if (!visible.length) {
    target.innerHTML = `<div class="audit-empty">No audit timeline available yet.</div>`;
    return;
  }
  target.innerHTML = visible
    .map(
      (row) => `
        <article class="audit-timeline-item ${auditTone(row.level)}">
          <span></span>
          <div>
            <strong>${escapeHtml(row.title || row.source || "--")}</strong>
            <p>${escapeHtml(row.message || "")}</p>
            <small>${escapeHtml(row.source || "audit")} · ${formatDateTime(row.created_at)}</small>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderAuditReport(report = {}) {
  auditState = report;
  renderReportShelf(report);
  renderAuditStats(report);
  renderAuditDetails(report);
}

function renderAuditError(error) {
  const target = qs("#auditTimelineRows");
  if (!target) return;
  target.innerHTML = `
    <div class="audit-empty error">
      <strong>Audit report unavailable.</strong>
      <span>${escapeHtml(error.message || "Unable to load audit data.")}</span>
    </div>
  `;
  const shelf = qs("#reportShelf");
  if (shelf) {
    shelf.innerHTML = `
      <article class="report-card danger">
        <span>Report Runtime</span>
        <strong>UNAVAILABLE</strong>
        <small>${escapeHtml(error.message || "Unable to load audit data.")}</small>
      </article>
    `;
  }
}

export async function refreshAudit() {
  if (auditRefreshInFlight) return auditState;
  auditRefreshInFlight = true;
  const button = qs("#refreshAuditData");
  const originalText = button?.textContent || "Refresh Reports";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  try {
    const report = await safeJson("/api/audit?limit=80");
    renderAuditReport(report);
    return report;
  } catch (error) {
    console.error(error);
    renderAuditError(error);
    return auditState;
  } finally {
    auditRefreshInFlight = false;
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function downloadAuditJson() {
  if (!auditState || !Object.keys(auditState).length) return;
  const blob = new Blob([JSON.stringify(auditState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "");
  link.href = url;
  link.download = `trading-os-audit-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function setupAuditActions() {
  qs("#refreshAuditData")?.addEventListener("click", () => refreshAudit());
  qs("#downloadAuditJson")?.addEventListener("click", downloadAuditJson);
}
