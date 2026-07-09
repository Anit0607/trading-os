import {
  compactDateTime,
  escapeHtml,
  formatDateTime,
  formatQty,
  qs,
  qsa,
  setText,
} from "./formatters.js";

let notificationFilter = "all";
let notificationCache = [];
let notificationStatus = {};
let notificationRefreshInFlight = false;

function notificationCount(summary = {}, channel, status) {
  const counts = summary.counts || {};
  return Number(counts[channel]?.[status] || 0);
}

export function notificationTotalByStatus(summary = {}, status) {
  const counts = summary.counts || {};
  return Object.values(counts).reduce((total, channelCounts) => total + Number(channelCounts?.[status] || 0), 0);
}

export function ensureNotificationBadge() {
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
  const failedSkipped = failed + skipped;
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

export function notificationRowClass(row) {
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

export async function refreshNotifications() {
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

export function setupNotificationFilters() {
  qsa(".notification-filters button").forEach((button) => {
    button.addEventListener("click", () => {
      notificationFilter = button.dataset.filter || "all";
      renderNotificationRows(notificationCache);
    });
  });
}

export async function sendTestAlert() {
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

export function setupAlertActions() {
  qs("#sendTestAlert")?.addEventListener("click", sendTestAlert);
  qs("#refreshNotificationsData")?.addEventListener("click", refreshNotifications);
}
