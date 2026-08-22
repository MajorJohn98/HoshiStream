// HTTP + formatting helpers shared by all views. This is the only module that
// talks to the management API. The legacy detail view imports these through
// app.js re-exports until it is migrated.
export const token = decodeURIComponent(
  location.pathname.split("/").filter(Boolean).pop(),
);
export const headers = { Authorization: "Bearer " + token };

export async function api(path, opt = {}) {
  const r = await fetch("/api/" + path, {
    ...opt,
    headers: { ...headers, ...opt.headers },
  });
  if (!r.ok)
    throw Error((await r.json().catch(() => ({}))).error || "Request failed");
  return r.status === 204 ? null : r.json();
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
