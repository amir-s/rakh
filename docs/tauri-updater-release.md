# Tauri Updater Release Notes

Rakh uses the Tauri updater plugin with GitHub Releases `latest.json`.
The app checks the stable channel only:

- endpoint: `https://github.com/amir-s/rakh/releases/latest/download/latest.json`
- installer mode on Windows: `passive`
- release artifacts: signed updater bundles plus `latest.json`

## One-time setup

Generate an updater signing keypair:

```bash
npm run tauri signer generate -- --ci -w ~/.tauri/rakh-updater.key
```

Keep the private key out of the repository. The public key belongs in
`src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.

Add these GitHub repository secrets before running the release workflows:

- `TAURI_SIGNING_PRIVATE_KEY`
  - Set this to the full contents of `~/.tauri/rakh-updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  - Optional. Leave unset if the key was generated without a password.

The release workflows already pass both secrets to `tauri-action@v1` and upload
`latest.json`.

## First updater-capable rollout

The first release that contains updater support cannot update older installed
versions automatically if those older versions shipped without the updater.
Ship the first updater-enabled version as a normal download/install release.

After that release is installed, validate the updater with a second release:

1. Publish a higher app version through the normal release flow.
2. Confirm the GitHub Release contains `latest.json`, updater bundles, and
   matching `.sig` files.
3. Launch the previously installed updater-enabled build.
4. Open `Settings` -> `App Updates`.
5. Verify `Check for updates` finds the new version.
6. Install the update and confirm the app restarts on the new version.

## Operational notes

- If the private key changes, existing installations will stop trusting future
  updates. Rotate only if you intentionally want to break the updater trust
  chain.
- Missing signing secrets will cause updater artifact generation to fail in CI.
- The local development browser and preview mode intentionally no-op the updater
  code path.
