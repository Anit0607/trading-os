const CLOUD_SAFE_ENDPOINTS = new Set([
  "/api/dashboard",
  "/api/health",
  "/api/notifications",
  "/api/notifications/status",
  "/api/readiness",
]);

const runtimeMode = {
  known: false,
  cloudReadonly: false,
};

function readCloudReadonlyFlag(payload = {}) {
  return (
    payload.cloud_readonly === true ||
    payload.mode === "cloud_readonly" ||
    payload.status?.cloud_readonly === true ||
    payload.cloud?.readonly === true ||
    payload.ui?.cloud?.readonly === true
  );
}

export function updateRuntimeMode(payload = {}) {
  runtimeMode.known = true;
  runtimeMode.cloudReadonly = readCloudReadonlyFlag(payload);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.runtimeMode = runtimeMode.cloudReadonly ? "cloud-readonly" : "local";
  }
  return { ...runtimeMode };
}

export function isRuntimeModeKnown() {
  return runtimeMode.known;
}

export function isCloudReadonlyMode() {
  return runtimeMode.cloudReadonly;
}

export function shouldPreloadLocalOnlyScreens() {
  return runtimeMode.known && !runtimeMode.cloudReadonly;
}

export function isCloudSafeEndpoint(url) {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const path = new URL(url, origin).pathname;
  return CLOUD_SAFE_ENDPOINTS.has(path);
}

export async function safeJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
    ...options,
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const body = await response.text().catch(() => "");
    const error = new Error(`${url} did not return JSON`);
    error.payload = {
      body_preview: body.slice(0, 160),
      content_type: contentType,
      status: response.status,
    };
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error || payload?.message || `${url} returned ${response.status}`;
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function settledPayload(results, key) {
  const result = results[key];
  if (!result) return { ok: false, error: "Not requested" };
  if (result.status === "fulfilled") return result.value;
  return { ok: false, error: result.reason?.message || "Unavailable" };
}
