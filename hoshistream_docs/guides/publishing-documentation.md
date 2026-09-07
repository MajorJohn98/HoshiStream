# Publishing the setup guide

The public setup and configuration guide is hosted at
<https://majorjohn98.github.io/HoshiStream/>. The site is documentation only:
publication does not approve beta distribution or upload an installer.

## Content and styling

- `hoshistream_docs/site/guide.html` is the complete guide content. Check factual
  changes against the native launcher, configuration schema and existing guides.
- `hoshistream_docs/site/template.html` contains the page shell.
- `hoshistream_docs/site/styles.css` inherits the app's dark-and-ember identity,
  with a responsive contents rail, constrained reading column and print styles.
- `hoshistream_docs/site/site.js` adds optional contents highlighting, compact
  mobile navigation and print expansion. Content and links work without it.
- `scripts/build-docs-site.mjs` assembles and validates the public output. It
  rejects missing sections, duplicate IDs, broken anchors and version drift.

Use generic examples only. Never paste a real private URL, access token, pointer
secret, `.env`, user library, log excerpt or complete magnet URI into this site.
Do not link an unapproved binary as an installable release.

## Local build

From the repository root, with the project's Node version:

```bash
node scripts/build-docs-site.mjs
```

Open `build/docs-site/index.html` locally. No npm install, framework, external
font service or analytics is needed. For a browser preview over HTTP, serve
only `build/docs-site`, never the repository root. Browser Find searches the
guide; expand the relevant advanced reference before searching if the browser
does not search collapsed disclosures. Print expands those references when
JavaScript is enabled; otherwise open them before printing.

When changing the add-on version, review the guide against the new release,
update the edition date in the template, and advance `reviewedVersion` in the
builder. Version drift intentionally fails rather than silently labeling old
instructions as current.

## GitHub Pages

Repository **Settings > Pages > Build and deployment > Source** must be
**GitHub Actions**. The `Publish setup guide` workflow:

1. Builds documentation for relevant pull requests and pushes to `main`.
2. Uploads only `build/docs-site`, an explicit four-file output:
   `index.html`, `styles.css`, `site.js`, and `.nojekyll`.
3. Deploys only main-branch, non-pull-request runs to the `github-pages`
   environment using Pages and OIDC permissions.

No custom domain is required. Assets use relative paths so they resolve beneath
the repository's `/HoshiStream/` prefix. Maintainers can also run the workflow
manually on `main`. Do not run it from a feature branch expecting publication.

If configuration reports 404 or permission denied, a repository administrator
must enable Pages; do not change repository visibility or broaden a token's
permissions silently. If the environment requires approval, an authorized
maintainer must approve the deployment. Inspect the workflow's deployment URL
and load the public page before calling a publication complete.
