const INR = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

const PRICE = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const NUMBER = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function setText(selector, value, root = document) {
  const node = qs(selector, root);
  if (node) node.textContent = value;
}

export function setClassBySign(node, value) {
  if (!node) return;
  node.classList.toggle("green", Number(value) >= 0);
  node.classList.toggle("red", Number(value) < 0);
}

export function asPercent(value) {
  const number = Number(value || 0);
  return number * 100;
}

export function formatInr(value) {
  return `₹${INR.format(Math.round(Number(value || 0)))}`;
}

export function formatSignedInr(value) {
  const number = Number(value || 0);
  const sign = number >= 0 ? "+" : "-";
  return `${sign}${formatInr(Math.abs(number))}`;
}

export function formatPrice(value) {
  const number = Number(value || 0);
  return number ? PRICE.format(number) : "--";
}

export function formatQty(value) {
  return NUMBER.format(Math.round(Number(value || 0)));
}

export function hasNumericValue(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

export function formatInrOrPlaceholder(value) {
  return hasNumericValue(value) ? formatInr(value) : "--";
}

export function formatSignedInrOrPlaceholder(value) {
  return hasNumericValue(value) ? formatSignedInr(value) : "--";
}

export function formatPctOrPlaceholder(value, decimals = 2, signed = false) {
  return hasNumericValue(value) ? formatPct(value, decimals, signed) : "--";
}

export function formatPct(value, decimals = 2, signed = false) {
  const number = asPercent(value);
  const sign = signed && number >= 0 ? "+" : "";
  return `${sign}${number.toFixed(decimals)}%`;
}

export function cleanUiText(value) {
  return String(value ?? "")
    .replaceAll("\u00e2\u2020\u2019", "→")
    .replaceAll("\u00e2\u0153\u201c", "✓")
    .replaceAll("\u00c2\u00b7", "·");
}

export function escapeHtml(value) {
  return cleanUiText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatDateTime(value) {
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

export function compactDateTime(value) {
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

export function formatAgeSeconds(value) {
  if (value === null || value === undefined || value === "") return "--";
  const seconds = Math.max(0, Number(value || 0));
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function compactValue(value, fallback = "--") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function compactList(values = [], limit = 8) {
  if (!Array.isArray(values) || !values.length) return "--";
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit ? `${shown} +${values.length - limit}` : shown;
}

export function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

export function formatDateLabel(value) {
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

export function setTone(node, tone = "info") {
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

export function toneFromLevel(level) {
  if (["ok", "safe", "success"].includes(level)) return "ok";
  if (["warning", "warn"].includes(level)) return "warn";
  if (["critical", "danger", "error"].includes(level)) return "danger";
  if (level === "muted") return "muted";
  return "info";
}

export function cardByKey(cards = [], key) {
  return cards.find((card) => card.key === key) || {};
}
