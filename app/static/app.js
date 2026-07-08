const INR = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

const PRICE = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NUMBER = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

let currentView = "dashboard";
let notificationFilter = "all";
let notificationCache = [];
let notificationStatus = {};
let notificationRefreshInFlight = false;
let controlState = {};
let controlRefreshInFlight = false;
let auditState = {};
let auditRefreshInFlight = false;
let reconciliationState = {};
let reconciliationRefreshInFlight = false;
let dryRunState = {};
let dryRunRefreshInFlight = false;

function qs(selector, root = document) {
  return root.querySelector(selector);
}

function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function setText(selector, value, root = document) {
  const node = qs(selector, root);
  if (node) node.textContent = value;
}

function setClassBySign(node, value) {
  if (!node) return;
  node.classList.toggle("green", Number(value) >= 0);
  node.classList.toggle("red", Number(value) < 0);
}

function asPercent(value) {
  const number = Number(value || 0);
  return number * 100;
}

function formatInr(value) {
  return `₹${INR.format(Math.round(Number(value || 0)))}`;
}

function formatSignedInr(value) {
  const number = Number(value || 0);
  const sign = number >= 0 ? "+" : "-";
  return `${sign}${formatInr(Math.abs(number))}`;
}

function formatPrice(value) {
  const number = Number(value || 0);
  return number ? PRICE.format(number) : "--";
}

function formatQty(value) {
  return NUMBER.format(Math.round(Number(value || 0)));
}

