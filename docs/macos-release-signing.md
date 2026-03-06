# macOS Release Signing

This repository publishes macOS builds through GitHub Actions. To avoid the
`Apple could not verify "Rakh.app"` warning, the macOS release jobs must sign
and notarize the app with Apple credentials.

The workflows expect GitHub **repository secrets**, not environment secrets.

## Required secrets

Add these secrets in GitHub under `Settings > Secrets and variables > Actions >
Repository secrets`:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY`
- `APPLE_API_KEY_P8`

## 1. Create a Developer ID Application certificate

Do not use an iOS distribution certificate like `ios_distribution.cer`. For a
standalone macOS app distributed outside the App Store, you need a
`Developer ID Application` certificate.

1. Open `Keychain Access`.
2. Go to `Keychain Access > Certificate Assistant > Request a Certificate From a Certificate Authority...`.
3. Save the CSR to disk.
4. In Apple Developer, open `Certificates, IDs & Profiles`.
5. Create a new certificate of type `Developer ID Application`.
6. Upload the CSR and download the resulting `.cer`.
7. Open the `.cer` file on the same Mac that created the CSR so it is added to
   Keychain with its private key.

In `Keychain Access > login > My Certificates`, confirm the certificate has an
attached private key. If it does not, the certificate was created from a CSR on
another machine and cannot be exported for CI from this Mac.

## 2. Export the certificate for GitHub Actions

1. In `Keychain Access`, right-click the `Developer ID Application: ...`
   certificate.
2. Export it as a `.p12` file.
3. Choose an export password.

Convert the `.p12` into the value used by `APPLE_CERTIFICATE`:

```bash
openssl base64 -A -in /path/to/DeveloperID.p12
```

Secret mapping:

- `APPLE_CERTIFICATE`: base64-encoded contents of the exported `.p12`
- `APPLE_CERTIFICATE_PASSWORD`: the password used when exporting the `.p12`

Get the signing identity string:

```bash
security find-identity -v -p codesigning
```

Use the full `Developer ID Application: ...` value for:

- `APPLE_SIGNING_IDENTITY`

Example:

```text
Developer ID Application: Amir Saboury (RZHQP7AUCG)
```

## 3. Create an App Store Connect API key for notarization

1. Open App Store Connect.
2. Go to `Users and Access > Integrations > Team Keys`.
3. Generate a new API key.
4. Set the access role to `Developer`.
5. Download the `.p8` file immediately. Apple only allows one download.

Secret mapping:

- `APPLE_API_ISSUER`: the App Store Connect `Issuer ID`
- `APPLE_API_KEY`: the App Store Connect `Key ID`
- `APPLE_API_KEY_P8`: the full contents of the downloaded `.p8` file

To copy the `.p8` contents:

```bash
cat /path/to/AuthKey_XXXXXXXXXX.p8
```

## 4. Add the secrets to GitHub

Create the following repository secrets with the mapped values:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY`
- `APPLE_API_KEY_P8`

This repository's release workflows read those secrets directly and write the
`.p8` key to a temporary file on macOS runners before invoking the Tauri build.

## 5. Publish a signed macOS release

After the secrets are in place:

1. Trigger a new release normally through the release workflow, or
2. Manually rerun the release build workflow for a tag if you need to replace
   existing macOS assets.

If you already downloaded an unsigned app, delete it and download the rebuilt
release again. Gatekeeper will continue to treat the old download as the old
artifact.
