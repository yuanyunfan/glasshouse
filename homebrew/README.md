# Homebrew Distribution

This directory holds the reference Homebrew Formula for Glasshouse and the maintainer instructions for the tap repo.

## One-time setup (maintainer)

1. **Create the tap repo** on GitHub: `yuanyunfan/homebrew-glasshouse` (the `homebrew-` prefix is required by `brew tap`).
2. **Copy the formula** into it:
   ```bash
   git clone https://github.com/yuanyunfan/homebrew-glasshouse
   mkdir -p homebrew-glasshouse/Formula
   cp homebrew/Formula/glasshouse.rb homebrew-glasshouse/Formula/
   ```
3. **Compute the real sha256** for the current version (the placeholder in `glasshouse.rb` is all zeros) and commit:
   ```bash
   curl -fsSL "https://registry.npmjs.org/@yuanyunfan/glasshouse/-/glasshouse-$(node -p "require('./package.json').version").tgz" -o /tmp/pkg.tgz
   shasum -a 256 /tmp/pkg.tgz
   # Paste the hash into homebrew-glasshouse/Formula/glasshouse.rb, commit, push.
   ```
4. **Install secret** `HOMEBREW_TAP_TOKEN` in this (Glasshouse) repo's GitHub Settings:
   - It needs a fine-grained PAT with `Contents: Read and write` + `Pull requests: Read and write` on `yuanyunfan/homebrew-glasshouse`.
   - Or use a GitHub App with the same scopes.

After that, every `release: published` event in this repo triggers `.github/workflows/bump-homebrew.yml`, which opens a PR against the tap with the new version + sha256.

## End-user install

```bash
brew tap yuanyunfan/glasshouse
brew install glasshouse
```

The formula installs to `<prefix>/Cellar/glasshouse/<version>/` and creates a wrapper at `<prefix>/bin/ccv` that **explicitly invokes the Homebrew-managed Node binary**, so `nvm use <other-version>` does not affect it.

## Updates

```bash
brew upgrade glasshouse
```

Glasshouse's built-in self-updater (`lib/updater.js`) detects Homebrew installs (via `detectHomebrewInstall()`) and skips the npm-based upgrade path, printing this hint instead. See `test/updater.test.js` describe block `checkAndUpdate — brew_managed`.

## Why a wrapper instead of `bin.install_symlink`?

The default symlink path leaves `ccv`'s shebang as `#!/usr/bin/env node`, which resolves whichever Node is first on PATH — usually the user's nvm Node. Glasshouse's `node-pty` native binding is built against the Homebrew Node's ABI at install time; a different Node major would crash with `NODE_MODULE_VERSION` mismatch on first use. The shell wrapper hardcodes `Formula["node"].opt_bin/node`, eliminating that drift.

Tradeoff: when Homebrew bumps Node majors (e.g., v22 → v23), users need `brew reinstall glasshouse` to rebuild node-pty against the new ABI. Brew handles this automatically via formula revision bumps, but it's worth knowing.
