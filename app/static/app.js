import { shouldPreloadLocalOnlyScreens } from "./api.js?v=20260717-modeguard";
import { setupAlertActions, setupNotificationFilters, refreshNotifications, ensureNotificationBadge } from "./alerts.js?v=20260717-modeguard";
import { refreshDashboard } from "./dashboard.js?v=20260717-modeguard";
import { setupNavigation, registerViewRefreshers, getCurrentView } from "./navigation.js?v=20260717-modeguard";
import { refreshReconciliation, setupReconciliationActions } from "./portfolio.js?v=20260717-modeguard";
import { refreshAudit, setupAuditActions } from "./reports.js?v=20260717-modeguard";
import { refreshDryRun, refreshOperations, setupControlActions, setupDryRunActions } from "./strategy.js?v=20260717-modeguard";

registerViewRefreshers({
  reconciliation: refreshReconciliation,
  notifications: refreshNotifications,
  operations: refreshOperations,
  settings: refreshOperations,
  audit: refreshAudit,
  dryrun: refreshDryRun,
});

setupNavigation({ ensureNotificationBadge });
setupNotificationFilters();
setupAlertActions();
setupControlActions();
setupReconciliationActions();
setupDryRunActions();
setupAuditActions();

async function boot() {
  await refreshDashboard();
  refreshNotifications();
  if (shouldPreloadLocalOnlyScreens()) {
    refreshOperations();
    refreshAudit();
  }
}

boot();

setInterval(() => {
  refreshDashboard();
  const currentView = getCurrentView();
  if (currentView === "reconciliation") refreshReconciliation();
  if (currentView === "notifications") refreshNotifications();
  if (currentView === "operations") refreshOperations();
  if (currentView === "settings") refreshOperations();
  if (currentView === "audit") refreshAudit();
  if (currentView === "dryrun") refreshDryRun();
}, 30000);
