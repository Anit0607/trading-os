import { safeJson } from "./api.js";
import {
  compactList,
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
import { getCurrentView, setView } from "./navigation.js";
import { refreshOperations } from "./strategy.js";

let reconciliationState = {};
let reconciliationRefreshInFlight = false;

function reconciliationTone(ok, warn = false) {
  if (warn) return "warn";
  return ok ? "ok" : "danger";
}

function reconciliationStatusPill(selector, label, tone = "muted") {
  const pill = qs(selector);
  if (!pill) return;
  pill.textContent = String(label || "--").toUpperCase();
  pill.className = `safe-lock ${tone}`;
}

function renderReconciliationStats(data = reconciliationState) {
  const summary = data.summary || {};
  const dhan = data.dhan || {};
  const cache = dhan.cache || {};
  const stats = qsa("#reconciliationStats .reconciliation-stat");
  const gapCount = Number(summary.gap_count || 0);
  const values = [
    {
      tone: reconciliationTone(Boolean(dhan.ok), Boolean(cache.stale)),
      strong: cache.status === "fresh" ? "CACHED" : cache.status === "stale" ? "STALE" : dhan.ok ? "CONNECTED" : "CHECK",
      small: cache.generated_at ? `Age ${formatAgeSeconds(cache.age_seconds)} | ${dhan.message || "Dhan read-only"}` : dhan.message || dhan.error || "No broker cache",
    },
    {
      tone: Number(summary.paper_holding_count || 0) ? "ok" : "warn",
      strong: `${summary.paper_holding_count ?? 0} sleeve${Number(summary.paper_holding_count || 0) === 1 ? "" : "s"}`,
      small: summary.paper_equity ? `Equity ${formatInr(summary.paper_equity)}` : "No paper holdings",
    },
    {
      tone: summary.paper_matches_strategy ? "ok" : "warn",
      strong: `${summary.target_symbol_count ?? 0} target${Number(summary.target_symbol_count || 0) === 1 ? "" : "s"}`,
      small: summary.paper_targets_present ? "Paper target aligned" : "Paper target gap",
    },
    {
      tone: gapCount ? "warn" : "ok",
      strong: String(gapCount),
      small: summary.broker_matches_paper ? "Broker matches paper" : "Broker/paper mismatch",
    },
    {
      tone: data.read_only && data.live_order_placement === "blocked" ? "ok" : "danger",
      strong: data.read_only ? "READ ONLY" : "CHECK",
      small: `Orders ${data.live_order_placement || "blocked"}`,
    },
  ];

  values.forEach((item, index) => {
    const card = stats[index];
    if (!card) return;
    card.className = `reconciliation-stat ${item.tone}`;
    setText("strong", item.strong, card);
    setText("small", item.small, card);
  });
}

function reconciliationKvRows(rows = []) {
  return rows
    .map(
      (row) => `
        <div class="reconciliation-kv-row ${row.tone || "info"}">
          <span>${escapeHtml(row.label)}</span>
          <strong>${escapeHtml(row.value ?? "--")}</strong>
        </div>
      `,
    )
    .join("");
}

function renderReconciliationSymbolList(targetSelector, title, symbols = [], emptyText = "No symbols.") {
  const target = qs(targetSelector);
  if (!target) return;
  target.innerHTML = `
    <h4>${escapeHtml(title)}</h4>
    ${
      symbols.length
        ? symbols
            .map(
              (symbol) => `
                <div class="reconciliation-symbol-row">
                  <strong>${escapeHtml(symbol)}</strong>
                </div>
              `,
            )
            .join("")
        : `<div class="reconciliation-empty">${escapeHtml(emptyText)}</div>`
    }
  `;
}

function renderReconciliationHoldings(targetSelector, title, rows = [], emptyText = "No holdings available.") {
  const target = qs(targetSelector);
  if (!target) return;
  const isPaper = targetSelector === "#reconPaperHoldings";
  target.innerHTML = `
    <h4>${escapeHtml(title)}</h4>
    ${
      rows.length
        ? rows
            .map(
              (row) => {
                if (isPaper) {
                  const pnl = Number(row.pnl || 0);
                  return `
                    <div class="reconciliation-holding-row portfolio-holding-row ${row.symbol === "GOLDBEES" ? "gold-row" : ""}">
                      <strong>${escapeHtml(row.symbol || "--")}<small>${escapeHtml(row.role || `Sleeve ${row.sleeve ?? "--"}`)}</small></strong>
                      <span>Qty ${formatQty(row.quantity)}</span>
                      <span>Avg ${formatPrice(row.avg_price)}</span>
                      <span>LTP ${formatPrice(row.ltp)}</span>
                      <em>${row.value ? formatInr(row.value) : "--"}</em>
                      <em class="${pnl >= 0 ? "green" : "red"}">${formatSignedInr(pnl)} (${formatPct(row.pnl_pct, 2, true)})</em>
                    </div>
                  `;
                }
                return `
                  <div class="reconciliation-holding-row">
                    <strong>${escapeHtml(row.symbol || "--")}</strong>
                    <span>Qty ${formatQty(row.quantity)}</span>
                    <em>${row.value ? formatInr(row.value) : row.ltp ? `LTP ${formatPrice(row.ltp)}` : "--"}</em>
                  </div>
                `;
              },
            )
            .join("")
        : `<div class="reconciliation-empty">${escapeHtml(emptyText)}</div>`
    }
  `;
}

function renderReconciliationGaps(comparison = {}) {
  const target = qs("#reconGapRows");
  if (!target) return;
  const brokerVsPaper = comparison.broker_vs_paper || {};
  const brokerVsStrategy = comparison.broker_vs_strategy || {};
  const paperVsStrategy = comparison.paper_vs_strategy || {};
  const mismatches = comparison.quantity_mismatches || [];
  const rows = [
    { label: "Broker missing paper symbols", value: compactList(brokerVsPaper.missing_in_broker || []), tone: (brokerVsPaper.missing_in_broker || []).length ? "warn" : "ok" },
    { label: "Broker extra symbols", value: compactList(brokerVsPaper.extra_in_broker || []), tone: (brokerVsPaper.extra_in_broker || []).length ? "warn" : "ok" },
    { label: "Broker missing targets", value: compactList(brokerVsStrategy.missing_targets || []), tone: (brokerVsStrategy.missing_targets || []).length ? "warn" : "ok" },
    { label: "Broker outside retain", value: compactList(brokerVsStrategy.outside_retain || []), tone: (brokerVsStrategy.outside_retain || []).length ? "warn" : "ok" },
    { label: "Paper missing targets", value: compactList(paperVsStrategy.missing_targets || []), tone: (paperVsStrategy.missing_targets || []).length ? "warn" : "ok" },
    { label: "Paper outside retain", value: compactList(paperVsStrategy.outside_retain || []), tone: (paperVsStrategy.outside_retain || []).length ? "warn" : "ok" },
    {
      label: "Quantity mismatches",
      value: mismatches.length
        ? mismatches.map((row) => `${row.symbol}: broker ${formatQty(row.broker_quantity)} / paper ${formatQty(row.paper_quantity)}`).join("; ")
        : "None",
      tone: mismatches.length ? "warn" : "ok",
    },
  ];
  target.innerHTML = `<h4>Reconciliation Gaps</h4>${reconciliationKvRows(rows)}`;
}

function renderReconciliationActions(actions = {}) {
  const target = qs("#reconActionRows");
  if (!target) return;
  const exits = actions.exits || [];
  const entries = actions.entries || [];
  const rows = [
    ...exits.map((row) => ({
      type: "MIRROR EXIT",
      symbol: row.symbol,
      detail: `Qty ${formatQty(row.quantity)} | ${row.reason || "Outside retain list"} | read-only only`,
      tone: "warn",
    })),
    ...entries.map((row) => ({
      type: "MIRROR ENTRY",
      symbol: row.symbol,
      detail: `Est. Qty ${row.estimated_quantity ?? "--"} | ${row.reason || "Missing target"} | no live order placed`,
      tone: "ok",
    })),
  ];
  target.innerHTML = `
    <h4>Broker Mirror Preview</h4>
    ${
      rows.length
        ? rows
            .map(
              (row) => `
                <div class="reconciliation-action-row ${row.tone}">
                  <span>${escapeHtml(row.type)}</span>
                  <strong>${escapeHtml(row.symbol || "--")}</strong>
                  <em>${escapeHtml(row.detail)}</em>
                </div>
              `,
            )
            .join("")
        : `<div class="reconciliation-empty">No broker mirror actions from the current read-only comparison.</div>`
    }
  `;
}

function renderReconciliationNotes(notes = []) {
  const target = qs("#reconNoteRows");
  if (!target) return;
  target.innerHTML = `
    <h4>Safety Notes</h4>
    ${
      notes.length
        ? notes.map((note) => `<div class="reconciliation-note-row">${escapeHtml(note)}</div>`).join("")
        : `<div class="reconciliation-empty">No reconciliation notes.</div>`
    }
  `;
}

function renderReconciliationCenter(data = reconciliationState) {
  reconciliationState = data;
  const summary = data.summary || {};
  const strategy = data.strategy || {};
  const paper = data.paper || {};
  const paperSummary = paper.summary || {};
  const broker = data.actual || {};
  const funds = broker.funds || {};
  const dhan = data.dhan || {};
  const cache = dhan.cache || {};
  const endpoints = dhan.endpoint_status || {};
  const comparison = data.comparison || {};

  renderReconciliationStats(data);
  reconciliationStatusPill("#reconStrategyPill", strategy.market_regime || "strategy", strategy.risk_on ? "ok" : "warn");
  reconciliationStatusPill("#reconPaperPill", summary.paper_matches_strategy ? "aligned" : "check", summary.paper_matches_strategy ? "ok" : "warn");
  reconciliationStatusPill("#reconBrokerPill", cache.status || (dhan.ok ? "connected" : "check"), dhan.ok ? (cache.stale ? "warn" : "ok") : "danger");
  reconciliationStatusPill("#reconGapPill", summary.gap_count ? `${summary.gap_count} gaps` : "clear", summary.gap_count ? "warn" : "ok");

  qs("#reconStrategyRows").innerHTML = reconciliationKvRows([
    { label: "Strategy", value: strategy.name || "--", tone: "info" },
    { label: "Market regime", value: strategy.market_regime || "--", tone: strategy.risk_on ? "ok" : "warn" },
    { label: "PDD state", value: strategy.pdd_state || "--", tone: "info" },
    { label: "Target symbols", value: compactList(strategy.target_symbols || []), tone: "info" },
    { label: "Retain symbols", value: compactList(strategy.retain_symbols || []), tone: "info" },
    { label: "Hold buffer rank", value: strategy.hold_buffer_rank ?? "--", tone: "info" },
  ]);
  renderReconciliationSymbolList("#reconTargetRows", "Current Strategy Targets", strategy.target_symbols || [], "No strategy target symbols available.");

  qs("#reconPaperRows").innerHTML = reconciliationKvRows([
    { label: "Paper equity", value: paperSummary.equity ? formatInr(paperSummary.equity) : "--", tone: "info" },
    { label: "Paper cash", value: paperSummary.cash !== undefined ? formatInr(paperSummary.cash) : "--", tone: "info" },
    { label: "Paper drawdown", value: paperSummary.current_drawdown !== undefined ? formatPct(paperSummary.current_drawdown, 2) : "--", tone: Number(paperSummary.current_drawdown || 0) > 0.15 ? "danger" : "warn" },
    { label: "Paper holdings", value: summary.paper_holding_count ?? 0, tone: Number(summary.paper_holding_count || 0) ? "ok" : "warn" },
    { label: "Signal source", value: paper.signal_source?.name || "--", tone: "info" },
  ]);
  renderReconciliationHoldings("#reconPaperHoldings", "Paper Holdings", paper.holdings || [], "No local paper holdings yet.");

  qs("#reconBrokerRows").innerHTML = reconciliationKvRows([
    { label: "Dhan status", value: dhan.message || "--", tone: dhan.ok ? "ok" : "danger" },
    { label: "Cache status", value: cache.status || "missing", tone: cache.stale ? "warn" : "ok" },
    { label: "Cache age", value: cache.age_seconds !== undefined ? formatAgeSeconds(cache.age_seconds) : "--", tone: cache.stale ? "warn" : "ok" },
    { label: "Cache timestamp", value: cache.generated_at ? formatDateTime(cache.generated_at) : "--", tone: cache.available ? "ok" : "warn" },
    { label: "Source", value: dhan.source || "--", tone: "info" },
    { label: "Available cash", value: funds.available_cash !== undefined ? formatInr(funds.available_cash) : "--", tone: "info" },
    { label: "Broker holdings", value: summary.broker_holding_count ?? 0, tone: Number(summary.broker_holding_count || 0) ? "ok" : "warn" },
    { label: "Orders endpoint", value: endpoints.orders?.ok ? `${endpoints.orders.count || 0} rows` : endpoints.orders?.error || "--", tone: endpoints.orders?.ok ? "ok" : "warn" },
    { label: "Trades endpoint", value: endpoints.trades?.ok ? `${endpoints.trades.count || 0} rows` : endpoints.trades?.error || "--", tone: endpoints.trades?.ok ? "ok" : "warn" },
  ]);
  renderReconciliationHoldings("#reconBrokerHoldings", "Broker Holdings", broker.holdings || [], "Dhan returned no broker holdings.");
  renderReconciliationGaps(comparison);
  renderReconciliationActions(data.pending_actions || {});
  renderReconciliationNotes(data.notes || []);
}

function renderReconciliationError(error) {
  const target = qs("#reconGapRows");
  if (!target) return;
  target.innerHTML = `
    <div class="reconciliation-empty error">
      <strong>Reconciliation unavailable.</strong>
      <span>${escapeHtml(error.message || "Unable to load reconciliation data.")}</span>
    </div>
  `;
}

export async function refreshReconciliation() {
  if (reconciliationRefreshInFlight) return reconciliationState;
  reconciliationRefreshInFlight = true;
  const button = qs("#refreshReconciliationData");
  const originalText = button?.textContent || "Refresh Portfolio";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  try {
    const payload = await safeJson("/api/reconciliation");
    renderReconciliationCenter(payload);
    return payload;
  } catch (error) {
    console.error(error);
    renderReconciliationError(error);
    return reconciliationState;
  } finally {
    reconciliationRefreshInFlight = false;
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function refreshBrokerSnapshot() {
  const button = qs("#refreshBrokerSnapshot");
  const originalText = button?.textContent || "Refresh Dhan Mirror";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing Broker...";
  }
  try {
    await safeJson("/api/dhan/broker-snapshot/refresh", { method: "POST" });
    await refreshReconciliation();
    if (getCurrentView() === "operations") await refreshOperations();
    if (getCurrentView() === "settings") await refreshOperations();
  } catch (error) {
    console.error(error);
    renderReconciliationError(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

export function setupReconciliationActions() {
  qs("#refreshReconciliationData")?.addEventListener("click", () => refreshReconciliation());
  qs("#refreshBrokerSnapshot")?.addEventListener("click", () => refreshBrokerSnapshot());
  qs("#openAuditFromRecon")?.addEventListener("click", () => {
    history.pushState(null, "", "#audit");
    setView("audit");
  });
}
