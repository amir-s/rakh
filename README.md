# Rakh Website

Standalone marketing site for `rakh.sh`, built on Vite, React, TypeScript, Tailwind CSS v4, and `gh-pages`.

## Scripts

- `npm run dev` starts the local dev server.
- `npm run build` creates the production bundle in `dist/`.
- `npm run preview` serves the production bundle locally.
- `npm run typecheck` runs TypeScript without emitting files.
- `npm run deploy:clean` clears the local `gh-pages` cache.
- `npm run deploy` builds the site and publishes `dist/` to the `gh-pages` branch with the `rakh.sh` CNAME.
- `npm run deploy:dry-run` runs the same deploy flow locally without pushing.

## GitHub Pages setup

1. Push the source branch: `git push -u origin codex/website`
2. Run the first deployment from this branch: `npm install && npm run deploy`
3. In GitHub repository settings, set Pages to deploy from the `gh-pages` branch.
4. Add the `rakh.sh` custom domain in the Pages settings if it is not picked up automatically from `CNAME`.
5. Enable `Enforce HTTPS` after DNS finishes propagating.

## DNS for `rakh.sh`

GitHub’s current docs say an apex domain should use either:

- `ALIAS` or `ANAME` for `@` pointing to `amir-s.github.io`
- or all four `A` records for `@`:
  - `185.199.108.153`
  - `185.199.109.153`
  - `185.199.110.153`
  - `185.199.111.153`

Optional but recommended:

- `CNAME` for `www` pointing to `amir-s.github.io`

Source: [GitHub Docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
