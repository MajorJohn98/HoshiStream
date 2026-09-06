// HTTP + formatting helpers shared by all views. This is the only module that
// talks to the management API. The legacy detail view imports these through
// app.js re-exports until it is migrated.
export const token = decodeURIComponent(
  location.pathname.split("/").filter(Boolean).pop(),
);
export const headers = { Authorization: "Bearer " + token };

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, opt = {}) {
  const r = await fetch("/api/" + path, {
    ...opt,
    headers: { ...headers, ...opt.headers },
  });
  return apiResponse(r);
}

export async function apiResponse(r) {
  if (!r.ok) {
    const details = await r.json().catch(() => null);
    throw new ApiError(details?.error || "Request failed", {
      status: r.status,
      code: details?.code,
      details,
    });
  }
  if (r.status === 204) return null;
  try {
    return await r.json();
  } catch {
    throw new ApiError(
      "The server response could not be read. Retry the same request to recover its outcome.",
      {
        status: r.status,
        code: "invalid_response",
      },
    );
  }
}

export const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";

export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );

export const notify = (s) => {
  const toast = document.querySelector("#toast");
  toast.textContent = s;
  toast.className = "toast show";
  setTimeout(() => (toast.className = "toast"), 2500);
};
