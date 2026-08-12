// The management page is a thin HTML shell; all behavior lives in static ES
// modules under assets/manage/, served from /manage-assets/.
export const managementHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>HoshiStream</title>
    <link rel="stylesheet" href="/manage-assets/styles.css" />
  </head>
  <body>
    <div class="shell">
      <aside>
        <div class="brand">
          <img src="/assets/hoshistream-logo.png" alt="HoshiStream" />
        </div>
        <nav>
          <button data-view="library" class="active"><span class="nav-icon">▦</span>Library</button>
          <button data-view="add"><span class="nav-icon">＋</span>Add Media</button>
          <button data-view="status"><span class="nav-icon">⌁</span>System Status</button>
        </nav>
      </aside>
      <main id="app"></main>
    </div>
    <div id="toast" class="toast"></div>
    <script type="module" src="/manage-assets/app.js"></script>
  </body>
</html>
`;
