// Same-origin fetch helpers for /api/v1. Every failure becomes an ApiError whose message a
// person can read, so pages can show `error.message` as it is.

const BASE = "/api/v1";

export class ApiError extends Error {
  /**
   * @param {string} message  shown to the person
   * @param {{ status?: number, code?: string }} [info]
   */
  constructor(message, { status = 0, code = "network" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const OFFLINE = "Can't reach UrBudget right now. Check your connection and try again.";
const BROKEN = "Something went wrong on our side. Please try again in a moment.";
const UNAVAILABLE = "UrBudget's service isn't answering right now. Please try again in a moment.";

/**
 * Calls the API. Resolves with the parsed JSON body; rejects with ApiError.
 * @param {string} path  e.g. "/me"
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
 */
export async function api(path, { method = "GET", body, signal } = {}) {
  const init = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }

  let response;
  try {
    response = await fetch(BASE + path, init);
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    throw new ApiError(OFFLINE);
  }

  let data = null;
  const type = response.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message =
      (data && typeof data.message === "string" && data.message) ||
      (data === null ? UNAVAILABLE : response.status >= 500 ? BROKEN : "That didn't work. Please try again.");
    throw new ApiError(message, { status: response.status, code: (data && data.error) || `http_${response.status}` });
  }
  if (data === null) {
    // A static host answering with HTML (no API behind it) lands here.
    throw new ApiError(UNAVAILABLE, { status: response.status, code: "not_json" });
  }
  return data;
}

const FALLBACK_CONFIG = {
  checkout: { ready: false, environment: "production" },
  prices: { sync: "$3" },
  supportEmail: "support@urbudget.app",
  offline: true,
};

let configPromise = null;

/**
 * GET /config, fetched once per page. Never rejects: without the API it resolves with
 * fallback values (and `offline: true`), so the sync price still reads "$3".
 */
export function getConfig() {
  if (!configPromise) {
    configPromise = api("/config")
      .then((config) => ({
        ...FALLBACK_CONFIG,
        ...config,
        checkout: { ...FALLBACK_CONFIG.checkout, ...(config.checkout || {}) },
        prices: { ...FALLBACK_CONFIG.prices, ...(config.prices || {}) },
        offline: false,
      }))
      .catch(() => FALLBACK_CONFIG);
  }
  return configPromise;
}

/**
 * GET /me. Resolves with the account, or null when signed out (401).
 * Rejects with ApiError for anything else (offline, server error).
 */
export async function getMe() {
  try {
    return await api("/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
