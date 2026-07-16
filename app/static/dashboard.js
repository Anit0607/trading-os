import {
  NUMBER,
  cardByKey,
  escapeHtml,
  firstFinite,
  formatAgeSeconds,
  formatDateLabel,
  formatInr,
  formatInrOrPlaceholder,
  formatPct,
  formatPctOrPlaceholder,
  formatPrice,
  formatQty,
  formatSignedInr,
  formatSignedInrOrPlaceholder,
  hasNumericValue,
  qs,
  qsa,
  setClassBySign,
  setText,
  setTone,
  toneFromLevel,
} from "./formatters.js";

function renderTopBar(snapshot = {}) {
  const ui = snapshot.ui || {};
  const topBar = ui.top_bar || snapshot.top_bar || {};
  const decision = cockpitDecision(snapshot);
  const modeLabel = ui.mode_label || String(snapshot.mode || "paper").toUpperCase();
  const drawdownRaw = topBar.current_drawdown;
  const drawdownAbs = hasNumericValue(drawdownRaw) ? Math.abs(Number(drawdownRaw)) : null;
  const healthItems = qsa(".health-item");

  setText("strong", modeLabel, healthItems[0]);
  setText("small", modeLabel.toLowerCase().includes("paper") ? "Paper safety enabled" : "Review before live use", healthItems[0]);
  setText("strong", topBar.data_status || "Loading…", healthItems[1]);
  setText("small", topBar.last_update ? `Last sync ${topBar.last_update}` : "Last sync --", healthItems[1]);

  const cards = qsa(".portfolio-strip article");
  const values = [
    {
      strong: formatInrOrPlaceholder(topBar.portfolio_value),
      small: hasNumericValue(topBar.portfolio_value) ? "Market Value" : "Loading…",
    },
    {
      strong: formatPctOrPlaceholder(topBar.current_drawdown, 2, false),
      small: hasNumericValue(topBar.current_drawdown) ? "From Peak" : "Loading…",
      tone: drawdownAbs !== null && drawdownAbs >= 0.16 ? "danger" : drawdownAbs !== null && drawdownAbs >= 0.07 ? "warn" : "ok",
    },
    {
      strong: decision.title || "Loading…",
      small: decision.reason || "Waiting for strategy",
      tone: decision.tone || "info",
    },
  ];

  values.forEach((value, index) => {
    const card = cards[index];
    if (!card) return;
    const strong = qs("strong", card);
    const small = qs("small", card);
    if (strong) strong.textContent = value.strong;
    if (small) small.textContent = value.small;
    if (value.sign !== null && value.sign !== undefined) {
      setClassBySign(strong, value.sign);
      setClassBySign(small, value.sign);
    }
    if (value.tone) setTone(strong, value.tone);
  });
}

