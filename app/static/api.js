export async function safeJson(url, options = {}) {
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

export function settledPayload(results, key) {
  const result = results[key];
  if (!result) return { ok: false, error: "Not requested" };
  if (result.status === "fulfilled") return result.value;
  return { ok: false, error: result.reason?.message || "Unavailable" };
}
