# Public setup and configuration guide

Approved on 2026-09-07: publish documentation from this repository's `main`
branch on GitHub Pages. This does not approve or publish a binary release.

## Scope

1. Write a source-checked, macOS-first guide covering first launch, manual media
   imports, players, persistent settings, storage, optional integrations, Windows,
   source builds, recovery and troubleshooting.
2. Present it as a dependency-free static reading site, using HoshiStream's
   established dark surfaces, ember accent and system typography. Preserve
   readable content without JavaScript, keyboard navigation, small-screen
   layouts and a print stylesheet.
3. Build only explicitly allowed documentation assets into `build/docs-site`.
   Never upload the repository, private configuration, user state or DMGs.
4. Validate the content, site output and repository checks; commit and push the
   requested files to `main`, deploy through GitHub Actions, and confirm the
   public URL.

## Product and surface constraints

Readers include first-time installed-app users and advanced self-hosting users.
The primary job is to configure a private library and reach first playback.
The site is documentation, not the management app or a download portal.
No accounts, analytics, third-party assets or configuration submission forms.
Examples must contain placeholders rather than personal state or credentials.
Candidate limitations, source/notice gates and Windows rollout status remain
explicit; publishing the guide does not change those decisions.

The reading surface inherits the app's existing visual language. It uses a
persistent desktop contents list, compact native disclosure navigation on small
screens, a constrained reading column, scrollable configuration tables and
contextual warnings. Long-form comprehension takes precedence over animation.
