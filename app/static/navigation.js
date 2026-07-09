import { qs, qsa } from "./formatters.js";

let currentView = "dashboard";
let viewRefreshers = {};

export function registerViewRefreshers(refreshers = {}) {
  viewRefreshers = refreshers;
}

export function getCurrentView() {
  return currentView;
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

export function setView(view, activeLink = null) {
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
    viewRefreshers.reconciliation?.();
  }
  if (currentView === "notifications") {
    viewRefreshers.notifications?.();
  }
  if (currentView === "operations") {
    viewRefreshers.operations?.();
  }
  if (currentView === "settings") {
    viewRefreshers.operations?.();
  }
  if (currentView === "audit") {
    viewRefreshers.audit?.();
  }
  if (currentView === "dryrun") {
    viewRefreshers.dryrun?.();
  }
}

export function setupNavigation(options = {}) {
  options.ensureNotificationBadge?.();
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
