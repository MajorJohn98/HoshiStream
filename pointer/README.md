# HoshiStream pointer server

A tiny Vercel deployment that gives the HoshiStream add-on a **permanent
manifest URL**. Clients install `https://<this-host>/addon/<token>/manifest.json`
once; the server serves the manifest and `307`-redirects every other add-on
request to the Mac's current LAN address. It stores only a pointer record
(base URL, token hash, manifest copy) — no library data, no media.

Updates are **manual**: the macOS menu-bar item "Update Remote Pointer"
pushes the current LAN IP. Nothing phones home automatically.

See `hoshistream_docs/guides/pointer-server-vercel.md` for deployment and
`hoshistream_docs/decisions/0012-vercel-pointer-server.md` for the rationale.
