import { safeJson, settledPayload } from "./api.js";
import { notificationRowClass, notificationTotalByStatus, refreshNotifications } from "./alerts.js";
import { auditKvRows } from "./reports.js";
import {
  compactDateTime,
  compactList,
  compactValue,
  cleanUiText,
  escapeHtml,
  formatAgeSeconds,
  formatDateTime,
  formatInr,
  formatPct,
  formatPrice,
  formatQty,
  qs,
  qsa,
  setText,
} from "./formatters.js";
import { setView } from "./navigation.js";

let controlState = {};
let controlRefreshInFlight = false;
let dryRunState = {};
let dryRunRefreshInFlight = false;

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

export async function refreshOperations(options = {}) {
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

export function setupControlActions() {
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

export async function refreshDryRun() {
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

export function setupDryRunActions() {
  qs("#refreshDryRunData")?.addEventListener("click", () => refreshDryRun());
  qs("#sendDryRunReport")?.addEventListener("click", sendDryRunReport);
  qs("#openAuditFromDryRun")?.addEventListener("click", () => {
    history.pushState(null, "", "#audit");
    setView("audit");
  });
}