function hasNumericValue(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function formatInrOrPlaceholder(value) {
  return hasNumericValue(value) ? formatInr(value) : "--";
}

function formatSignedInrOrPlaceholder(value) {
  return hasNumericValue(value) ? formatSignedInr(value) : "--";
}

function formatPctOrPlaceholder(value, decimals = 2, signed = false) {
  return hasNumericValue(value) ? formatPct(value, decimals, signed) : "--";
}

function formatPct(value, decimals = 2, signed = false) {
  const number = asPercent(value);
  const sign = signed && number >= 0 ? "+" : "";
  return `${sign}${number.toFixed(decimals)}%`;
}

function cleanUiText(value) {
  return String(value ?? "")
    .replaceAll("\u00e2\u2020\u2019", "→")
    .replaceAll("\u00e2\u0153\u201c", "✓")
    .replaceAll("\u00c2\u00b7", "·");
}

function escapeHtml(value) {
  return cleanUiText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderTopBar(topBar = {}) {
  const healthItems = qsa(".health-item");
  setText("strong", topBar.system_health || "Loading…", healthItems[0]);
  setText("strong", topBar.data_status || "Loading…", healthItems[1]);
  setText("#clock", topBar.last_update || "--:--:--");

  const cards = qsa(".portfolio-strip article");
  const values = [
    {
      strong: formatInrOrPlaceholder(topBar.portfolio_value),
      small: hasNumericValue(topBar.portfolio_value) ? "Market Value" : "Loading…",
      sign: null,
    },
    {
      strong: formatSignedInrOrPlaceholder(topBar.day_pnl),
      small: formatPctOrPlaceholder(topBar.day_pnl_pct, 2, true),
      sign: topBar.day_pnl,
    },
    {
      strong: formatSignedInrOrPlaceholder(topBar.total_pnl),
      small: formatPctOrPlaceholder(topBar.total_pnl_pct, 2, true),
      sign: topBar.total_pnl,
    },
    {
      strong: formatPctOrPlaceholder(topBar.current_drawdown, 2, false),
      small: hasNumericValue(topBar.current_drawdown) ? "From Peak" : "Loading…",
      sign: -1,
    },
    {
      strong: topBar.pdd_state || "Loading…",
      small: topBar.pdd_rule || "--",
      pill: true,
    },
    {
      strong: topBar.market_regime || "Loading…",
      small: hasNumericValue(topBar.breadth) ? `Breadth ${formatPct(topBar.breadth, 0, false)}` : "Breadth --",
      pill: true,
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
    if (value.pill && strong) {
      strong.classList.add("status-pill");
    }
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

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function compactDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatAgeSeconds(value) {
  if (value === null || value === undefined || value === "") return "--";
  const seconds = Math.max(0, Number(value || 0));
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function notificationCount(summary = {}, channel, status) {
  const counts = summary.counts || {};
  return Number(counts[channel]?.[status] || 0);
}

function notificationTotalByStatus(summary = {}, status) {
  const counts = summary.counts || {};
  return Object.values(counts).reduce((total, channelCounts) => total + Number(channelCounts?.[status] || 0), 0);
}

function ensureNotificationBadge() {
  const alertsLink = qsa(".nav-menu a").find((link) => (link.dataset.hash || "").toLowerCase() === "#alerts" || link.textContent.toLowerCase().includes("alerts"));
  if (!alertsLink) return null;
  let badge = qs("#notificationBadge", alertsLink);
  if (!badge) {
    badge = document.createElement("em");
    badge.className = "nav-badge";
    badge.id = "notificationBadge";
    badge.hidden = true;
    alertsLink.appendChild(badge);
  }
  return badge;
}

function updateNotificationBadge(summary = {}) {
  const badge = ensureNotificationBadge();
  if (!badge) return;
  const failed = notificationTotalByStatus(summary, "failed");
  badge.textContent = failed > 99 ? "99+" : String(failed);
  badge.hidden = failed === 0;
}

function notificationMatchesFilter(row, filter) {
  if (filter === "all") return true;
  const level = String(row.level || "").toLowerCase();
  const status = String(row.status || "").toLowerCase();
  const eventType = String(row.event_type || "").toLowerCase();
  const channel = String(row.channel || "").toLowerCase();
  if (filter === "warnings") return ["warning", "warn", "critical"].includes(level) || status === "failed";
  if (filter === "failed") return status === "failed";
  if (filter === "scanner") return eventType.includes("scanner");
  if (filter === "dhan") return eventType.includes("dhan");
  if (filter === "rebalance") return eventType.includes("rebalance");
  if (filter === "telegram") return channel === "telegram";
  return true;
}

function notificationTone(value) {
  const normalized = String(value || "").toLowerCase();
  if (["healthy", "enabled", "configured", "delivered", "clear", "ok", "ready"].includes(normalized)) return "ok";
  if (["disabled", "skipped", "warning", "warn", "check", "missing config"].includes(normalized)) return "warn";
  if (["failed", "critical", "danger", "error"].includes(normalized)) return "danger";
  return "muted";
}

function notificationTelegramState(status = {}) {
  if (!status.telegram_enabled) return { label: "DISABLED", detail: "Telegram alerts disabled", tone: "warn" };
  if (!status.telegram_configured) return { label: "MISSING", detail: "Bot token/chat id missing", tone: "danger" };
  return { label: "ENABLED", detail: "Bot + chat configured", tone: "ok" };
}

function renderNotificationStats(status = {}, notifications = []) {
  const summary = status.summary || {};
  const stats = qsa("#notificationStats .notification-stat");
  const appDelivered = notificationCount(summary, "app", "delivered");
  const telegramDelivered = notificationCount(summary, "telegram", "delivered");
  const failed = notificationTotalByStatus(summary, "failed");
  const skipped = notificationTotalByStatus(summary, "skipped");
  const failedSkipped =
    failed + skipped;
  const latest = summary.latest || notifications[0] || null;
  const telegram = notificationTelegramState(status);
  const pipelineHealthy = Boolean(status.app_enabled) && telegram.tone !== "danger" && failed === 0;
  const values = [
    {
      tone: pipelineHealthy ? "ok" : failed ? "danger" : "warn",
      value: pipelineHealthy ? "HEALTHY" : "CHECK",
      detail: `App ${status.app_enabled ? "on" : "off"} · ${appDelivered} local`,
    },
    {
      tone: telegram.tone,
      value: telegram.label,
      detail: `${telegramDelivered} delivered`,
    },
    {
      tone: failed ? "danger" : skipped ? "warn" : "ok",
      value: formatQty(failedSkipped),
      detail: failed ? `${failed} failed` : skipped ? `${skipped} skipped` : "Clear",
    },
    {
      tone: latest ? notificationTone(latest.status || latest.level) : "muted",
      value: latest ? compactDateTime(latest.created_at) : "--",
      detail: latest ? `${latest.channel || "app"} / ${latest.status || "--"}` : "No alerts yet",
    },
  ];
  values.forEach((item, index) => {
    const stat = stats[index];
    if (!stat) return;
    stat.className = `notification-stat ${item.tone || "muted"}`;
    setText("strong", item.value, stat);
    setText("small", item.detail, stat);
  });
  updateNotificationBadge(summary);
}

function notificationRowClass(row) {
  const status = String(row.status || "").toLowerCase();
  const level = String(row.level || "").toLowerCase();
  if (status === "failed") return "failed";
  if (["warning", "warn", "critical"].includes(level)) return "warning";
  if (status === "skipped") return "skipped";
  if (status === "delivered") return "delivered";
  return "info";
}

function renderNotificationHealth(status = {}, notifications = []) {
  const summary = status.summary || {};
  const counts = summary.counts || {};
  const appDelivered = notificationCount(summary, "app", "delivered");
  const telegramDelivered = notificationCount(summary, "telegram", "delivered");
  const failed = notificationTotalByStatus(summary, "failed");
  const skipped = notificationTotalByStatus(summary, "skipped");
  const telegram = notificationTelegramState(status);
  const pipelineHealthy = Boolean(status.app_enabled) && telegram.tone !== "danger" && failed === 0;
  const pill = qs("#notificationHealthPill");
  if (pill) {
    pill.textContent = pipelineHealthy ? "HEALTHY" : failed ? "FAILED" : "CHECK";
    pill.className = `safe-lock ${pipelineHealthy ? "ok" : failed ? "danger" : "warn"}`;
  }

  const storedEvents = Object.values(counts).reduce((total, channelCounts) => {
    if (typeof channelCounts === "number") return total + channelCounts;
    return total + Object.values(channelCounts || {}).reduce((inner, count) => inner + Number(count || 0), 0);
  }, 0);
  const rows = [
    { label: "App channel", value: status.app_enabled ? "enabled" : "disabled", detail: `${appDelivered} delivered`, tone: status.app_enabled ? "ok" : "warn" },
    { label: "Telegram channel", value: telegram.label, detail: telegram.detail, tone: telegram.tone },
    { label: "Telegram delivered", value: formatQty(telegramDelivered), detail: "External sends", tone: telegramDelivered ? "ok" : telegram.tone },
    { label: "Failed alerts", value: formatQty(failed), detail: failed ? "Needs review" : "No failures", tone: failed ? "danger" : "ok" },
    { label: "Skipped alerts", value: formatQty(skipped), detail: skipped ? "Usually disabled channel" : "None skipped", tone: skipped ? "warn" : "ok" },
    { label: "Stored events", value: formatQty(storedEvents), detail: "Notification DB", tone: "info" },
  ];
  const healthTarget = qs("#notificationHealthRows");
  if (healthTarget) {
    healthTarget.innerHTML = rows
      .map(
        (row) => `
          <div class="notification-health-row ${row.tone}">
            <span>${escapeHtml(row.label)}</span>
            <strong>${escapeHtml(row.value)}</strong>
            <em>${escapeHtml(row.detail)}</em>
          </div>
        `,
      )
      .join("");
  }

  const latestTarget = qs("#notificationLatestRows");
  if (latestTarget) {
    const latestRows = notifications.slice(0, 5);
    latestTarget.innerHTML = `
      <h4>Latest Alert Pulse</h4>
      ${
        latestRows.length
          ? latestRows
              .map(
                (row) => `
                  <div class="notification-pulse-row ${notificationRowClass(row)}">
                    <strong>${escapeHtml(row.title || "Trading OS alert")}</strong>
                    <span>${escapeHtml(row.channel || "app")} · ${escapeHtml(row.status || "--")}</span>
                    <em>${compactDateTime(row.created_at)}</em>
                  </div>
                `,
              )
              .join("")
          : `<div class="notification-empty compact">No recent alert pulse yet.</div>`
      }
    `;
  }
}

function renderNotificationRows(notifications = []) {
  const target = qs("#notificationRows");
  if (!target) return;
  const filtered = notifications.filter((row) => notificationMatchesFilter(row, notificationFilter));
  const count = qs("#notificationCount");
  if (count) {
    count.textContent = `Showing ${filtered.length} of ${notifications.length} stored notifications`;
  }
  qsa(".notification-filters button").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === notificationFilter);
  });
  if (!filtered.length) {
    target.innerHTML = `
      <div class="notification-empty">
        <strong>No notifications for this filter yet.</strong>
        <span>Scanner, Dhan sync, paper rebalance, and Telegram alerts will appear here automatically.</span>
      </div>
    `;
    return;
  }
  target.innerHTML = filtered
    .map((row) => {
      const rowClass = notificationRowClass(row);
      const level = String(row.level || "info").toUpperCase();
      const channel = String(row.channel || "app").toUpperCase();
      const status = String(row.status || "--").toUpperCase();
      return `
        <article class="notification-row ${rowClass}">
          <span class="notification-dot" aria-hidden="true"></span>
          <div class="notification-main">
            <div class="notification-row-head">
              <strong>${escapeHtml(row.title || "Trading OS alert")}</strong>
              <span class="notification-pill">${escapeHtml(level)}</span>
              <span class="notification-channel">${escapeHtml(channel)}</span>
            </div>
            <p>${escapeHtml(row.message || "")}</p>
            <div class="notification-meta">
              <span>${escapeHtml(row.event_type || "manual_alert")}</span>
              <span>#${escapeHtml(row.id || "--")}</span>
            </div>
          </div>
          <div class="notification-side">
            <strong>${escapeHtml(status)}</strong>
            <small>Created ${formatDateTime(row.created_at)}</small>
            <small>${row.delivered_at ? `Delivered ${formatDateTime(row.delivered_at)}` : "No delivery timestamp"}</small>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderNotificationCenter(payload = {}) {
  notificationStatus = payload.status || {};
  notificationCache = payload.notifications || [];
  renderNotificationStats(notificationStatus, notificationCache);
  renderNotificationHealth(notificationStatus, notificationCache);
  renderNotificationRows(notificationCache);
}

function renderNotificationError(message) {
  const target = qs("#notificationRows");
  if (!target) return;
  target.innerHTML = `
    <div class="notification-empty error">
      <strong>Notification API is unavailable.</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  const healthTarget = qs("#notificationHealthRows");
  if (healthTarget) {
    healthTarget.innerHTML = `
      <div class="notification-empty compact error">
        <strong>Alert health unavailable.</strong>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  }
}

async function refreshNotifications() {
  if (notificationRefreshInFlight) return;
  notificationRefreshInFlight = true;
  const button = qs("#refreshNotificationsData");
  const originalText = button?.textContent || "Refresh Alerts";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  try {
    const response = await fetch("/api/notifications?limit=100", { cache: "no-store" });
    if (!response.ok) throw new Error(`Notification API returned ${response.status}`);
    const payload = await response.json();
    renderNotificationCenter(payload);
  } catch (error) {
    console.error(error);
    renderNotificationError(error.message || "Unable to load notification history.");
  } finally {
    notificationRefreshInFlight = false;
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function navTargetFor(link) {
  if (link.dataset.view) return link.dataset.view;
  const label = link.textContent.toLowerCase();
  if (label.includes("logs") || label.includes("alerts")) return "notifications";
  if (label.includes("portfolio") || label.includes("holdings")) return "reconciliation";
  if (label.includes("strategy")) return "operations";
  if (label.includes("settings")) return "settings";
  if (label.includes("reports")) return "audit";
  return "dashboard";
}

function navHashFor(target, link = null) {
  if (link?.dataset?.hash) return link.dataset.hash;
  if (target === "notifications") return "#alerts";
  if (target === "reconciliation") return "#portfolio";
  if (target === "operations") return "#strategy";
  if (target === "settings") return "#settings";
  if (target === "dryrun") return "#actions";
  if (target === "audit") return "#reports";
  return "#dashboard";
}

function canonicalNavHash(hash = window.location.hash) {
  if (["#alerts", "#logs", "#notifications"].includes(hash)) return "#alerts";
  if (["#portfolio", "#holdings", "#reconciliation"].includes(hash)) return "#portfolio";
  if (["#settings"].includes(hash)) return "#settings";
  if (["#strategy", "#operations"].includes(hash)) return "#strategy";
  if (["#actions", "#orders", "#trades", "#dry-run"].includes(hash)) return "#actions";
  if (["#reports", "#audit"].includes(hash)) return "#reports";
  return "#dashboard";
}

function viewFromHash() {
  if (["#alerts", "#logs", "#notifications"].includes(window.location.hash)) return "notifications";
  if (["#portfolio", "#holdings", "#reconciliation"].includes(window.location.hash)) return "reconciliation";
  if (["#strategy", "#operations"].includes(window.location.hash)) return "operations";
  if (["#settings"].includes(window.location.hash)) return "settings";
  if (["#actions", "#orders", "#trades", "#dry-run"].includes(window.location.hash)) return "dryrun";
  if (["#reports", "#audit"].includes(window.location.hash)) return "audit";
  return "dashboard";
}

function setView(view, activeLink = null) {
  currentView = ["dashboard", "notifications", "operations", "settings", "audit", "reconciliation", "dryrun"].includes(view) ? view : "dashboard";
  qs("#dashboardView")?.classList.toggle("is-hidden", currentView !== "dashboard");
  qs("#reconciliationView")?.classList.toggle("is-hidden", currentView !== "reconciliation");
  qs("#notificationView")?.classList.toggle("is-hidden", currentView !== "notifications");
  qs("#operationsView")?.classList.toggle("is-hidden", currentView !== "operations");
  qs("#settingsView")?.classList.toggle("is-hidden", currentView !== "settings");
  qs("#dryRunView")?.classList.toggle("is-hidden", currentView !== "dryrun");
  qs("#auditView")?.classList.toggle("is-hidden", currentView !== "audit");
  const activeHash = canonicalNavHash();
  qsa(".nav-menu a").forEach((link) => {
    const shouldActivate = activeLink ? link === activeLink : link.dataset.hash === activeHash;
    link.classList.toggle("active", shouldActivate);
  });
  if (currentView === "reconciliation") {
    refreshReconciliation();
  }
  if (currentView === "notifications") {
    refreshNotifications();
  }
  if (currentView === "operations") {
    refreshOperations();
  }
  if (currentView === "settings") {
    refreshOperations();
  }
  if (currentView === "audit") {
    refreshAudit();
  }
  if (currentView === "dryrun") {
    refreshDryRun();
  }
}

function setupNavigation() {
  ensureNotificationBadge();
  qsa(".nav-menu a").forEach((link) => {
    const target = navTargetFor(link);
    link.dataset.view = target;
    link.dataset.hash = link.dataset.hash || navHashFor(target, link);
    link.href = link.dataset.hash;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const hash = navHashFor(target, link);
      if (window.location.hash !== hash) {
        history.pushState(null, "", hash);
      }
      setView(target, link);
    });
  });
  window.addEventListener("popstate", () => {
    setView(viewFromHash());
  });
  setView(viewFromHash());
}

function setupNotificationFilters() {
  qsa(".notification-filters button").forEach((button) => {
    button.addEventListener("click", () => {
      notificationFilter = button.dataset.filter || "all";
      renderNotificationRows(notificationCache);
    });
  });
}

async function sendTestAlert() {
  const button = qs("#sendTestAlert");
  const originalText = button?.textContent || "Send Test Telegram Alert";
  if (button) {
    button.disabled = true;
    button.textContent = "Sending...";
  }
  try {
    const response = await fetch("/api/notifications/test", { method: "POST" });
    if (!response.ok) throw new Error(`Test alert failed with ${response.status}`);
    if (button) button.textContent = "Sent";
    await refreshNotifications();
  } catch (error) {
    console.error(error);
    if (button) button.textContent = "Failed";
    renderNotificationError(error.message || "Unable to send test alert.");
  } finally {
    window.setTimeout(() => {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }, 1800);
  }
}

async function safeJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error || payload?.message || `${url} returned ${response.status}`;
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function settledPayload(results, key) {
  const result = results[key];
  if (!result) return { ok: false, error: "Not requested" };
  if (result.status === "fulfilled") return result.value;
  return { ok: false, error: result.reason?.message || "Unavailable" };
}

function toneFromOk(ok, warn = false) {
  if (warn) return "warn";
  return ok ? "ok" : "danger";
}

function controlPillText(value) {
  return String(value ?? "--").replaceAll("_", " ").toUpperCase();
}

function renderControlStats(data = controlState) {
  const cards = qsa("#controlStats .control-stat");
  const dhan = data.dhan || {};
  const scanner = data.scanner || {};
  const orderPlan = data.orderPlan || {};
  const tasks = data.tasks || {};
  const plan = orderPlan.plan || {};
  const diagnostics = scanner.ranking_diagnostics || {};
  const coverage = Number(diagnostics.required_history_coverage || 0);
  const scannerFailures = Number(scanner.sync?.failure_count || 0);
  const rebalance = orderPlan.rebalance_status || {};
  const regime = scanner.regime || {};
  const targetSymbols = plan.target_symbols || [];
  const strategyMode = regime.risk_on ? "RISK ON" : "DEFENSIVE";
  const safetyOk = dhan.order_placement === "blocked" && (dhan.mode || orderPlan.mode) === "paper";

  const values = [
    {
      tone: regime.risk_on ? "ok" : "warn",
      strong: strategyMode,
      small: targetSymbols.length ? `Target ${targetSymbols.join(", ")}` : "Strategy target loading",
    },
    {
      tone: regime.risk_on ? "ok" : "warn",
      strong: regime.state || "--",
      small: regime.reason || "Market regime",
    },
    {
      tone: toneFromOk(Boolean(scanner.ok), scanner.status === "partial_coverage" || scannerFailures > 0),
      strong: controlPillText(scanner.status || "--"),
      small: coverage ? `Coverage ${(coverage * 100).toFixed(2)}%` : scanner.error || "Scanner status",
    },
    {
      tone: rebalance.allowed ? "ok" : "warn",
      strong: rebalance.allowed ? "OPEN" : "BLOCKED",
      small: rebalance.first_trading_day ? `First day ${rebalance.first_trading_day}` : rebalance.reason || "Monthly gate",
    },
    {
      tone: safetyOk ? "ok" : "danger",
      strong: safetyOk ? "READ ONLY" : "CHECK",
      small: tasks.ok ? "Scheduler installed; live orders blocked" : tasks.error || "Live orders blocked",
    },
  ];

  values.forEach((item, index) => {
    const card = cards[index];
    if (!card) return;
    card.className = `control-stat ${item.tone}`;
    setText("strong", item.strong, card);
    setText("small", item.small, card);
  });
}

function kvRows(rows = []) {
  return rows
    .map((row) => {
      const tone = row.tone ? ` ${row.tone}` : "";
      return `
        <div class="control-kv-row${tone}">
          <span>${escapeHtml(row.label)}</span>
          <strong>${escapeHtml(row.value ?? "--")}</strong>
        </div>
      `;
    })
    .join("");
}

function renderControlDetails(data = controlState) {
  const token = data.token || {};
  const dhan = data.dhan || {};
  const dhanCache = dhan.cache || {};
  const scanner = data.scanner || {};
  const orderPlan = data.orderPlan || {};
  const holidays = data.holidays || {};
  const rebalance = orderPlan.rebalance_status || {};
  const plan = orderPlan.plan || {};
  const portfolio = orderPlan.portfolio || {};
  const diagnostics = scanner.ranking_diagnostics || {};
  const sync = scanner.sync || {};
  const regime = scanner.regime || {};
  const targetSymbols = plan.target_symbols || [];
  const retainSymbols = plan.retain_symbols || [];

  const strategyRows = [
    { label: "Strategy", value: "Strategy 4 | Top 8 / Hold Top 13", tone: "info" },
    { label: "Ranking signal", value: "Monthly ROC(12), high to low", tone: "info" },
    { label: "Universe", value: diagnostics.total_strategy_universe || scanner.universe_count || "--", tone: "info" },
    { label: "Risk overlay", value: "PDD 16% / 7% + Gold sleeve", tone: "info" },
    { label: "Market regime", value: regime.state || "--", tone: regime.risk_on ? "ok" : "warn" },
    { label: "Regime reason", value: regime.reason || "--", tone: regime.risk_on ? "ok" : "warn" },
    { label: "Current target", value: targetSymbols.join(", ") || "--", tone: targetSymbols.includes("GOLDBEES") ? "warn" : "ok" },
    { label: "Retain list", value: retainSymbols.join(", ") || "--", tone: "info" },
    { label: "Execution rule", value: "First trading day of each month", tone: "info" },
  ];
  const strategyRuleTarget = qs("#strategyRuleDetails");
  if (strategyRuleTarget) strategyRuleTarget.innerHTML = kvRows(strategyRows);

  const dhanRows = [
    { label: "Mode", value: dhan.mode || orderPlan.mode || "paper", tone: "info" },
    { label: "Order placement", value: dhan.order_placement || "blocked", tone: dhan.order_placement === "blocked" ? "ok" : "danger" },
    { label: "Read-only guard", value: dhan.read_only_guard || "unknown", tone: dhan.read_only_guard === "enabled" ? "ok" : "warn" },
    { label: "Broker cache", value: dhanCache.status || "missing", tone: dhanCache.stale ? "warn" : "ok" },
    { label: "Cache age", value: dhanCache.age_seconds !== undefined ? formatAgeSeconds(dhanCache.age_seconds) : "--", tone: dhanCache.stale ? "warn" : "ok" },
    { label: "Cache timestamp", value: dhanCache.generated_at ? formatDateTime(dhanCache.generated_at) : "--", tone: dhanCache.available ? "ok" : "warn" },
    { label: "Token source", value: token.source || "--", tone: token.ok ? "ok" : "warn" },
    { label: "Managed token", value: token.managed_token_present ? "present" : "not present", tone: token.managed_token_present ? "ok" : "warn" },
    { label: "TOTP automation", value: token.totp_generation_possible ? "ready" : "not configured", tone: token.totp_generation_possible ? "ok" : "warn" },
    { label: "Token expiry", value: token.managed_token_expiry ? formatDateTime(token.managed_token_expiry) : "--", tone: token.managed_token_expiring_soon ? "warn" : "ok" },
  ];
  qs("#dhanControlDetails").innerHTML = kvRows(dhanRows);

  const scannerRows = [
    { label: "Latest run", value: scanner.run_id ? `#${scanner.run_id}` : "--", tone: scanner.run_id ? "ok" : "warn" },
    { label: "Status", value: scanner.status || scanner.error || "--", tone: scanner.ok ? "ok" : "warn" },
    { label: "As-of month", value: scanner.as_of_month || diagnostics.as_of_month || "--", tone: "info" },
    { label: "Coverage", value: diagnostics.required_history_coverage ? `${(Number(diagnostics.required_history_coverage) * 100).toFixed(2)}%` : "--", tone: scanner.ok ? "ok" : "warn" },
    { label: "Universe", value: diagnostics.total_strategy_universe || scanner.universe_count || "--", tone: "info" },
    { label: "Sync failures", value: sync.failure_count ?? "--", tone: Number(sync.failure_count || 0) ? "warn" : "ok" },
    { label: "Regime", value: scanner.regime?.state || "--", tone: scanner.regime?.risk_on ? "ok" : "warn" },
  ];
  qs("#scannerControlDetails").innerHTML = kvRows(scannerRows);
  renderScannerMiniRanks(scanner.rankings || []);

  const rebalanceRows = [
    { label: "Frequency", value: rebalance.frequency || "monthly", tone: "info" },
    { label: "Today", value: rebalance.today || "--", tone: "info" },
    { label: "First trading day", value: rebalance.first_trading_day || "--", tone: rebalance.allowed ? "ok" : "warn" },
    { label: "Gate", value: rebalance.allowed ? "allowed" : "blocked", tone: rebalance.allowed ? "ok" : "warn" },
    { label: "Reason", value: rebalance.reason || "Ready", tone: rebalance.allowed ? "ok" : "warn" },
    { label: "Target sleeves", value: (plan.target_symbols || []).join(", ") || "--", tone: "info" },
    { label: "Orders planned", value: plan.summary ? `${plan.summary.buy_count || 0} buys / ${plan.summary.sell_count || 0} sells` : "--", tone: "info" },
    { label: "Portfolio equity", value: portfolio.equity ? formatInr(portfolio.equity) : "--", tone: "info" },
  ];
  qs("#rebalanceControlDetails").innerHTML = kvRows(rebalanceRows);
  const rebalanceButton = qs("#runPaperRebalance");
  if (rebalanceButton) {
    rebalanceButton.disabled = !rebalance.allowed || (dhan.order_placement && dhan.order_placement !== "blocked");
    rebalanceButton.textContent = rebalance.allowed ? "Run Paper Rebalance" : "Blocked Until First Trading Day";
  }

  renderControlPills(scanner, rebalance, data.tasks || {});
  renderTaskRows(data.tasks || {});
  renderSafetyChecklist({ token, dhan, scanner, holidays, orderPlan });
}

function renderControlPills(scanner = {}, rebalance = {}, tasks = {}) {
  const rulePill = qs("#strategyRulePill");
  if (rulePill) {
    const riskOn = Boolean(scanner.regime?.risk_on);
    rulePill.className = `safe-lock ${riskOn ? "ok" : "warn"}`;
    rulePill.textContent = riskOn ? "RISK ON" : "DEFENSIVE";
  }
  const scannerPill = qs("#scannerStatusPill");
  if (scannerPill) {
    const warn = scanner.status === "partial_coverage" || Number(scanner.sync?.failure_count || 0) > 0;
    scannerPill.className = `safe-lock ${toneFromOk(Boolean(scanner.ok), warn)}`;
    scannerPill.textContent = controlPillText(scanner.status || "unknown");
  }
  const rebalancePill = qs("#rebalanceStatusPill");
  if (rebalancePill) {
    rebalancePill.className = `safe-lock ${rebalance.allowed ? "ok" : "warn"}`;
    rebalancePill.textContent = rebalance.allowed ? "ALLOWED" : "BLOCKED";
  }
  const schedulerPill = qs("#schedulerStatusPill");
  if (schedulerPill) {
    schedulerPill.className = `safe-lock ${tasks.ok ? "ok" : "warn"}`;
    schedulerPill.textContent = tasks.ok ? "INSTALLED" : "CHECK";
  }
}

function renderScannerMiniRanks(rankings = []) {
  const target = qs("#scannerMiniRanks");
  if (!target) return;
  const rows = rankings.slice(0, 5);
  if (!rows.length) {
    target.innerHTML = `<div class="control-empty">No latest scanner rankings available yet.</div>`;
    return;
  }
  target.innerHTML = `
    <h4>Current Top ROC Snapshot</h4>
    ${rows
      .map(
        (row) => `
          <div class="mini-rank-row">
            <span>#${escapeHtml(row.rank)}</span>
            <strong>${escapeHtml(row.symbol)}</strong>
            <em>${formatPct(row.roc_12, 2)}</em>
          </div>
        `,
      )
      .join("")}
  `;
}

function renderTaskRows(tasksPayload = {}) {
  const target = qs("#taskStatusRows");
  if (!target) return;
  const tasks = tasksPayload.tasks || [];
  if (!tasks.length) {
    target.innerHTML = `<div class="control-empty">Task status endpoint is unavailable until the local server is restarted.</div>`;
    return;
  }
  target.innerHTML = tasks
    .map((task) => {
      const tone = task.installed ? "ok" : "warn";
      return `
        <article class="task-row ${tone}">
          <div>
            <strong>${escapeHtml(task.name)}</strong>
            <span>${escapeHtml(task.status || (task.installed ? "installed" : "missing"))}</span>
          </div>
          <small>Next: ${escapeHtml(task.next_run_time || "--")}</small>
          <small>Last: ${escapeHtml(task.last_run_time || "--")}</small>
        </article>
      `;
    })
    .join("");
}

function renderSafetyChecklist({ token = {}, dhan = {}, scanner = {}, holidays = {}, orderPlan = {} } = {}) {
  const target = qs("#safetyChecklist");
  if (!target) return;
  const dhanCache = dhan.cache || {};
  const checks = [
    { label: "App mode is paper", ok: (dhan.mode || orderPlan.mode) === "paper" },
    { label: "Live order placement blocked", ok: dhan.order_placement === "blocked" },
    { label: "Dhan token available", ok: Boolean(token.ok) },
    { label: "Cached broker snapshot available", ok: Boolean(dhanCache.available) },
    { label: "Broker snapshot fresh", ok: Boolean(dhanCache.available) && !dhanCache.stale },
    { label: "Latest scanner data present", ok: Boolean(scanner.run_id || scanner.rankings?.length) },
    { label: "NSE holiday calendar reachable", ok: holidays.ok !== false },
  ];
  target.innerHTML = checks
    .map(
      (check) => `
        <div class="safety-row ${check.ok ? "ok" : "warn"}">
          <span>${check.ok ? "✓" : "!"}</span>
          <strong>${escapeHtml(check.label)}</strong>
        </div>
      `,
    )
    .join("");
}

function settingsPill(selector, label, tone = "muted") {
  const pill = qs(selector);
  if (!pill) return;
  pill.textContent = String(label || "--").toUpperCase();
  pill.className = `safe-lock ${tone}`;
}

function settingsRows(rows = []) {
  return rows
    .map(
      (row) => `
        <div class="settings-kv-row ${row.tone || "info"}">
          <span>${escapeHtml(row.label)}</span>
          <strong>${escapeHtml(row.value ?? "--")}</strong>
        </div>
      `,
    )
    .join("");
}

function settingsSummary(data = controlState) {
  const token = data.token || {};
  const dhan = data.dhan || {};
  const orderPlan = data.orderPlan || {};
  const notifications = data.notifications || {};
  const notificationStatus = notifications.status || {};
  const notificationSummary = notificationStatus.summary || {};
  const tasks = data.tasks || {};
  const dhanCache = dhan.cache || {};
  const mode = dhan.mode || orderPlan.mode || "paper";
  const orderBlocked = String(dhan.order_placement || "blocked").toLowerCase() === "blocked";
  const telegramReady = Boolean(notificationStatus.telegram_enabled && notificationStatus.telegram_configured);
  const taskInstalled = Number(tasks.installed_count || 0);
  const taskExpected = Number(tasks.expected_count || 0);
  return { token, dhan, orderPlan, notifications, notificationStatus, notificationSummary, tasks, dhanCache, mode, orderBlocked, telegramReady, taskInstalled, taskExpected };
}

function renderSettingsStats(data = controlState) {
  const { token, dhan, notificationSummary, tasks, mode, orderBlocked, telegramReady, taskInstalled, taskExpected } = settingsSummary(data);
  const cards = qsa("#settingsStats .settings-stat");
  const delivered = notificationTotalByStatus(notificationSummary, "delivered");
  const values = [
    {
      tone: mode === "paper" ? "ok" : "danger",
      strong: mode.toUpperCase(),
      small: mode === "paper" ? "Paper testing mode" : "Review before live use",
    },
    {
      tone: orderBlocked ? "ok" : "danger",
      strong: orderBlocked ? "BLOCKED" : "LIVE",
      small: dhan.read_only_guard ? `Read-only guard ${dhan.read_only_guard}` : "Order placement guard",
    },
    {
      tone: token.ok ? "ok" : "warn",
      strong: token.ok ? "READY" : "CHECK",
      small: token.managed_token_expiry ? `Expires ${compactDateTime(token.managed_token_expiry)}` : token.source || "Token state",
    },
    {
      tone: telegramReady ? "ok" : "warn",
      strong: telegramReady ? "ENABLED" : "CHECK",
      small: `${delivered} delivered alerts`,
    },
    {
      tone: taskExpected && taskInstalled >= taskExpected ? "ok" : "warn",
      strong: taskExpected ? `${taskInstalled}/${taskExpected}` : `${taskInstalled}`,
      small: tasks.ok ? "Scheduled tasks installed" : tasks.error || "Task status",
    },
  ];
  values.forEach((item, index) => {
    const card = cards[index];
    if (!card) return;
    card.className = `settings-stat ${item.tone}`;
    setText("strong", item.strong, card);
    setText("small", item.small, card);
  });
}

function renderSettingsMode(data = controlState) {
  const { dhan, orderPlan, mode, orderBlocked } = settingsSummary(data);
  const rebalance = orderPlan.rebalance_status || {};
  settingsPill("#settingsModePill", mode === "paper" && orderBlocked ? "SAFE" : "CHECK", mode === "paper" && orderBlocked ? "ok" : "danger");
  const target = qs("#settingsModeRows");
  if (!target) return;
  target.innerHTML = settingsRows([
    { label: "Environment mode", value: mode.toUpperCase(), tone: mode === "paper" ? "ok" : "danger" },
    { label: "Auto execution", value: dhan.auto_execution_enabled ? "enabled" : "disabled", tone: dhan.auto_execution_enabled ? "danger" : "ok" },
    { label: "Order placement", value: dhan.order_placement || "blocked", tone: orderBlocked ? "ok" : "danger" },
    { label: "Read-only guard", value: dhan.read_only_guard || "--", tone: dhan.read_only_guard === "enabled" ? "ok" : "warn" },
    { label: "Rebalance frequency", value: rebalance.frequency || "monthly", tone: "info" },
    { label: "Execution rule", value: rebalance.rule || "first trading day of execution month", tone: "info" },
    { label: "Current gate", value: rebalance.allowed ? "open" : "blocked", tone: rebalance.allowed ? "warn" : "ok" },
    { label: "Gate reason", value: rebalance.reason || "--", tone: rebalance.allowed ? "warn" : "info" },
  ]);
}

function renderSettingsDhan(data = controlState) {
  const { token, dhan, dhanCache } = settingsSummary(data);
  const tokenReady = Boolean(token.ok && token.client_id_present && (token.managed_token_present || token.env_token_present));
  settingsPill("#settingsDhanPill", tokenReady && dhan.ok ? "CONNECTED" : "CHECK", tokenReady && dhan.ok ? "ok" : "warn");
  const target = qs("#settingsDhanRows");
  if (!target) return;
  target.innerHTML = settingsRows([
    { label: "Dhan status", value: dhan.message || (dhan.ok ? "connected" : dhan.error || "--"), tone: dhan.ok ? "ok" : "warn" },
    { label: "Token source", value: token.source || "--", tone: token.ok ? "ok" : "warn" },
    { label: "Client ID", value: token.client_id_present ? "present" : "missing", tone: token.client_id_present ? "ok" : "danger" },
    { label: "Managed token", value: token.managed_token_present ? "present" : "not present", tone: token.managed_token_present ? "ok" : "warn" },
    { label: "Renew possible", value: token.renew_possible ? "yes" : "no", tone: token.renew_possible ? "ok" : "warn" },
    { label: "TOTP automation", value: token.totp_generation_possible ? "ready" : "not configured", tone: token.totp_generation_possible ? "ok" : "warn" },
    { label: "Token expiry", value: token.managed_token_expiry ? formatDateTime(token.managed_token_expiry) : "--", tone: token.managed_token_expiring_soon ? "warn" : "ok" },
    { label: "Broker cache", value: dhanCache.status || "missing", tone: dhanCache.available && !dhanCache.stale ? "ok" : "warn" },
    { label: "Cache age", value: dhanCache.age_seconds !== undefined ? formatAgeSeconds(dhanCache.age_seconds) : "--", tone: dhanCache.stale ? "warn" : "ok" },
  ]);
}

function renderSettingsAlerts(data = controlState) {
  const { notifications, notificationStatus, notificationSummary, telegramReady } = settingsSummary(data);
  const failed = notificationTotalByStatus(notificationSummary, "failed");
  const skipped = notificationTotalByStatus(notificationSummary, "skipped");
  const delivered = notificationTotalByStatus(notificationSummary, "delivered");
  settingsPill("#settingsAlertPill", telegramReady ? "ENABLED" : "CHECK", telegramReady ? "ok" : "warn");
  const target = qs("#settingsAlertRows");
  if (target) {
    target.innerHTML = settingsRows([
      { label: "App alerts", value: notificationStatus.app_enabled ? "enabled" : "disabled", tone: notificationStatus.app_enabled ? "ok" : "warn" },
      { label: "Telegram enabled", value: notificationStatus.telegram_enabled ? "yes" : "no", tone: notificationStatus.telegram_enabled ? "ok" : "warn" },
      { label: "Bot token", value: notificationStatus.telegram_bot_token_present ? "present" : "missing", tone: notificationStatus.telegram_bot_token_present ? "ok" : "danger" },
      { label: "Chat ID", value: notificationStatus.telegram_chat_id_present ? "present" : "missing", tone: notificationStatus.telegram_chat_id_present ? "ok" : "danger" },
      { label: "Delivered", value: formatQty(delivered), tone: delivered ? "ok" : "warn" },
      { label: "Failed / skipped", value: `${failed} failed / ${skipped} skipped`, tone: failed ? "danger" : skipped ? "warn" : "ok" },
    ]);
  }
  const latestTarget = qs("#settingsLatestAlerts");
  if (!latestTarget) return;
  const latest = (notifications.notifications || []).slice(0, 4);
  latestTarget.innerHTML = `
    <h4>Latest Alerts</h4>
    ${
      latest.length
        ? latest
            .map(
              (row) => `
                <div class="settings-mini-row ${notificationRowClass(row)}">
                  <strong>${escapeHtml(row.title || "Trading OS alert")}</strong>
                  <span>${escapeHtml(row.channel || "app")} · ${escapeHtml(row.status || "--")}</span>
                  <em>${compactDateTime(row.created_at)}</em>
                </div>
              `,
            )
            .join("")
        : `<div class="settings-empty">No alert rows available yet.</div>`
    }
  `;
}

function renderSettingsTasks(data = controlState) {
  const { token, dhan, orderPlan, tasks, dhanCache } = settingsSummary(data);
  const taskRows = tasks.tasks || [];
  const taskOk = Boolean(tasks.ok || (tasks.expected_count && tasks.installed_count >= tasks.expected_count));
  settingsPill("#settingsTaskPill", taskOk ? "INSTALLED" : "CHECK", taskOk ? "ok" : "warn");
  const target = qs("#settingsTaskRows");
  if (target) {
    target.innerHTML = taskRows.length
      ? taskRows
          .map(
            (task) => `
              <article class="settings-task-row ${task.installed ? "ok" : "warn"}">
                <div>
                  <strong>${escapeHtml(task.name || "--")}</strong>
                  <span>${escapeHtml(task.schedule_type || "--")} · ${escapeHtml(task.status || "--")}</span>
                </div>
                <small>Next ${escapeHtml(task.next_run_time || "--")}</small>
                <small>Last ${escapeHtml(task.last_run_time || "--")}</small>
              </article>
            `,
          )
          .join("")
      : `<div class="settings-empty">No scheduled task rows available.</div>`;
  }
  const pathTarget = qs("#settingsPathRows");
  if (!pathTarget) return;
  const rebalance = orderPlan.rebalance_status || {};
  pathTarget.innerHTML = settingsRows([
    { label: "Token state", value: token.token_state_path || "--", tone: token.token_state_path ? "info" : "warn" },
    { label: "Broker snapshot", value: dhanCache.path || "--", tone: dhanCache.path ? "info" : "warn" },
    { label: "Holiday calendar", value: rebalance.holiday_calendar || "--", tone: rebalance.holiday_calendar ? "info" : "warn" },
    { label: "Dhan source", value: dhan.source || "--", tone: dhan.source ? "info" : "warn" },
  ]);
}

function renderSettingsCenter(data = controlState) {
  if (!qs("#settingsView")) return;
  renderSettingsStats(data);
  renderSettingsMode(data);
  renderSettingsDhan(data);
  renderSettingsAlerts(data);
  renderSettingsTasks(data);
}

function renderSettingsError(error) {
  const target = qs("#settingsModeRows");
  if (!target) return;
  target.innerHTML = `
    <div class="settings-empty error">
      <strong>Settings data unavailable.</strong>
      <span>${escapeHtml(error.message || "Unable to load runtime settings.")}</span>
    </div>
  `;
}

function renderControlCenter(data = controlState) {
  renderControlStats(data);
  renderControlDetails(data);
  renderSettingsCenter(data);
}

function renderControlError(error) {
  const target = qs("#dhanControlDetails");
  if (target) {
    target.innerHTML = `
      <div class="control-empty error">
        <strong>Control data unavailable.</strong>
        <span>${escapeHtml(error.message || "Unable to load operations status.")}</span>
      </div>
    `;
  }
  renderSettingsError(error);
}

async function refreshOperations(options = {}) {
  if (controlRefreshInFlight) return controlState;
  controlRefreshInFlight = true;
  const refreshButton = qs("#refreshControlData");
  const settingsRefreshButton = qs("#refreshSettingsData");
  const originalText = refreshButton?.textContent || "Refresh Strategy";
  const settingsOriginalText = settingsRefreshButton?.textContent || "Refresh Settings";
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing...";
  }
  if (settingsRefreshButton) {
    settingsRefreshButton.disabled = true;
    settingsRefreshButton.textContent = "Refreshing...";
  }
  try {
    const entries = await Promise.allSettled([
      safeJson(`/api/dhan/token/status${options.validateToken ? "?validate=true" : ""}`),
      safeJson("/api/dhan/broker-snapshot"),
      safeJson("/api/scanner/latest"),
      safeJson("/api/paper/order-plan"),
      safeJson("/api/market/holidays"),
      safeJson("/api/system/tasks"),
      safeJson("/api/notifications?limit=20"),
    ]);
    const keys = ["token", "dhan", "scanner", "orderPlan", "holidays", "tasks", "notifications"];
    controlState = Object.fromEntries(keys.map((key, index) => [key, settledPayload(entries, index)]));
    renderControlCenter(controlState);
    return controlState;
  } catch (error) {
    console.error(error);
    renderControlError(error);
    return controlState;
  } finally {
    controlRefreshInFlight = false;
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = originalText;
    }
    if (settingsRefreshButton) {
      settingsRefreshButton.disabled = false;
      settingsRefreshButton.textContent = settingsOriginalText;
    }
  }
}

async function runControlAction(buttonSelector, busyText, action) {
  const button = qs(buttonSelector);
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = busyText;
  }
  try {
    await action();
    await refreshOperations();
  } catch (error) {
    console.error(error);
    renderControlError(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function setupControlActions() {
  qs("#refreshControlData")?.addEventListener("click", () => refreshOperations());
  qs("#refreshSettingsData")?.addEventListener("click", () => refreshOperations());
  qs("#openNotificationsFromOps")?.addEventListener("click", () => {
    history.pushState(null, "", "#notifications");
    setView("notifications");
  });
  qs("#openReportsFromSettings")?.addEventListener("click", () => {
    history.pushState(null, "", "#reports");
    setView("audit");
  });
  qs("#openAlertsFromSettings")?.addEventListener("click", () => {
    history.pushState(null, "", "#alerts");
    setView("notifications");
  });
  qs("#validateDhanToken")?.addEventListener("click", () => refreshOperations({ validateToken: true }));
  qs("#refreshDhanToken")?.addEventListener("click", () =>
    runControlAction("#refreshDhanToken", "Refreshing...", () => safeJson("/api/dhan/token/refresh", { method: "POST" })),
  );
  qs("#syncHolidayCalendar")?.addEventListener("click", () =>
    runControlAction("#syncHolidayCalendar", "Syncing...", () => safeJson("/api/market/holidays/sync", { method: "POST" })),
  );
  qs("#runPaperRebalance")?.addEventListener("click", () =>
    runControlAction("#runPaperRebalance", "Running...", () =>
      safeJson("/api/paper/rebalance", {
        method: "POST",
        body: JSON.stringify({ force: false }),
      }),
    ),
  );
}

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

async function refreshReconciliation() {
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
    if (currentView === "operations") await refreshOperations();
    if (currentView === "settings") await refreshOperations();
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

function setupReconciliationActions() {
  qs("#refreshReconciliationData")?.addEventListener("click", () => refreshReconciliation());
  qs("#refreshBrokerSnapshot")?.addEventListener("click", () => refreshBrokerSnapshot());
  qs("#openAuditFromRecon")?.addEventListener("click", () => {
    history.pushState(null, "", "#audit");
    setView("audit");
  });
}

function dryRunTone(value) {
  const status = String(value || "").toLowerCase();
  if (["ready", "ok", "allowed", "fresh", "complete", "paper"].includes(status)) return "ok";
  if (["ready_with_warnings", "calendar_blocked", "blocked", "stale", "warning", "warn"].includes(status)) return "warn";
  if (["attention_required", "failed", "critical", "danger", "error"].includes(status)) return "danger";
  return "muted";
}

function dryRunPill(selector, label, tone = "muted") {
  const pill = qs(selector);
  if (!pill) return;
  pill.textContent = String(label || "--").replaceAll("_", " ").toUpperCase();
  pill.className = `safe-lock ${tone}`;
}

function dryRunActionLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "ready") return "READY";
  if (value === "ready_with_warnings") return "READY + WARNINGS";
  if (value === "calendar_blocked") return "WAITING";
  if (value === "attention_required") return "ATTENTION";
  return compactValue(status, "LOADING").replaceAll("_", " ").toUpperCase();
}

function dryRunGateLabel(value) {
  return String(value || "").toLowerCase() === "allowed" ? "OPEN" : "BLOCKED";
}

function renderDryRunStats(report = dryRunState) {
  const summary = report.summary || {};
  const rebalance = report.rebalance || {};
  const stats = qsa("#dryRunStats .audit-stat");
  const critical = Number(summary.critical_failure_count || 0);
  const warnings = Number(summary.warning_count || 0);
  const values = [
    {
      tone: dryRunTone(summary.status),
      strong: dryRunActionLabel(summary.status),
      small: report.generated_at ? `Generated ${compactDateTime(report.generated_at)}` : "Read-only report",
    },
    {
      tone: dryRunTone(summary.rebalance_gate),
      strong: dryRunGateLabel(summary.rebalance_gate),
      small: rebalance.reason || rebalance.first_trading_day || "Monthly gate",
    },
    {
      tone: Number(summary.planned_order_count || 0) ? "warn" : "ok",
      strong: formatQty(summary.planned_order_count || 0),
      small: `${summary.planned_buy_count || 0} buy / ${summary.planned_sell_count || 0} sell`,
    },
    {
      tone: critical ? "danger" : warnings ? "warn" : "ok",
      strong: critical ? `${critical} critical` : warnings ? `${warnings} warning` : "CLEAR",
      small: "Live orders blocked",
    },
    {
      tone: dryRunTone(summary.broker_cache_status),
      strong: compactValue(summary.broker_cache_status, "missing").toUpperCase(),
      small: summary.broker_cache_age_seconds !== undefined ? formatAgeSeconds(summary.broker_cache_age_seconds) : "No cache age",
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

function renderDryRunDecision(report = dryRunState) {
  const summary = report.summary || {};
  const strategy = report.strategy || {};
  const scanner = report.scanner || {};
  const rebalance = report.rebalance || {};
  dryRunPill("#dryRunStatusPill", dryRunActionLabel(summary.status), dryRunTone(summary.status));
  const decisionTarget = qs("#dryRunDecisionRows");
  if (decisionTarget) {
    decisionTarget.innerHTML = auditKvRows([
      { label: "Action verdict", value: dryRunActionLabel(summary.status), tone: dryRunTone(summary.status) },
      { label: "Execution scope", value: "Paper dry-run only; live orders blocked", tone: "ok" },
      { label: "Mode", value: report.mode || "--", tone: report.mode === "paper" ? "ok" : "danger" },
      { label: "Live order placement", value: report.live_order_placement || "blocked", tone: report.live_order_placement === "blocked" ? "ok" : "danger" },
      { label: "Strategy", value: strategy.name || "--", tone: "info" },
      { label: "Market regime", value: strategy.market_regime || summary.market_regime || "--", tone: strategy.risk_on ? "ok" : "warn" },
      { label: "PDD state", value: strategy.pdd_state || "--", tone: dryRunTone(strategy.pdd_state) },
      { label: "Scanner run", value: scanner.run_id ? `#${scanner.run_id} / ${scanner.status || "--"}` : scanner.status || "--", tone: dryRunTone(scanner.status) },
      { label: "Signal month", value: `${scanner.as_of_month || "--"} → ${scanner.execution_month || "--"}`, tone: "info" },
      { label: "Monthly gate", value: dryRunGateLabel(summary.rebalance_gate), tone: rebalance.allowed ? "ok" : "warn" },
      { label: "First trading day", value: rebalance.first_trading_day || rebalance.today || "--", tone: rebalance.allowed ? "ok" : "warn" },
      { label: "Gate reason", value: rebalance.reason || "--", tone: rebalance.allowed ? "ok" : "warn" },
    ]);
  }
  renderDryRunTargets(strategy.target_symbols || [], strategy.retain_symbols || []);
}

function renderDryRunTargets(targetSymbols = [], retainSymbols = []) {
  const target = qs("#dryRunTargetRows");
  if (!target) return;
  target.innerHTML = `
    <h4>Target & Retain Symbols</h4>
    <div class="audit-table-row">
      <span>TARGET</span>
      <strong>${escapeHtml(compactList(targetSymbols, 13))}</strong>
      <em>${formatQty(targetSymbols.length)} symbols</em>
    </div>
    <div class="audit-table-row">
      <span>RETAIN</span>
      <strong>${escapeHtml(compactList(retainSymbols, 13))}</strong>
      <em>${formatQty(retainSymbols.length)} symbols</em>
    </div>
  `;
}

function renderDryRunSafety(report = dryRunState) {
  const checks = report.safety_checks || [];
  const critical = checks.filter((row) => row.severity === "critical" && !row.ok).length;
  const warnings = checks.filter((row) => row.severity !== "critical" && !row.ok).length;
  dryRunPill("#dryRunSafetyPill", critical ? "critical" : warnings ? "warnings" : "clear", critical ? "danger" : warnings ? "warn" : "ok");
  const target = qs("#dryRunSafetyRows");
  if (!target) return;
  if (!checks.length) {
    target.innerHTML = `<div class="audit-empty">Safety checks are not loaded yet.</div>`;
    return;
  }
  target.innerHTML = checks
    .map((check) => {
      const tone = check.ok ? "ok" : check.severity === "critical" ? "danger" : "warn";
      return `
        <div class="audit-kv-row ${tone}">
          <span>${check.ok ? "✓" : "!"} ${escapeHtml(check.label || check.key || "Check")}</span>
          <strong>${escapeHtml(check.detail || (check.ok ? "OK" : "Review"))}</strong>
        </div>
      `;
    })
    .join("");
  target.innerHTML = cleanUiText(target.innerHTML);
}

function renderDryRunOrders(report = dryRunState) {
  const orderPlan = report.order_plan || {};
  const orders = orderPlan.orders || [];
  const summary = report.summary || {};
  dryRunPill("#dryRunOrderPill", `${orders.length || 0} orders`, orders.length ? "warn" : "ok");
  const target = qs("#dryRunOrderRows");
  if (target) {
    target.innerHTML = `
      <h4>Planned Paper Orders</h4>
      ${
        orders.length
          ? orders
              .map((row) => {
                const action = String(row.action || row.side || "--").toUpperCase();
                const tone = action.includes("SELL") || action.includes("EXIT") ? "warn" : "ok";
                const qty = row.quantity ?? row.estimated_quantity ?? row.qty ?? "--";
                const price = row.price ?? row.ltp ?? row.estimated_price;
                const detail = `${qty !== "--" ? `Qty ${formatQty(qty)}` : "Qty --"}${price ? ` @ ${formatPrice(price)}` : ""}${row.reason ? ` · ${row.reason}` : ""}`;
                return `
                  <div class="audit-table-row ${tone}">
                    <span>${escapeHtml(action)}</span>
                    <strong>${escapeHtml(row.symbol || "--")}</strong>
                    <em>${escapeHtml(detail)}</em>
                  </div>
                `;
              })
              .join("")
          : `
            <div class="audit-table-row ok">
              <span>NONE</span>
              <strong>No paper changes</strong>
              <em>Current action plan has 0 buys / 0 sells</em>
            </div>
          `
      }
    `;
  }
  renderDryRunGaps(report.reconciliation || {}, summary);
}

function renderDryRunGaps(reconciliation = {}, summary = {}) {
  const target = qs("#dryRunGapRows");
  if (!target) return;
  const actions = reconciliation.pending_actions || {};
  const exits = actions.exits || [];
  const entries = actions.entries || [];
  const rows = [
    ...exits.map((row) => ({
      type: "PENDING EXIT",
      symbol: row.symbol,
      detail: `Qty ${formatQty(row.quantity)} · ${row.reason || "Outside retain list"}`,
      tone: "warn",
    })),
    ...entries.map((row) => ({
      type: "PENDING ENTRY",
      symbol: row.symbol,
      detail: `Est. Qty ${row.estimated_quantity ?? "--"} · ${row.reason || "Missing target"}`,
      tone: "ok",
    })),
  ];
  target.innerHTML = `
    <h4>Reconciliation Preview</h4>
    <div class="audit-table-row ${Number(summary.gap_count || 0) ? "warn" : "ok"}">
      <span>GAPS</span>
      <strong>${formatQty(summary.gap_count || 0)}</strong>
      <em>${summary.gap_count ? "Review broker/paper mismatch before live phase" : "No broker/paper gaps"}</em>
    </div>
    ${
      rows.length
        ? rows
            .map(
              (row) => `
                <div class="audit-table-row ${row.tone}">
                  <span>${escapeHtml(row.type)}</span>
                  <strong>${escapeHtml(row.symbol || "--")}</strong>
                  <em>${escapeHtml(row.detail)}</em>
                </div>
              `,
            )
            .join("")
        : ""
    }
  `;
}

function renderDryRunBroker(report = dryRunState) {
  const broker = report.broker || {};
  const cache = broker.cache || {};
  const brokerSummary = broker.summary || {};
  const paper = report.paper || {};
  const portfolio = paper.portfolio || {};
  dryRunPill("#dryRunBrokerPill", cache.status || "missing", dryRunTone(cache.status));
  const target = qs("#dryRunBrokerRows");
  if (target) {
    target.innerHTML = auditKvRows([
      { label: "Broker status", value: broker.message || "--", tone: broker.ok ? "ok" : "warn" },
      { label: "Cache status", value: cache.status || "missing", tone: cache.stale ? "warn" : dryRunTone(cache.status) },
      { label: "Cache age", value: cache.age_seconds !== undefined ? formatAgeSeconds(cache.age_seconds) : "--", tone: cache.stale ? "warn" : "ok" },
      { label: "Cache timestamp", value: cache.generated_at ? formatDateTime(cache.generated_at) : "--", tone: cache.available ? "ok" : "warn" },
      { label: "Broker holdings", value: brokerSummary.holding_count ?? "--", tone: "info" },
      { label: "Broker cash", value: brokerSummary.available_cash !== undefined ? formatInr(brokerSummary.available_cash) : "--", tone: "info" },
      { label: "Paper equity", value: portfolio.equity !== undefined ? formatInr(portfolio.equity) : "--", tone: "info" },
      { label: "Paper cash", value: portfolio.cash !== undefined ? formatInr(portfolio.cash) : "--", tone: "info" },
    ]);
  }
  renderDryRunNotes(report.notes || []);
}

function renderDryRunNotes(notes = []) {
  const target = qs("#dryRunNoteRows");
  if (!target) return;
  target.innerHTML = `
    <h4>Execution Notes</h4>
    ${
      notes.length
        ? notes
            .map(
              (note) => `
                <div class="audit-log-row info">
                  <strong>NOTE</strong>
                  <span>${escapeHtml(note)}</span>
                  <em>dry-run</em>
                </div>
              `,
            )
            .join("")
        : `<div class="audit-empty">No dry-run notes available.</div>`
    }
  `;
}

function renderDryRunReport(report = {}) {
  dryRunState = report;
  renderDryRunStats(report);
  renderDryRunDecision(report);
  renderDryRunSafety(report);
  renderDryRunOrders(report);
  renderDryRunBroker(report);
}

function renderDryRunError(error) {
  const target = qs("#dryRunSafetyRows");
  if (!target) return;
  target.innerHTML = `
    <div class="audit-empty error">
      <strong>Dry-run report unavailable.</strong>
      <span>${escapeHtml(error.message || "Unable to load monthly rebalance dry-run report.")}</span>
    </div>
  `;
}

async function refreshDryRun() {
  if (dryRunRefreshInFlight) return dryRunState;
  dryRunRefreshInFlight = true;
  const button = qs("#refreshDryRunData");
  const originalText = button?.textContent || "Refresh Action Plan";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  try {
    const report = await safeJson("/api/rebalance/dry-run");
    renderDryRunReport(report);
    return report;
  } catch (error) {
    console.error(error);
    renderDryRunError(error);
    return dryRunState;
  } finally {
    dryRunRefreshInFlight = false;
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function sendDryRunReport() {
  const button = qs("#sendDryRunReport");
  const originalText = button?.textContent || "Send Telegram Dry Run";
  if (button) {
    button.disabled = true;
    button.textContent = "Sending...";
  }
  try {
    const payload = await safeJson("/api/rebalance/dry-run/notify", { method: "POST" });
    if (payload.report) renderDryRunReport(payload.report);
    await refreshNotifications();
    if (button) button.textContent = "Sent";
  } catch (error) {
    console.error(error);
    renderDryRunError(error);
    if (button) button.textContent = "Failed";
  } finally {
    window.setTimeout(() => {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }, 1800);
  }
}

function setupDryRunActions() {
  qs("#refreshDryRunData")?.addEventListener("click", () => refreshDryRun());
  qs("#sendDryRunReport")?.addEventListener("click", sendDryRunReport);
  qs("#openAuditFromDryRun")?.addEventListener("click", () => {
    history.pushState(null, "", "#audit");
    setView("audit");
  });
}

function auditTone(levelOrStatus) {
  const value = String(levelOrStatus || "").toLowerCase();
  if (["ok", "safe", "complete", "completed", "delivered", "filled", "ready", "fresh", "installed", "enabled"].includes(value)) return "ok";
  if (["warning", "warn", "partial_coverage", "blocked", "skipped", "risk off", "stale", "running"].includes(value)) return "warn";
  if (["failed", "critical", "error", "missing"].includes(value)) return "danger";
  return "muted";
}

function compactValue(value, fallback = "--") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function compactList(values = [], limit = 8) {
  if (!Array.isArray(values) || !values.length) return "--";
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit ? `${shown} +${values.length - limit}` : shown;
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

function auditKvRows(rows = []) {
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

async function refreshAudit() {
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

function setupAuditActions() {
  qs("#refreshAuditData")?.addEventListener("click", () => refreshAudit());
  qs("#downloadAuditJson")?.addEventListener("click", downloadAuditJson);
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

function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function formatDateLabel(value) {
  if (!value) return "--";
  const raw = String(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return raw;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function setTone(node, tone = "info") {
  if (!node) return;
  node.classList.remove("green", "red", "gold", "warn", "info", "muted");
  const toneClass =
    tone === "ok" ? "green" :
    tone === "danger" ? "red" :
    tone === "gold" ? "gold" :
    tone === "warn" ? "warn" :
    tone === "muted" ? "muted" :
    "info";
  node.classList.add(toneClass);
}

function toneFromLevel(level) {
  if (["ok", "safe", "success"].includes(level)) return "ok";
  if (["warning", "warn"].includes(level)) return "warn";
  if (["critical", "danger", "error"].includes(level)) return "danger";
  if (level === "muted") return "muted";
  return "info";
}

function cardByKey(cards = [], key) {
  return cards.find((card) => card.key === key) || {};
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

function renderCockpitKpis(snapshot = {}) {
  const ui = snapshot.ui || {};
  const allocation = ui.allocation || {};
  const top = ui.top_bar || {};
  const portfolio = snapshot.paper?.portfolio || {};
  const summary = portfolio.summary || portfolio.state || {};
  const pdd = ui.pdd_status || snapshot.pdd || {};
  const observability = ui.observability || {};
  const rebalance = ui.rebalance_status || snapshot.paper?.rebalance_status || {};

  const portfolioValue = firstFinite(top.portfolio_value, summary.equity, snapshot.portfolio?.value);
  const totalPnl = firstFinite(top.total_pnl, summary.total_pnl, allocation.total_pnl);
  const totalPnlPct = firstFinite(top.total_pnl_pct, summary.total_pnl_pct, allocation.total_pnl_pct);
  const drawdownRaw = firstFinite(pdd.drawdown, pdd.current_drawdown, summary.current_drawdown, top.current_drawdown);
  const drawdown = Number.isFinite(Number(drawdownRaw)) ? Math.abs(Number(drawdownRaw)) : drawdownRaw;
  const cash = firstFinite(allocation.cash_available, summary.cash, snapshot.portfolio?.cash);
  const nextRebalance = observability.summary?.next_rebalance || rebalance.next_rebalance || "2026-08-03";

  setText("#cockpitPortfolioValue", formatInr(portfolioValue));
  setText("#cockpitTotalPnl", `${formatSignedInr(totalPnl)} (${formatPct(totalPnlPct, 2, true)})`);
  setTone(qs("#cockpitTotalPnl"), totalPnl >= 0 ? "ok" : "danger");
  setText("#cockpitDrawdown", formatPct(drawdown, 2));
  setTone(qs("#cockpitDrawdown"), drawdown >= 0.16 ? "danger" : drawdown >= 0.07 ? "warn" : "ok");
  renderCockpitDrawdownGauge(drawdown, pdd);
  setText("#cockpitCash", formatInr(cash));
  setText(
    "#cockpitAllocation",
    `E ${formatPct(allocation.equity_allocation_pct, 0)} / G ${formatPct(allocation.gold_allocation_pct, 0)}`
  );
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

function renderDashboard(snapshot) {
  const ui = snapshot.ui || {};
  const holdings = ui.holdings || snapshot.paper?.portfolio?.holdings || [];
  const ranks = ui.rank_rows || snapshot.ranks || [];
  renderTopBar(ui.top_bar || {});
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

async function refreshDashboard() {
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

function updateClockFallback() {
  const clock = qs("#clock");
  if (!clock || clock.textContent !== "--:--:--") return;
  clock.textContent = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

qs(".refresh-button")?.addEventListener("click", () => {
  refreshDashboard();
  if (currentView === "reconciliation") refreshReconciliation();
  if (currentView === "notifications") refreshNotifications();
  if (currentView === "operations") refreshOperations();
  if (currentView === "settings") refreshOperations();
  if (currentView === "audit") refreshAudit();
  if (currentView === "dryrun") refreshDryRun();
});
qs("#sendTestAlert")?.addEventListener("click", sendTestAlert);
qs("#refreshNotificationsData")?.addEventListener("click", refreshNotifications);
setupNavigation();
setupNotificationFilters();
setupControlActions();
setupReconciliationActions();
setupDryRunActions();
setupAuditActions();
refreshDashboard();
refreshNotifications();
refreshOperations();
refreshAudit();
updateClockFallback();
setInterval(() => {
  refreshDashboard();
  if (currentView === "reconciliation") refreshReconciliation();
  if (currentView === "notifications") refreshNotifications();
  if (currentView === "operations") refreshOperations();
  if (currentView === "settings") refreshOperations();
  if (currentView === "audit") refreshAudit();
  if (currentView === "dryrun") refreshDryRun();
}, 30000);
