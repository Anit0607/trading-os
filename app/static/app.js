import { setupAlertActions, setupNotificationFilters, refreshNotifications, ensureNotificationBadge } from "./alerts.js";
import { refreshDashboard } from "./dashboard.js";
import { setupNavigation, registerViewRefreshers, getCurrentView } from "./navigation.js";
import { refreshReconciliation, setupReconciliationActions } from "./portfolio.js";
import { refreshAudit, setupAuditActions } from "./reports.js";
import { refreshDryRun, refreshOperations, setupControlActions, setupDryRunActions } from "./strategy.js";

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

refreshDashboard();
refreshNotifications();
refreshOperations();
refreshAudit();

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
