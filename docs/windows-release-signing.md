# Windows Release Signing

This repository currently builds Windows installers on GitHub Actions but does
not sign them. Unsigned Windows installers can still run, but Windows may show
SmartScreen warnings and mark the app as untrusted.

Tauri documents two practical approaches for Windows signing:

- a traditional code-signing certificate exported as `.pfx`
- Microsoft Trusted Signing / Azure-based signing through a custom sign command

For this repository, the `.pfx` approach is the simpler one if you already have
an exportable certificate and build on a Windows GitHub runner.

## When signing is worth doing

Windows signing is not as strict as macOS notarization, but it is still useful:

- reduces SmartScreen friction for downloaded installers
- improves trust for `.msi` and `-setup.exe` releases
- is required for some enterprise or store distribution scenarios

## Option 1: `.pfx` certificate on GitHub Actions

This is the simplest path if you have a Windows code-signing certificate that
can be exported as a `.pfx`.

### What you need

1. A Windows code-signing certificate from a trusted provider.
2. The certificate exported as a `.pfx` file.
3. The `.pfx` export password.

### GitHub secrets

Add these as **repository secrets**:

- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

Convert the `.pfx` into the `WINDOWS_CERTIFICATE` value:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx"))
```

Use that raw base64 string for:

- `WINDOWS_CERTIFICATE`

Use the `.pfx` export password for:

- `WINDOWS_CERTIFICATE_PASSWORD`

### Notes

- This repository would need a workflow update to consume those secrets.
- Tauri's GitHub Actions documentation describes this approach for Windows
  runners using `signtool`.
- Tauri notes that the simple OV certificate flow only applies to older OV
  certificates; if your issuer uses newer hardware- or cloud-backed signing,
  follow the issuer's instructions instead.

## Option 2: Microsoft Trusted Signing

Microsoft currently recommends Trusted Signing for Windows app signing.

This path is better if you do not want to manage a local exportable `.pfx`, but
it requires more Azure setup and a custom Tauri `signCommand`.

### What you need

1. A Trusted Signing account in Azure.
2. A certificate profile inside that Trusted Signing account.
3. A Microsoft Entra app registration with permission to sign.
4. A client secret for that app registration.

### Credentials you collect

- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TENANT_ID`

You also need the Trusted Signing account details used by the signing command:

- endpoint
- account name
- certificate profile name

### Notes

- Tauri documents this through a custom Windows `signCommand`.
- This repository does not currently implement that flow.
- If you choose this path, the workflow and `src-tauri/tauri.conf.json` need to
  be updated together.

## Recommendation for this repository

If you want the lowest-friction setup:

1. Start with a `.pfx`-based certificate if your issuer provides one.
2. Add `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` as repository
   secrets.
3. Update the Windows release workflow to use them on the `windows-latest`
   runner.

If your certificate provider uses hardware-backed or cloud-backed signing, skip
the `.pfx` route and implement Trusted Signing instead.

## References

- Tauri Windows code signing:
  https://tauri.app/distribute/sign/windows/
- Tauri GitHub Actions pipeline docs:
  https://v2.tauri.app/distribute/pipelines/github/
- Microsoft Smart App Control signing guidance:
  https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control
