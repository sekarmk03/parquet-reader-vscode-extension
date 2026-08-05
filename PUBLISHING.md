# Publishing checklist

Steps to get this extension onto the VS Code Marketplace. Work through them in order — the
first two are blockers.

## 1. Host the repository — done

`README.md` references images with relative paths (`images/data-tab.png`). The Marketplace
only renders images served over HTTPS, so `vsce` rewrites those paths at package time — but it
can only do that if it knows the repository URL. Without one, `vsce package` fails outright:

```
ERROR  Couldn't detect the repository where this extension is published.
The image 'images/data-tab.png' will be broken in README.md.
```

`package.json` now points at https://github.com/sekarmk03/parquet-reader-vscode-extension,
and packaging rewrites the images to
`https://github.com/sekarmk03/parquet-reader-vscode-extension/raw/HEAD/images/…`.

Two things this depends on, worth rechecking if the images ever break:

- **`images/` must stay committed and public.** It is excluded from the `.vsix` on purpose —
  the Marketplace loads those files from the repository, not from the package.
- **`raw/HEAD` follows the default branch.** Renaming or unpublishing that branch breaks every
  screenshot on the listing.

GitHub and GitLab URLs are detected automatically. To host the images somewhere else, pass the
base URLs explicitly instead:

```bash
npx vsce package --baseContentUrl https://<host>/<path>/ --baseImagesUrl https://<host>/<path>/
```

## 2. Create a publisher

The `publisher` field is currently `sekar`. It must match a publisher you own.

1. Create an Azure DevOps organisation: https://dev.azure.com
2. Create a Personal Access Token with **Marketplace → Manage** scope, all organisations
3. Create the publisher: https://marketplace.visualstudio.com/manage
4. Log in locally: `npx vsce login <publisher>`

## 3. Add an icon (optional but recommended)

Without one the listing shows a generic placeholder. Add a 128×128 PNG and reference it:

```json
"icon": "icon.png"
```

Unlike the README screenshots, the icon **must** ship inside the `.vsix`, so do not add it to
`.vscodeignore`.

## 4. Verify before packaging

```bash
npm run typecheck   # tsc --noEmit
npm run smoke       # headless checks against test fixtures, including remote reads
npm run build       # bundle to dist/extension.js
```

Then press <kbd>F5</kbd> and confirm by hand, with `test/demo.parquet`:

- the Data tab renders, pagination reaches page 12, and clicking a `shipment` cell shows
  pretty-printed JSON in the detail pane
- the Schema tab lists every leaf column with its statistics
- **Parquet: Open Parquet from URL…** opens the same file from `s3://` or `https://`

## 5. Package and inspect

```bash
npm run package     # production bundle + vsce package
```

Check the file list `vsce` prints. It should contain `dist/extension.js`, `media/`,
`package.json`, `README.md`, `CHANGELOG.md`, and `LICENSE` — and nothing from `src/`, `test/`,
`images/`, or `node_modules/`. Expect roughly 100 KB.

Install the `.vsix` locally and open a real file before publishing:

```bash
code --install-extension parquet-table-viewer-0.0.1.vsix
```

## 6. Publish

```bash
npx vsce publish            # publishes the current version
npx vsce publish patch      # or: bump 0.0.1 -> 0.0.2 first, then publish
```

The listing appears within a few minutes. Verify that the screenshots actually render on the
Marketplace page — a broken image there is almost always the repository URL from step 1.

## Releasing later versions

1. Add a section to `CHANGELOG.md` — the Marketplace shows it as its own tab
2. Bump `version` in `package.json` (or let `vsce publish <major|minor|patch>` do it)
3. Re-run step 4, then `npx vsce publish`