function renderHoldings(rows = []) {
  const target = qs("#holdingsRows");
  if (!target) return;
  if (!rows.length) {
    target.innerHTML = `<tr><td colspan="11">No holdings data available yet.</td></tr>`;
    return;
  }
  target.innerHTML = rows
    .map((row) => {
      const isGold = row.sleeve === "GOLD" || row.symbol === "GOLDBEES";
      const pnl = Number(row.pnl || 0);
      return `
        <tr class="${isGold ? "gold-row" : ""}">
          <td>${escapeHtml(row.slot)}</td>
          <td>${escapeHtml(row.symbol)}</td>
          <td>${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.sleeve)}</td>
          <td>${formatQty(row.quantity)}</td>
          <td>${formatPrice(row.avg_price)}</td>
          <td>${formatPrice(row.ltp)}</td>
          <td>${formatInr(row.value).replace("₹", "")}</td>
          <td class="${pnl >= 0 ? "green" : "red"}">${formatSignedInr(row.pnl).replace("₹", "")}</td>
          <td class="${pnl >= 0 ? "green" : "red"}">${formatPct(row.pnl_pct, 2, true)}</td>
          <td>${formatPct(row.weight_pct, 2)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderAllocation(allocation = {}) {
  const cards = qsa(".allocation-strip article");
  const totalPnl = Number(allocation.total_pnl || 0);
  const hasTotalPnl = hasNumericValue(allocation.total_pnl);
  const values = [
    formatInrOrPlaceholder(allocation.total_invested),
    formatInrOrPlaceholder(allocation.market_value),
    hasNumericValue(allocation.total_pnl) && hasNumericValue(allocation.total_pnl_pct)
      ? `${formatSignedInr(allocation.total_pnl)} (${formatPct(allocation.total_pnl_pct, 2, true)})`
      : "--",
    hasNumericValue(allocation.cash_available) && hasNumericValue(allocation.cash_pct)
      ? `${formatInr(allocation.cash_available)} (${formatPct(allocation.cash_pct, 2)})`
      : "--",
    formatPctOrPlaceholder(allocation.gold_allocation_pct, 2),
    formatPctOrPlaceholder(allocation.equity_allocation_pct, 2),
  ];
  values.forEach((value, index) => {
    const strong = qs("strong", cards[index]);
    if (!strong) return;
    strong.textContent = value;
    if (index === 2 && hasTotalPnl) setClassBySign(strong, totalPnl);
    if (index === 4) strong.classList.add("gold");
  });
}

function actionRow(row, type) {
  const isEntry = type === "entry";
  const quantityText = isEntry
    ? `Est. Qty: ${formatQty(row.estimated_quantity)}`
    : `Qty: ${formatQty(row.quantity)}`;
  const reasonText = isEntry ? `Rank: ${row.rank}` : row.reason;
  return `
    <div class="action-row">
      <span>${escapeHtml(row.no)}</span>
      <strong>${escapeHtml(row.symbol)}</strong>
      <em>${escapeHtml(quantityText)}</em>
      <small>${escapeHtml(reasonText)}</small>
    </div>
  `;
}

function renderPending(pending = {}) {
  const exits = pending.exits || [];
  const entries = pending.entries || [];
  const exitBox = qs(".exit-box");
  const entryBox = qs(".entry-box");
  if (exitBox) {
    exitBox.innerHTML = `
      <h3>PENDING EXITS (${exits.length})</h3>
      ${exits.length ? exits.map((row) => actionRow(row, "exit")).join("") : `<div class="empty-state">No pending exits</div>`}
    `;
  }
  if (entryBox) {
    entryBox.innerHTML = `
      <h3>PENDING ENTRIES (${entries.length})</h3>
      ${entries.length ? entries.map((row) => actionRow(row, "entry")).join("") : `<div class="empty-state">No pending entries</div>`}
    `;
  }
}

function alertIcon(level) {
  if (["ok", "safe"].includes(level)) return { text: "✓", cls: "ok" };
  if (["warning", "warn", "critical"].includes(level)) return { text: "△", cls: "warn" };
  return { text: "i", cls: level === "muted" ? "muted" : "info" };
}

function renderNotifications(items = []) {
  const target = qs(".alert-list");
  if (!target) return;
  target.innerHTML = (items || [])
    .map((item) => {
      const icon = alertIcon(item.level);
      return `
        <li>
          <span class="${icon.cls}">${icon.text}</span>
          <strong>${escapeHtml(item.message)}</strong>
          <em>${escapeHtml(item.time)}</em>
        </li>
      `;
    })
    .join("");
}

function observabilityClass(level) {
  if (["ok", "safe"].includes(level)) return "ok";
  if (["warning", "warn", "critical"].includes(level)) return "warn";
  if (level === "muted") return "muted";
  return "info";
}

function renderObservability(observability = {}) {
  const target = qs("#observabilityCards");
  if (!target) return;
  const cards = observability.cards || [];
  if (!cards.length) {
    target.innerHTML = `
      <article class="ops-card muted">
        <span>Operations</span>
        <strong>--</strong>
        <small>No status</small>
        <em>Waiting for runtime telemetry</em>
      </article>
    `;
    return;
  }
  target.innerHTML = cards
    .map((card) => {
      const cls = observabilityClass(card.level);
      return `
        <article class="ops-card ${cls}" data-key="${escapeHtml(card.key)}">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <small>${escapeHtml(card.status)}</small>
          <em>${escapeHtml(card.detail)}</em>
        </article>
      `;
    })
    .join("");
}

function renderRanks(rows = []) {
  const target = qs("#rankRows");
  if (!target) return;
  if (!rows.length) {
    target.innerHTML = `<tr><td colspan="5">No rank data available yet.</td></tr>`;
    setText(".table-note", "Universe Count: --");
    return;
  }
  target.innerHTML = rows
    .map((row) => {
      const statusClass = row.status === "In Top 8" ? "rank-status" : "candidate";
      return `
        <tr>
          <td>${escapeHtml(row.rank)}</td>
          <td>${escapeHtml(row.symbol)}</td>
          <td>${formatPct(row.roc_12, 2)}</td>
          <td>${formatPrice(row.ltp)}</td>
          <td class="${statusClass}">${escapeHtml(row.status)}</td>
        </tr>
      `;
    })
    .join("");
  setText(".table-note", `Rank Rows: ${NUMBER.format(rows.length)}`);
}

function renderMarket(health = {}) {
  const cards = qsa(".market-cards .metric-card");
  if (cards[0]) {
    setText("strong", formatPct(health.breadth, 0), cards[0]);
    setText("small", health.breadth_state || "", cards[0]);
  }
  if (cards[1]) {
    setText("strong", health.nifty_state || "--", cards[1]);
    setText("small", health.nifty_note || "", cards[1]);
  }
  if (cards[2]) {
    setText("strong", String(health.market_regime || "Unknown").toUpperCase(), cards[2]);
    setText("small", `Valid Since: ${health.valid_since || "--"}`, cards[2]);
  }
}

function renderPdd(pdd = {}) {
  setText(".pdd-copy strong", formatInr(pdd.equity_peak));
  setText(".pdd-copy small", pdd.peak_date ? `(${pdd.peak_date})` : "");
  setText(".gauge-center strong", formatPct(pdd.drawdown, 2));
  setText(".pdd-rule strong", pdd.rule || "16% / 7%");
  setText(".pdd-rule em", pdd.state || "PDD NORMAL");
}

function renderOrders(rows = []) {
  const target = qs("#orderRows");
  if (!target) return;
  target.innerHTML = rows
    .map((row) => {
      const type = String(row.type || "").toUpperCase();
      const status = String(row.status || "").toUpperCase();
      const statusClass = status === "FILLED" ? "filled" : "paper-status";
      return `
        <tr>
          <td>${escapeHtml(row.time || "--")}</td>
          <td class="${type === "BUY" ? "order-buy" : "order-sell"}">${escapeHtml(type)}</td>
          <td>${escapeHtml(row.symbol)}</td>
          <td>${formatQty(row.quantity)}</td>
          <td>${row.price ? formatPrice(row.price) : "--"}</td>
          <td><span class="${statusClass}">${escapeHtml(status)}</span></td>
        </tr>
      `;
    })
    .join("");
}

function cockpitDetail({ label, value, detail = "", tone = "info" }) {
  return `
    <article class="cockpit-detail ${escapeHtml(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </article>
  `;
}

function cockpitDecision(snapshot = {}) {
  const ui = snapshot.ui || {};
  const pending = ui.pending_actions || {};
  const exits = pending.exits || [];
  const entries = pending.entries || [];
  const rebalance = ui.rebalance_status || snapshot.paper?.rebalance_status || {};
  const market = ui.market_health || {};
  const regime = String(market.market_regime || ui.top_bar?.market_regime || "").toUpperCase();

  if (exits.length || entries.length) {
    return {
      tone: "warn",
      title: "Review monthly action plan",
      reason: `${exits.length} exit(s) and ${entries.length} entry(ies) are pending in paper mode.`,
    };
  }

  if (rebalance.allowed) {
    return {
      tone: "warn",
      title: "Monthly rebalance window is open",
      reason: rebalance.reason || "First trading day gate is open; review the paper action plan.",
    };
  }

  if (regime.includes("OFF")) {
    return {
      tone: "gold",
      title: "Hold defensive allocation",
      reason: market.reason ? `Risk Off because ${market.reason}.` : "Risk Off is active, so the strategy remains in the defensive sleeve.",
    };
  }

  return {
    tone: "ok",
    title: "Hold current portfolio",
    reason: rebalance.reason || "No entries or exits are due until the next monthly rebalance.",
  };
}

function navigateToHash(hash) {
  const link = qsa(".nav-menu a").find((item) => item.dataset.hash === hash || item.getAttribute("href") === hash);
  if (link) {
    link.click();
    return;
  }
  if (window.location.hash !== hash) {
    history.pushState(null, "", hash);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function rowByStep(rows = [], step) {
  return rows.find((row) => row.step === step) || {};
}

function cockpitPrimaryCta(snapshot = {}) {
  const ui = snapshot.ui || {};
  const cloud = snapshot.cloud || ui.cloud || {};
  const cloudWorker = cloud.worker || {};
  const pending = ui.pending_actions || {};
  const exits = pending.exits || [];
  const entries = pending.entries || [];
  const rebalance = ui.rebalance_status || snapshot.paper?.rebalance_status || {};
  const checklist = buildTradingChecklist(snapshot);
  const sync = rowByStep(checklist, "Latest data sync");
  const alerts = rowByStep(checklist, "Alerts");
  const cloudStale = Boolean(cloud.readonly && (cloudWorker.stale || cloud.error));

  if (cloudStale) {
    return {
      label: "View Last Sync Details",
      action: "navigate",
      hash: "#reports",
      tone: "warn",
      state: "cloud_stale",
    };
  }

  if (String(sync.status || "").toLowerCase() === "stale") {
    return {
      label: "Refresh Data",
      action: "refresh",
      tone: "warn",
      state: "data_stale",
    };
  }

  if (rebalance.allowed) {
    return {
      label: "Open Monthly Checklist",
      action: "navigate",
      hash: "#actions",
      tone: "warn",
      state: "rebalance_open",
    };
  }

  if (exits.length || entries.length) {
    return {
      label: "Review Action Plan",
      action: "navigate",
      hash: "#actions",
      tone: "warn",
      state: "pending_plan",
    };
  }

  if (String(alerts.status || "").toLowerCase() === "warning") {
    return {
      label: "Open Alerts",
      action: "navigate",
      hash: "#alerts",
      tone: "warn",
      state: "alert_warning",
    };
  }

  return {
    label: "View Evidence",
    action: "navigate",
    hash: "#reports",
    tone: "ok",
    state: "no_action",
  };
}

async function handleCockpitCta(cta, button) {
  if (!cta) return;
  if (cta.action === "refresh") {
    if (button) {
      button.disabled = true;
      button.textContent = "Refreshing...";
    }
    await refreshDashboard();
    return;
  }
  if (cta.action === "navigate" && cta.hash) {
    navigateToHash(cta.hash);
  }
}

function renderCockpitPrimaryCta(snapshot = {}) {
  const target = qs("#cockpitPrimaryCta");
  if (!target) return;
  const cta = cockpitPrimaryCta(snapshot);
  target.innerHTML = `
    <button
      class="control-button primary ${escapeHtml(cta.tone || "ok")}"
      type="button"
      data-action="${escapeHtml(cta.action)}"
      data-state="${escapeHtml(cta.state)}"
      ${cta.hash ? `data-hash="${escapeHtml(cta.hash)}"` : ""}
    >
      ${escapeHtml(cta.label)}
    </button>
  `;
  const button = qs("button", target);
  button?.addEventListener("click", () => handleCockpitCta(cta, button));
}

function readableJoin(items = []) {
  const values = items.filter(Boolean);
  if (values.length <= 1) return values[0] || "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function countLabel(count, singular, plural = `${singular}s`) {
  const value = Number(count || 0);
  return `${value} ${value === 1 ? singular : plural}`;
}

function buildDecisionExplanation(snapshot = {}, decision = cockpitDecision(snapshot)) {
  const ui = snapshot.ui || {};
  const pending = ui.pending_actions || {};
  const exits = pending.exits || [];
  const entries = pending.entries || [];
  const rebalance = ui.rebalance_status || snapshot.paper?.rebalance_status || {};
  const market = ui.market_health || {};
  const pdd = ui.pdd_status || snapshot.pdd || {};
  const top = ui.top_bar || {};
  const signal = ui.signal_source || snapshot.paper?.signal_source || {};
  const checklist = buildTradingChecklist(snapshot);
  const sync = rowByStep(checklist, "Latest data sync");
  const alerts = rowByStep(checklist, "Alerts");
  const cloud = snapshot.cloud || ui.cloud || {};
  const cloudWorker = cloud.worker || {};
  const cloudStale = Boolean(cloud.readonly && (cloudWorker.stale || cloud.error));
  const pendingCount = exits.length + entries.length;
  const regime = market.market_regime || top.market_regime || "Unknown";
  const regimeReason = market.reason || market.nifty_note || "";
  const drawdownRaw = firstFinite(pdd.drawdown, pdd.current_drawdown, top.current_drawdown);
  const drawdown = Math.abs(Number(drawdownRaw || 0));
  const pddState = String(pdd.state || top.pdd_state || "PDD NORMAL").toUpperCase();
  const pddNormal = pddState.includes("NORMAL") || drawdown < 0.07;
  const coverage = signal.coverage !== null && signal.coverage !== undefined ? Number(signal.coverage) : null;

  const pendingClause = pendingCount
    ? `${countLabel(exits.length, "exit")} and ${countLabel(entries.length, "entry", "entries")} are pending`
    : "no entry/exit is pending";
  const gateClause = rebalance.allowed
    ? "the monthly rebalance gate is open"
    : "the monthly rebalance gate is closed";
  const marketClause = `market regime is ${regime}${regimeReason ? ` (${regimeReason})` : ""}`;
  const pddClause = pddNormal
    ? `PDD is within normal range (${formatPct(drawdown, 2)} drawdown)`
    : `PDD state is ${pddState} (${formatPct(drawdown, 2)} drawdown)`;

  const clauses = [pendingClause, gateClause, marketClause, pddClause];
  if (cloudStale) {
    clauses.unshift("the cloud mirror is showing the last synced local-worker snapshot");
  } else if (String(sync.status || "").toLowerCase() === "stale") {
    clauses.unshift("scanner/portfolio data is stale");
  }
  if (String(alerts.status || "").toLowerCase() === "warning") {
    clauses.push("there is an operational alert to review");
  }

  const summary = `The system says “${decision.title}” because ${readableJoin(clauses)}.`;
  const factors = [
    pendingCount
      ? `Action plan: ${countLabel(exits.length, "exit")} and ${countLabel(entries.length, "entry", "entries")} pending.`
      : "Action plan: no paper entry or exit is pending.",
    `Rebalance gate: ${rebalance.allowed ? "open" : "closed"}${rebalance.reason ? ` — ${rebalance.reason}` : "."}`,
    `Market regime: ${regime}${regimeReason ? ` — ${regimeReason}` : "."}`,
    `PDD rule: ${pddState}; current drawdown ${formatPct(drawdown, 2)}.`,
    signal.run_id
      ? `Scanner data: run ${signal.run_id}${signal.as_of_month ? `, candle ${signal.as_of_month}` : ""}${coverage !== null ? `, ${formatPct(coverage, 2)} coverage` : ""}.`
      : `Scanner data: ${signal.status || signal.name || "not available"}; review before acting.`,
  ];
  if (cloudStale) {
    factors.push(`Cloud sync: stale/offline${cloudWorker.last_seen_at ? `; last seen ${formatDateLabel(cloudWorker.last_seen_at)}` : ""}.`);
  }
  if (String(alerts.status || "").toLowerCase() === "warning") {
    factors.push(`Alerts: ${alerts.meaning || "one warning needs review."}`);
  }
  return { summary, factors };
}

function renderDecisionExplanation(snapshot = {}, decision = cockpitDecision(snapshot)) {
  const summaryTarget = qs("#cockpitExplainSummary");
  const factorsTarget = qs("#cockpitExplainFactors");
  if (!summaryTarget || !factorsTarget) return;
  const explanation = buildDecisionExplanation(snapshot, decision);
  summaryTarget.textContent = explanation.summary;
  factorsTarget.innerHTML = explanation.factors
    .map((factor) => `<li>${escapeHtml(factor)}</li>`)
    .join("");
}

function renderCockpitHero(snapshot = {}) {
  const ui = snapshot.ui || {};
  const market = ui.market_health || {};
  const pdd = ui.pdd_status || snapshot.pdd || {};
  const live = snapshot.paper?.live_prices || {};
  const cloud = snapshot.cloud || ui.cloud || {};
  const cloudWorker = cloud.worker || {};
  const decision = cockpitDecision(snapshot);
  const hero = qs(".cockpit-hero");
  const cloudStale = Boolean(cloud.readonly && (cloudWorker.stale || cloud.error));
  if (hero) {
    hero.classList.remove("ok", "warn", "gold", "danger");
    hero.classList.add(cloudStale ? "warn" : decision.tone);
  }
  setText("#cockpitDecision", decision.title);
  setText(
    "#cockpitReason",
    cloudStale
      ? `Cloud mirror is stale/offline; showing last synced data. ${decision.reason}`
      : decision.reason
  );
  renderCockpitPrimaryCta(snapshot);
  renderDecisionExplanation(snapshot, decision);

  const chips = [
    { label: "Mode", value: ui.mode_label || String(snapshot.mode || "paper").toUpperCase(), tone: "info" },
    {
      label: "Risk",
      value: market.market_regime || ui.top_bar?.market_regime || "--",
      tone: String(market.market_regime || ui.top_bar?.market_regime || "").toUpperCase().includes("OFF") ? "gold" : "ok",
    },
    { label: "PDD", value: pdd.state || "PDD NORMAL", tone: firstFinite(pdd.drawdown, pdd.current_drawdown) >= 0.16 ? "warn" : "ok" },
    { label: "Live LTP", value: live.ok ? "ON" : "WAITING", tone: live.ok ? "ok" : "warn" },
  ];
  if (cloud.readonly) {
    chips.push({
      label: "Cloud",
      value: cloudStale ? "STALE" : "SYNCED",
      tone: cloudStale ? "warn" : "ok",
    });
  }
  const target = qs("#cockpitChips");
  if (target) {
    target.innerHTML = chips
      .map((chip) => `
        <article class="cockpit-chip ${escapeHtml(chip.tone)}">
          <span>${escapeHtml(chip.label)}</span>
          <strong>${escapeHtml(chip.value)}</strong>
        </article>
      `)
      .join("");
  }
}

function checklistDate(snapshot = {}) {
  const ui = snapshot.ui || {};
  const observability = ui.observability || {};
  const summary = observability.summary || {};
  return summary.today || ui.rebalance_status?.today || snapshot.paper?.rebalance_status?.today || String(snapshot.generated_at || "").slice(0, 10);
}

function parseIsoDate(value) {
  const raw = String(value || "");
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function checklistStatusTone(status, fallback = "info") {
  const value = String(status || "").toLowerCase();
  if (["ok", "fresh", "ready", "clear", "open"].includes(value)) return "ok";
  if (["stale", "partial", "warning", "closed", "no action"].includes(value)) return "warn";
  if (["blocked", "missing", "failed"].includes(value)) return "danger";
  return fallback;
}

function checklistRow(step, status, meaning, tone = null) {
  return {
    step,
    status,
    meaning,
    tone: tone || checklistStatusTone(status),
  };
}

function checklistImportantAlerts(snapshot = {}) {
  const ui = snapshot.ui || {};
  const cloud = snapshot.cloud || ui.cloud || {};
  const cloudWorker = cloud.worker || {};
  const notifications = [...(snapshot.alerts || []), ...(ui.notifications || [])];
  if (cloud.readonly && (cloudWorker.stale || cloud.error)) {
    return { warning: true, reason: "Cloud mirror is stale/offline." };
  }
  const important = notifications.find((item) => {
    const level = String(item.level || "").toLowerCase();
    const message = String(item.message || "");
    if (/live order placement is disabled/i.test(message)) return false;
    if (/regime is risk-off/i.test(message)) return false;
    if (["critical", "danger", "error"].includes(level)) return true;
    if (["warning", "warn"].includes(level)) return true;
    return /failed|blocked|stale|missing/i.test(message);
  });
  return important
    ? { warning: true, reason: important.message || important.title || "Alert stream needs review." }
    : { warning: false, reason: "No warning or failure alerts in the latest dashboard stream." };
}

function buildTradingChecklist(snapshot = {}) {
  const ui = snapshot.ui || {};
  const observability = ui.observability || {};
  const observabilitySummary = observability.summary || {};
  const observabilityCards = observability.cards || [];
  const holidayCard = cardByKey(observabilityCards, "holiday");
  const dhanCard = cardByKey(observabilityCards, "dhan_sync");
  const pending = ui.pending_actions || {};
  const exits = pending.exits || [];
  const entries = pending.entries || [];
  const rebalance = ui.rebalance_status || snapshot.paper?.rebalance_status || {};
  const signal = ui.signal_source || snapshot.paper?.signal_source || {};
  const cloud = snapshot.cloud || ui.cloud || {};
  const cloudWorker = cloud.worker || {};
  const dhanMirror = ui.dhan_mirror || {};
  const today = checklistDate(snapshot);
  const todayDate = parseIsoDate(today);
  const isWeekend = todayDate ? [0, 6].includes(todayDate.getDay()) : false;
  const todayLabel = today ? formatDateLabel(today) : "today";

  let marketStatus = "OK";
  let marketTone = "ok";
  let marketMeaning = `${todayLabel} is marked as an NSE trading day.`;
  if (observabilitySummary.holiday_calendar_ok === false || holidayCard.level === "warning") {
    marketStatus = "Blocked";
    marketTone = "danger";
    marketMeaning = "Holiday calendar is missing/stale, so action should be blocked until checked.";
  }
  if (isWeekend || observabilitySummary.today_is_trading_day === false) {
    marketStatus = "Blocked";
    marketTone = "danger";
    marketMeaning = observabilitySummary.today_is_holiday
      ? `${todayLabel} is an NSE holiday${observabilitySummary.today_holiday_description ? `: ${observabilitySummary.today_holiday_description}` : ""}.`
      : isWeekend || observabilitySummary.today_is_weekend
        ? `${todayLabel} is a weekend.`
        : `${todayLabel} is not marked as a trading day.`;
  }
  if (observabilitySummary.today_is_trading_day === true) {
    marketStatus = "OK";
    marketTone = "ok";
    marketMeaning = `${todayLabel} is a trading day; NSE holiday calendar is usable.`;
  }

  const cloudStale = Boolean(cloud.readonly && (cloudWorker.stale || cloud.error));
  const scannerFresh = Boolean(signal.run_id || signal.name === "dhan_scanner");
  const generatedDetail = snapshot.generated_at ? `Dashboard generated ${formatDateLabel(snapshot.generated_at)}.` : "Dashboard timestamp unavailable.";
  const syncStatus = cloudStale || !scannerFresh ? "Stale" : "Fresh";
  const syncMeaning = cloudStale
    ? `Local worker last sync is stale (${cloudWorker.last_seen_at || "unknown"}).`
    : scannerFresh
      ? `Scanner/portfolio snapshot is current for run ${signal.run_id || "--"}${signal.as_of_month ? `, candle ${signal.as_of_month}` : ""}.`
      : `${generatedDetail} Scanner signal is using fallback/reference data.`;

  const mirrorStatusRaw = String(dhanMirror.status || "").toLowerCase();
  let mirrorStatus = "Missing";
  let mirrorTone = "danger";
  let mirrorMeaning = "No broker mirror snapshot is available yet.";
  if (dhanMirror.available || mirrorStatusRaw === "fresh" || dhanCard.level === "ok") {
    mirrorStatus = dhanMirror.stale || mirrorStatusRaw === "stale" ? "Stale" : "Fresh";
    mirrorTone = mirrorStatus === "Fresh" ? "ok" : "warn";
    mirrorMeaning = mirrorStatus === "Fresh"
      ? `Broker mirror usable${dhanMirror.age_seconds !== undefined ? `; age ${formatAgeSeconds(dhanMirror.age_seconds)}` : ""}.`
      : `Broker mirror exists but is stale${dhanMirror.age_seconds !== undefined ? `; age ${formatAgeSeconds(dhanMirror.age_seconds)}` : ""}.`;
  } else if (dhanCard.value || dhanCard.status) {
    mirrorStatus = dhanCard.level === "warning" ? "Stale" : "Fresh";
    mirrorTone = dhanCard.level === "warning" ? "warn" : "ok";
    mirrorMeaning = dhanCard.detail || "Dhan mirror status is available from runtime telemetry.";
  }

  const signalStatus = String(signal.status || signal.name || "").toLowerCase();
  const signalCoverage = signal.coverage !== null && signal.coverage !== undefined ? Number(signal.coverage) : null;
  let strategyStatus = "Failed";
  let strategyTone = "danger";
  let strategyMeaning = "No usable ROC/ranking signal is available.";
  if (["complete", "completed", "ok"].includes(signalStatus) && signal.run_id) {
    strategyStatus = "Ready";
    strategyTone = "ok";
    strategyMeaning = `ROC/ranking signal ready from run ${signal.run_id}${signalCoverage !== null ? ` with ${formatPct(signalCoverage, 2)} coverage` : ""}.`;
  } else if (signalStatus === "partial_coverage" || signalStatus === "fallback" || signal.name === "reference_csv" || signal.run_id) {
    strategyStatus = "Partial";
    strategyTone = "warn";
    strategyMeaning = signalStatus === "fallback" || signal.name === "reference_csv"
      ? "Using fallback/reference rankings; review before acting."
      : `Ranking signal is partial${signalCoverage !== null ? ` (${formatPct(signalCoverage, 2)} coverage)` : ""}.`;
  }

  const gateStatus = rebalance.allowed ? "Open" : "Closed";
  const gateMeaning = rebalance.allowed
    ? (rebalance.reason || "Monthly rebalance gate is open today.")
    : (rebalance.reason || `Next monthly gate is ${observabilitySummary.next_rebalance ? formatDateLabel(observabilitySummary.next_rebalance) : "not due yet"}.`);

  const plannedCount = exits.length + entries.length;
  const planStatus = plannedCount ? "Ready" : "No action";
  const planMeaning = plannedCount
    ? `${exits.length} exit(s) and ${entries.length} entry(ies) should be reviewed before any paper action.`
    : "No paper orders are currently planned for review.";

  const alertState = checklistImportantAlerts(snapshot);

  return [
    checklistRow("Market holiday check", marketStatus, marketMeaning, marketTone),
    checklistRow("Latest data sync", syncStatus, syncMeaning),
    checklistRow("Dhan mirror", mirrorStatus, mirrorMeaning, mirrorTone),
    checklistRow("Strategy signal", strategyStatus, strategyMeaning, strategyTone),
    checklistRow("Rebalance gate", gateStatus, gateMeaning, rebalance.allowed ? "ok" : "warn"),
    checklistRow("Paper order plan", planStatus, planMeaning, plannedCount ? "warn" : "ok"),
    checklistRow("Alerts", alertState.warning ? "Warning" : "Clear", alertState.reason, alertState.warning ? "warn" : "ok"),
  ];
}

function renderTradingChecklist(snapshot = {}) {
  const target = qs("#todayChecklistRows");
  if (!target) return;
  const rows = buildTradingChecklist(snapshot);
  const hasDanger = rows.some((row) => row.tone === "danger");
  const hasWarning = rows.some((row) => row.tone === "warn");
  const state = qs("#todayChecklistState");
  if (state) {
    state.textContent = hasDanger ? "Blocked" : hasWarning ? "Review" : "Ready";
    state.className = hasDanger ? "danger" : hasWarning ? "warn" : "ok";
  }
  target.innerHTML = rows
    .map((row) => `
      <article class="today-checklist-row ${escapeHtml(row.tone)}" role="row">
        <strong role="cell">${escapeHtml(row.step)}</strong>
        <em role="cell">${escapeHtml(row.status)}</em>
        <span role="cell">${escapeHtml(row.meaning)}</span>
      </article>
    `)
    .join("");
}

function renderCockpitKpis(snapshot = {}) {
  const ui = snapshot.ui || {};
  const allocation = ui.allocation || {};
  const top = ui.top_bar || {};
  const market = ui.market_health || {};
  const portfolio = snapshot.paper?.portfolio || {};
  const summary = portfolio.summary || portfolio.state || {};
  const pdd = ui.pdd_status || snapshot.pdd || {};
  const observability = ui.observability || {};
  const rebalance = ui.rebalance_status || snapshot.paper?.rebalance_status || {};

  const dayPnl = firstFinite(top.day_pnl, summary.day_pnl);
  const dayPnlPct = firstFinite(top.day_pnl_pct, summary.day_pnl_pct);
  const totalPnl = firstFinite(top.total_pnl, summary.total_pnl, allocation.total_pnl);
  const totalPnlPct = firstFinite(top.total_pnl_pct, summary.total_pnl_pct, allocation.total_pnl_pct);
  const drawdownRaw = firstFinite(pdd.drawdown, pdd.current_drawdown, summary.current_drawdown, top.current_drawdown);
  const drawdown = Number.isFinite(Number(drawdownRaw)) ? Math.abs(Number(drawdownRaw)) : drawdownRaw;
  const pddState = pdd.state || top.pdd_state || "PDD NORMAL";
  const pddRule = pdd.rule || top.pdd_rule || "16% / 7%";
  const marketRegime = market.market_regime || top.market_regime || "--";
  const breadth = firstFinite(market.breadth, top.breadth);
  const nextRebalance = observability.summary?.next_rebalance || rebalance.next_rebalance || "2026-08-03";

  setText("#cockpitDayPnl", `${formatSignedInr(dayPnl)} (${formatPct(dayPnlPct, 2, true)})`);
  setTone(qs("#cockpitDayPnl"), dayPnl >= 0 ? "ok" : "danger");
  setText("#cockpitTotalPnl", `${formatSignedInr(totalPnl)} (${formatPct(totalPnlPct, 2, true)})`);
  setTone(qs("#cockpitTotalPnl"), totalPnl >= 0 ? "ok" : "danger");
  setText("#cockpitDrawdown", formatPct(drawdown, 2));
  setTone(qs("#cockpitDrawdown"), drawdown >= 0.16 ? "danger" : drawdown >= 0.07 ? "warn" : "ok");
  renderCockpitDrawdownGauge(drawdown, pdd);
  setText("#cockpitPddState", pddState);
  setTone(qs("#cockpitPddState"), drawdown >= 0.16 ? "warn" : "ok");
  setText("#cockpitPddRule", `Rule ${pddRule}`);
  setText("#cockpitRegime", marketRegime);
  setTone(qs("#cockpitRegime"), String(marketRegime).toUpperCase().includes("OFF") ? "gold" : "ok");
  setText("#cockpitRegimeNote", hasNumericValue(breadth) ? `Breadth ${formatPct(breadth, 0, false)}` : (market.reason || "Breadth --"));
  setText("#cockpitNextRebalance", formatDateLabel(nextRebalance));
}

function renderCockpitDrawdownGauge(drawdown, pdd = {}) {
  const value = Number.isFinite(Number(drawdown)) ? Number(drawdown) : 0;
  const capped = Math.min(Math.max(value, 0), 0.3);
  const rotation = -90 + (capped / 0.3) * 180;
  const tone = value >= 0.16 ? "danger" : value >= 0.07 ? "warn" : "ok";
  const gauge = qs(".mini-drawdown-gauge");
  const needle = qs("#cockpitDrawdownNeedle");
  if (needle) needle.style.setProperty("--drawdown-rotation", `${rotation.toFixed(1)}deg`);
  if (gauge) {
    gauge.classList.toggle("ok", tone === "ok");
    gauge.classList.toggle("warn", tone === "warn");
    gauge.classList.toggle("danger", tone === "danger");
  }
  setText("#cockpitDrawdownGaugeValue", formatPct(value, 2));
  const pddState = pdd.state || pdd.current_state || "PDD NORMAL";
  const pddRule = pdd.rule || pdd.pdd_rule || "16% / 7%";
  setText("#cockpitDrawdownNote", `${pddState} · Rule ${pddRule}`);
}

function renderCockpitHoldings(rows = []) {
  const target = qs("#cockpitHoldingRows");
  if (!target) return;
  setText("#cockpitHoldingCount", `${rows.length} holding${rows.length === 1 ? "" : "s"}`);
  if (!rows.length) {
    target.innerHTML = `<tr><td colspan="8">No paper holdings yet.</td></tr>`;
    return;
  }
  target.innerHTML = rows
    .map((row) => {
      const pnl = Number(row.pnl || 0);
      const isGold = row.sleeve === "GOLD" || row.symbol === "GOLDBEES";
      return `
        <tr class="${isGold ? "gold-row" : ""}">
          <td>${escapeHtml(row.sleeve || row.role || "--")}</td>
          <td>${escapeHtml(row.symbol || "--")}</td>
          <td>${formatQty(row.quantity)}</td>
          <td>${formatPrice(row.avg_price)}</td>
          <td>${formatPrice(row.ltp || row.last_price)}</td>
          <td>${formatInr(row.value)}</td>
          <td class="${pnl >= 0 ? "green" : "red"}">${formatSignedInr(pnl)} (${formatPct(row.pnl_pct, 2, true)})</td>
          <td>${formatPct(row.weight_pct, 2)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCockpitActions(snapshot = {}) {
  const ui = snapshot.ui || {};
  const pending = ui.pending_actions || {};
  const exits = pending.exits || [];
  const entries = pending.entries || [];
  const rebalance = ui.rebalance_status || snapshot.paper?.rebalance_status || {};
  const observability = ui.observability || {};
  const target = qs("#cockpitActionRows");
  if (!target) return;

  const rows = [];
  exits.forEach((row) => rows.push({
    label: "Exit",
    value: row.symbol,
    detail: `${formatQty(row.quantity)} qty | ${row.reason || "Monthly rule"}`,
    tone: "warn",
  }));
  entries.forEach((row) => rows.push({
    label: "Entry",
    value: row.symbol,
    detail: `Estimated ${formatQty(row.estimated_quantity)} qty | Rank ${row.rank ?? "--"}`,
    tone: "ok",
  }));

  if (!rows.length) {
    rows.push({
      label: "Trade action",
      value: rebalance.allowed ? "Paper rebalance can run" : "No action needed now",
      detail: rebalance.allowed
        ? (rebalance.reason || "Monthly gate is open.")
        : `Next check: ${formatDateLabel(observability.summary?.next_rebalance || "2026-08-03")}. ${rebalance.reason || ""}`.trim(),
      tone: rebalance.allowed ? "warn" : "ok",
    });
  }

  target.innerHTML = rows.map(cockpitDetail).join("");
}

function renderCockpitStrategy(snapshot = {}) {
  const ui = snapshot.ui || {};
  const allocation = ui.allocation || {};
  const market = ui.market_health || {};
  const pdd = ui.pdd_status || snapshot.pdd || {};
  const signal = ui.signal_source || snapshot.paper?.signal_source || {};
  const target = qs("#cockpitStrategyRows");
  if (!target) return;

  const rows = [
    {
      label: "Market regime",
      value: market.market_regime || ui.top_bar?.market_regime || "--",
      detail: market.reason || market.nifty_note || "Regime data loaded from latest scanner run.",
      tone: String(market.market_regime || "").toUpperCase().includes("OFF") ? "gold" : "ok",
    },
    {
      label: "Allocation rule",
      value: `Equity ${formatPct(allocation.equity_allocation_pct, 0)} / Gold ${formatPct(allocation.gold_allocation_pct, 0)}`,
      detail: "Risk Off routes the sleeve to GOLDBEES; Risk On returns to ranked equity sleeves at the monthly gate.",
      tone: firstFinite(allocation.gold_allocation_pct) > 0.5 ? "gold" : "ok",
    },
    {
      label: "PDD rule",
      value: pdd.rule || "16% / 7%",
      detail: `${pdd.state || "PDD Normal"} | current drawdown ${formatPct(firstFinite(pdd.drawdown, pdd.current_drawdown), 2)}`,
      tone: firstFinite(pdd.drawdown, pdd.current_drawdown) >= 0.16 ? "warn" : "ok",
    },
    {
      label: "Scanner data",
      value: signal.as_of_month ? `Candle ${signal.as_of_month}` : "Latest scanner",
      detail: signal.coverage ? `Coverage ${formatPct(signal.coverage, 2)} | Run ${signal.run_id || "--"}` : (signal.status || "Scanner status loading."),
      tone: signal.status === "partial_coverage" ? "warn" : "ok",
    },
  ];

  target.innerHTML = rows.map(cockpitDetail).join("");
}

function renderCockpitHealth(snapshot = {}) {
  const ui = snapshot.ui || {};
  const cards = ui.observability?.cards || [];
  const live = snapshot.paper?.live_prices || {};
  const signal = ui.signal_source || snapshot.paper?.signal_source || {};
  const dhan = cardByKey(cards, "dhan_sync");
  const alerting = cardByKey(cards, "alerting");
  const scanner = cardByKey(cards, "scanner");
  const target = qs("#cockpitHealthRows");
  if (!target) return;

  const rows = [
    {
      label: "Live prices",
      value: live.ok ? "Connected" : "Waiting",
      detail: live.source || (live.errors || []).join("; ") || "Dhan LTP cache",
      tone: live.ok ? "ok" : "warn",
    },
    {
      label: "Dhan read-only",
      value: dhan.value || "READY",
      detail: dhan.detail || "Live order placement remains blocked.",
      tone: toneFromLevel(dhan.level || "ok"),
    },
    {
      label: "Scanner",
      value: scanner.value || signal.status || "--",
      detail: scanner.detail || (signal.coverage ? `Coverage ${formatPct(signal.coverage, 2)}` : "Waiting for scanner status."),
      tone: toneFromLevel(scanner.level || (signal.status === "partial_coverage" ? "warning" : "ok")),
    },
    {
      label: "Alerts",
      value: alerting.value || "TELEGRAM",
      detail: alerting.detail || "Telegram alerting configured.",
      tone: toneFromLevel(alerting.level || "ok"),
    },
  ];

  target.innerHTML = rows.map(cockpitDetail).join("");
}

function renderCockpitAlerts(snapshot = {}) {
  const ui = snapshot.ui || {};
  const target = qs("#cockpitAlertRows");
  if (!target) return;

  const seen = new Set();
  const combined = [...(snapshot.alerts || []), ...(ui.notifications || [])]
    .filter((item) => {
      const message = item.message || "";
      if (!message || seen.has(message)) return false;
      seen.add(message);
      const level = String(item.level || "").toLowerCase();
      return ["warning", "warn", "critical", "danger", "error"].includes(level)
        || /risk off|coverage|failed|blocked|disabled/i.test(message);
    })
    .slice(0, 4);

  if (!combined.length) {
    target.innerHTML = cockpitDetail({
      label: "Alert status",
      value: "No important alerts",
      detail: "Only normal informational messages are present.",
      tone: "ok",
    });
    return;
  }

  target.innerHTML = combined
    .map((item) => cockpitDetail({
      label: item.time || "Runtime",
      value: item.message || "--",
      detail: String(item.level || "info").toUpperCase(),
      tone: toneFromLevel(String(item.level || "").toLowerCase()),
    }))
    .join("");
}

function renderCockpit(snapshot = {}) {
  const ui = snapshot.ui || {};
  renderCockpitHero(snapshot);
  renderTradingChecklist(snapshot);
  renderCockpitKpis(snapshot);
  renderCockpitHoldings(ui.holdings || snapshot.paper?.portfolio?.holdings || []);
  renderCockpitActions(snapshot);
  renderCockpitStrategy(snapshot);
  renderCockpitHealth(snapshot);
  renderCockpitAlerts(snapshot);
}

function renderFooter(footer = {}, modeLabel = "PAPER TRADING") {
  setText("#modeBadge", modeLabel);
  setText("#footerMode", footer.environment || modeLabel);
  const footerCells = qsa(".footer-console > span");
  if (footerCells[1]) setText("strong", footer.data_source || "Reference backtest", footerCells[1]);
  if (footerCells[2]) setText("strong", footer.auto_sync ? "Enabled" : "Disabled", footerCells[2]);
}

export function renderDashboard(snapshot) {
  const ui = snapshot.ui || {};
  const holdings = ui.holdings || snapshot.paper?.portfolio?.holdings || [];
  const ranks = ui.rank_rows || snapshot.ranks || [];
  renderTopBar(snapshot);
  renderHoldings(holdings);
  renderAllocation(ui.allocation || {});
  renderPending(ui.pending_actions || {});
  renderNotifications(ui.notifications || snapshot.alerts || []);
  renderObservability(ui.observability || {});
  renderRanks(ranks);
  renderMarket(ui.market_health || {});
  renderPdd(ui.pdd_status || snapshot.pdd || {});
  renderOrders(ui.recent_orders || snapshot.paper?.orders || snapshot.order_plan || []);
  renderCockpit(snapshot);
  renderFooter(ui.footer || {}, ui.mode_label || "PAPER TRADING");
}

export async function refreshDashboard() {
  try {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
    const snapshot = await response.json();
    renderDashboard(snapshot);
  } catch (error) {
    console.error(error);
    setText("#cockpitDecision", "Dashboard data unavailable");
    setText("#cockpitReason", "The local Trading OS server is reachable, but /api/dashboard did not return data.");
    const alertTarget = qs("#cockpitAlertRows");
    if (alertTarget) {
      alertTarget.innerHTML = cockpitDetail({
        label: "Runtime",
        value: "Dashboard API is unavailable",
        detail: "Waiting for local server data.",
        tone: "warn",
      });
    }
    renderNotifications([
      {
        level: "warning",
        message: "Dashboard API is unavailable. Waiting for local server.",
        time: "Runtime",
      },
    ]);
  }
}
