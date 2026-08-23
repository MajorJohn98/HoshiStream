// The management page is a thin HTML shell; the entire UI, including the top
// navigation bar, is rendered by the preact app in assets/manage/app.js.
export const managementHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>HoshiStream</title>
    <link rel="stylesheet" href="/manage-assets/styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <div id="toast" class="toast"></div>
    <script type="module" src="/manage-assets/app.js"></script>
  </body>
</html>
`;
