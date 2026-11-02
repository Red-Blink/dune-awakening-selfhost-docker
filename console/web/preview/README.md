# Try the Console

Build the public read-only preview with `npm run build:preview` from `console/web`.
The static output is written to `dist-preview`; `PREVIEW_OUT_DIR` can override it.

The preview reuses the Console interface with fictional fixtures from
`sampleData.ts` and bundled language packs. It does not need a Console API,
database, Docker socket, credentials, or login. Serve `/api/*` with a 405 response
and never proxy it to a management backend. The website routing block is maintained
in the website repository under `deployment/try-console.caddy`.

Management controls and uploads are disabled. Navigation, searches, map layers,
and language selection remain interactive. The ordinary `npm run build` excludes
the preview code and continues using the normal authentication and API flow.

When updating the interface or API contracts, update the fictional fixtures and
test every preview page, language switching, and blocked mutations before publishing.
Run `npm run check:preview-seo` to test the generated search and share metadata
(titles, descriptions and crawler files), and `npm run test:preview` after building. As with the other browser checks,
`PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` can select an existing browser installation;
`PREVIEW_DIST` can select a different build directory. All test traffic stays local.
