# Contributing to Rakh

Thank you for your interest in contributing to Rakh! 

## Conventional Commits & Our Release Workflow

We use [Release Please](https://github.com/googleapis/release-please) to automate our versioning, changelog generation, and GitHub Releases. To make this work, **all commits must follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification.**

### How it works

1. **Develop:** You write code and commit using Conventional Commits.
2. **Push/Merge:** When commits are pushed or merged into the `main` branch, the `Release Please` GitHub Action runs.
3. **Release PR:** Release Please automatically calculates the next semantic version, updates the version in `package.json` and `src-tauri/tauri.conf.json`, curates a `CHANGELOG.md`, and opens a "Release PR".
4. **Publishing:** We merge the Release PR when we are ready to publish a new version.
5. **Build & Release:** Merging the Release PR triggers the creation of a GitHub tag. This triggers the `Build and Publish Release` workflow, which compiles the Mac, Windows, and Linux binaries and attaches them to the new GitHub Release.

### Shipping a pull request with `/ship`

Maintainers can comment `/ship` on an open pull request to arm it for merge. The `PR Ship Command` workflow will merge the PR itself after all required checks and reviews pass, so this does not depend on GitHub's **Allow auto-merge** repository setting.

- Only collaborators with `write`, `maintain`, or `admin` access can use `/ship`.
- Comment `/unship` to cancel a pending `/ship`.
- The workflow uses a non-squash strategy (`rebase` if available, otherwise a regular merge commit) so the branch's individual Conventional Commit messages still land on `main` for Release Please.
- Repository admins must allow either **Rebase merging** or **Merge commits** in GitHub repository settings.
- Branch protection for `main` must require the CI checks from `.github/workflows/ci.yml`, currently `Frontend (typecheck, lint, test)` and `Rust (cargo test)`.
- The workflow uses an internal `ship` label to remember which pull requests should merge on the next successful CI, review, or scheduled retry.

### Commit Message Format

Your commit messages should be structured as follows:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

#### Allowed Types:

* **`feat`**: Adds a new feature to the codebase (correlates with `MINOR` in Semantic Versioning).
* **`fix`**: Patches a bug in the codebase (correlates with `PATCH` in Semantic Versioning).
* **`docs`**: Documentation only changes.
* **`style`**: Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc).
* **`refactor`**: A code change that neither fixes a bug nor adds a feature.
* **`perf`**: A code change that improves performance.
* **`test`**: Adding missing tests or correcting existing tests.
* **`build`**: Changes that affect the build system or external dependencies.
* **`ci`**: Changes to our CI configuration files and scripts.
* **`chore`**: Other changes that don't modify src or test files.
* **`revert`**: Reverts a previous commit.

#### Breaking Changes

If your commit introduces a breaking change, you **MUST** include `BREAKING CHANGE:` in the footer or append a `!` after the type/scope. This correlates with `MAJOR` in Semantic Versioning.

**Examples:**

```
feat: add local LLM support
```

```
fix(terminal): resolve crash when resizing window rapidly
```

```
feat(api)!: change database schema for user profiles

BREAKING CHANGE: The `user_id` field has been renamed to `uuid` and its type changed to a UUID string.
```

## Local Development Requirements

1. **Node.js**: v20 or later
2. **Rust**: stable toolchain
3. **OS Dependencies**: See the [Tauri prerequisites guide](https://tauri.app/v1/guides/getting-started/prerequisites) for Linux/Windows/MacOS specific setup.

### Running the App Locally

To start the development server and the Tauri window simultaneously, run:

```bash
npm install
npm run tauri:dev
```
