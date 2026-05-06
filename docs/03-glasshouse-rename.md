# 03 - Glasshouse Rename

## Status

Done

## Background

The project has been renamed from CC Viewer / cc-viewer to Glasshouse. The
rename affects public branding, package metadata, documentation, CLI output,
desktop app titles, and release distribution references.

## Goals

1. Present the product as Glasshouse in user-facing CLI/server/UI text.
2. Move npm metadata to the scoped package `@yuanyunfan/glasshouse`, because
   the unscoped `glasshouse` package name is already occupied on npm.
3. Point repository, release, issue, Homebrew, and update references at
   `yuanyunfan/glasshouse`.
4. Keep the existing `ccv` binary name for user compatibility.
5. Keep existing runtime protocol names such as `CCV_*`, `CCVIEWER_*`, and
   `x-cc-viewer-*` stable until a separate migration exists.
6. Keep legacy data/cache paths such as `~/.claude/cc-viewer` readable to avoid
   breaking existing logs, preferences, uploads, and update throttling.

## Non-goals

- Renaming the `ccv` command.
- Renaming localStorage keys, request headers, or environment variables.
- Moving existing logs from `~/.claude/cc-viewer` to a new directory.
- Removing support for old shell hook markers or old Homebrew Cellar paths.

## Compatibility Notes

Claude CLI injection now uses a file URL to the current package's
`interceptor.js` instead of a relative path that assumes the package directory is
named `cc-viewer`. This keeps npm scoped installs, Homebrew installs, and local
development checkouts working through the same path.

The uninstall flow removes both new `Glasshouse Auto-Inject` shell hooks and
legacy `CC-Viewer Auto-Inject` shell hooks. Homebrew detection recognizes both
`Cellar/glasshouse` and legacy `Cellar/cc-viewer` layouts.

## Verification

- `npm view glasshouse name version description --json` showed the unscoped
  package name is already occupied.
- `npm view @yuanyunfan/glasshouse name version description --json` returned
  `E404`, so the scoped name is currently available or unpublished.
- Local verification recorded in the implementation task:
  `node --test test/cli.test.js test/updater.test.js test/proxy-errors.test.js`,
  `npm test`, `npm run build`, and `git diff --check`.
