# Publishing VSGrok (and getting auto-updates)

> **For later.** Right now VSGrok updates itself from **GitHub Releases** (since 0.5.1): `.github/workflows/release.yml` builds, tests and attaches the `.vsix` to a GitHub Release on every `v*` tag, and the extension checks the latest release once a day (`vsgrok.checkForUpdates`, or **VSGrok: Check for Updates**) and offers an in-chat **Update now** card. The Marketplace steps below are kept for when we publish there; `publish.yml` is manual-only (`workflow_dispatch`) until then.

VS Code only auto-updates extensions installed from the **Visual Studio Marketplace** (or, in VSCodium / Cursor / other forks, from **Open VSX**). A `.vsix` installed by hand ("Install from VSIX…") never auto-updates. Once VSGrok is on the Marketplace, everyone who installed it from there (with auto-update on, the default) gets each new version automatically.

The publish workflow (`.github/workflows/publish.yml`) is already in the repo. When run manually (Actions → Publish → Run workflow) it installs, type-checks, lints, runs the tests, packages the `.vsix` and publishes to the Marketplace (if the `VSCE_PAT` secret exists) and Open VSX (if `OVSX_PAT` exists). A missing secret skips that step with a warning instead of failing.

`package.json` uses **publisher `GalacticOrgOfDev`** and extension name `vsgrok`, so the Marketplace id will be `GalacticOrgOfDev.vsgrok`. The publisher you create below must have exactly that ID (or change `"publisher"` in `package.json` to match the one you create).

> License: `package.json` and `LICENSE` say **MIT**. This still needs the owner's confirmation before the first public Marketplace release.

## One-time setup (owner only)

### 1. Azure DevOps organization (used only to issue the token)
1. Go to https://dev.azure.com and sign in with the Microsoft account that should own the extension.
2. Create an organization if you don't have one (any name, e.g. `galacticorgofdev`).

### 2. Personal Access Token for the Marketplace
1. In Azure DevOps: User settings (top right) → **Personal access tokens** → **New Token**.
2. Name: `vsce-vsgrok`. Organization: **All accessible organizations** (required, or publishing fails with 401).
3. Expiration: up to 1 year (put a reminder in your calendar).
4. Scopes: **Custom defined** → **Show all scopes** → **Marketplace** → tick **Manage**.
5. Create and copy the token (it is shown once).

### 3. Marketplace publisher
1. Go to https://marketplace.visualstudio.com/manage/createpublisher with the same Microsoft account.
2. **ID: `GalacticOrgOfDev`** (must equal `publisher` in package.json; the ID can't be changed later). Display name: e.g. `Galactic Org of Dev`.
3. Save. Optional: verify the publisher's domain later for the blue check mark.

### 4. Add the token as a GitHub secret
1. GitHub → `GalacticOrgOfDev/VSGrok` → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name **`VSCE_PAT`**, value: the token from step 2.

### 5. (Optional) Open VSX, for VSCodium / Cursor / Windsurf users
1. Sign in at https://open-vsx.org with GitHub and sign the Eclipse publisher agreement (profile → link Eclipse account).
2. Profile → **Access Tokens** → generate one.
3. Create the namespace once from a terminal: `npx ovsx create-namespace GalacticOrgOfDev -p <token>`.
4. Add the token as repository secret **`OVSX_PAT`**.

## Releasing a version
1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry; commit to `main`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z` (release.yml creates the GitHub Release).
3. Run **Actions → Publish (Marketplace, for later) → Run workflow**.
4. The Marketplace usually lists the new version within minutes; installed copies update on VS Code's next update check (or **Extensions → … → Check for Extension Updates**).

## Switching existing users from the sideloaded vsix
Anyone who installed a `.vsix` should uninstall it once and install **VSGrok** from the Extensions view (search "VSGrok", publisher GalacticOrgOfDev). The extension id is the same, so settings and the stored API key carry over.
