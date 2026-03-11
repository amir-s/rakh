# Changelog

## [0.10.0](https://github.com/amir-s/rakh/compare/rakh-v0.9.0...rakh-v0.10.0) (2026-03-11)


### Features

* **chrome:** group and search archived tabs ([813220b](https://github.com/amir-s/rakh/commit/813220b7d20c63f4e30aa9b387140b7739e7c9e6))


### Bug Fixes

* **approvals:** add command allow and deny lists ([#131](https://github.com/amir-s/rakh/issues/131)) ([b6d3069](https://github.com/amir-s/rakh/commit/b6d30699631437d5562906234fae51240f60a1bb))
* **exec:** sanitize ANSI control sequences in command output ([#124](https://github.com/amir-s/rakh/issues/124)) ([218045a](https://github.com/amir-s/rakh/commit/218045ac40ab8944defe4235c672cc6bdda83b7f))
* **storage:** repair session saves and surface save status ([ff909df](https://github.com/amir-s/rakh/commit/ff909dfdf7e92767af338f3fdedeb4d7b4834e3d))
* **tauri:** register external tool commands ([#125](https://github.com/amir-s/rakh/issues/125)) ([daca921](https://github.com/amir-s/rakh/commit/daca9219bb965d7866bd052ae9d9421812609a03))

## [0.9.0](https://github.com/amir-s/rakh/compare/rakh-v0.8.0...rakh-v0.9.0) (2026-03-11)


### Features

* add chat attention jump controls ([#122](https://github.com/amir-s/rakh/issues/122)) ([4a63bf2](https://github.com/amir-s/rakh/commit/4a63bf262ffc9de0d98192b27dbc3ec0266ee028))
* group inline tool calls ([#123](https://github.com/amir-s/rakh/issues/123)) ([3d4902a](https://github.com/amir-s/rakh/commit/3d4902aa8ca1eba92bd70cec2d2dfd926a7b4786))
* **worktree:** add detached handoff workflow ([#96](https://github.com/amir-s/rakh/issues/96)) ([49eb8ed](https://github.com/amir-s/rakh/commit/49eb8ed7c242e75e270f1990db0a33db8fb46b5b))


### Bug Fixes

* **workspace:** show stop button while busy ([#120](https://github.com/amir-s/rakh/issues/120)) ([1e45a51](https://github.com/amir-s/rakh/commit/1e45a51bfcc3224b70def2eb3e32036ed7860fe3))

## [0.8.0](https://github.com/amir-s/rakh/compare/rakh-v0.7.0...rakh-v0.8.0) (2026-03-10)


### Features

* **ui:** change Rakh chat icon to chess_knight ([#114](https://github.com/amir-s/rakh/issues/114)) ([b91e61e](https://github.com/amir-s/rakh/commit/b91e61e8856c2fd42763ea92cc618b2c149dce8b))


### Bug Fixes

* **desktop:** add tray status and focus behavior ([#113](https://github.com/amir-s/rakh/issues/113)) ([0875eef](https://github.com/amir-s/rakh/commit/0875eeffa933a4774271c5054e3a3fc22f0378f0))

## [0.7.0](https://github.com/amir-s/rakh/compare/rakh-v0.6.0...rakh-v0.7.0) (2026-03-10)


### Features

* add MCP settings registry and attachment artifacts ([#112](https://github.com/amir-s/rakh/issues/112)) ([d699000](https://github.com/amir-s/rakh/commit/d6990007be209e8d97209dbecbaa4be94cae3ea8))
* **workspace:** add editor and shell quick actions ([#102](https://github.com/amir-s/rakh/issues/102)) ([0304c02](https://github.com/amir-s/rakh/commit/0304c024c366659bfca54f9a23781659ef8c57d6)), closes [#99](https://github.com/amir-s/rakh/issues/99)


### Bug Fixes

* isolate parallel subagent chat threads ([#111](https://github.com/amir-s/rakh/issues/111)) ([bdd8d9d](https://github.com/amir-s/rakh/commit/bdd8d9df247c3b44aba9d7b6e513cd496d5f865b))

## [0.6.0](https://github.com/amir-s/rakh/compare/rakh-v0.5.0...rakh-v0.6.0) (2026-03-10)


### Features

* add communication profiles for steering agent behavior ([#93](https://github.com/amir-s/rakh/issues/93)) ([12007bf](https://github.com/amir-s/rakh/commit/12007bf07707b58d7634c3a18d058737c4cc8298))
* add project setup config workflows ([#94](https://github.com/amir-s/rakh/issues/94)) ([225fbab](https://github.com/amir-s/rakh/commit/225fbabd68b0cdfeb98cfb976926de5f56813be5))
* **desktop:** badge app icon for agent attention ([#97](https://github.com/amir-s/rakh/issues/97)) ([1d56d61](https://github.com/amir-s/rakh/commit/1d56d612072d94b6ffa8bcaf968343990448061a))
* image attachment support in chat ([#87](https://github.com/amir-s/rakh/issues/87)) ([b9bb215](https://github.com/amir-s/rakh/commit/b9bb215c591526a10aac3b33f843a4269fcc90c5))
* model picker modal for /model command ([#39](https://github.com/amir-s/rakh/issues/39)) ([#91](https://github.com/amir-s/rakh/issues/91)) ([2b46d39](https://github.com/amir-s/rakh/commit/2b46d39de276ea5cbe7b9cce7bd65f441b38e150))
* replace artifact polling with Tauri push events ([#85](https://github.com/amir-s/rakh/issues/85)) ([edc9043](https://github.com/amir-s/rakh/commit/edc90437575082f7d58b1ef58bdc061e4c045313))
* **workspace:** add project command shortcuts bar ([#98](https://github.com/amir-s/rakh/issues/98)) ([32f0a20](https://github.com/amir-s/rakh/commit/32f0a20474dfe6a3d13618548b9cb32aee8bec3e))


### Bug Fixes

* add busy-state queueing and steering ([#90](https://github.com/amir-s/rakh/issues/90)) ([7a12cfe](https://github.com/amir-s/rakh/commit/7a12cfed1cfe411864a4b2ddae3a4327f6a8af10))
* **at-mention:** re-focusing the chat input will refresh file list autocomplete for at mentions ([#89](https://github.com/amir-s/rakh/issues/89)) ([c948298](https://github.com/amir-s/rakh/commit/c94829848727be7628771d8b7d6e0180da887662))
* **runner:** preserve user message in chatMessages during retry ([#88](https://github.com/amir-s/rakh/issues/88)) ([dbe6cff](https://github.com/amir-s/rakh/commit/dbe6cffb5f95faae16304295871e314ecdfe1135))

## [0.5.0](https://github.com/amir-s/rakh/compare/rakh-v0.4.0...rakh-v0.5.0) (2026-03-09)


### Features

* add execute action for plan artifact cards ([#81](https://github.com/amir-s/rakh/issues/81)) ([5dff6c3](https://github.com/amir-s/rakh/commit/5dff6c32c20c1599f540e2d5da7b41b64cfac41b))
* **settings:** migrate settings to singleton tab ([#75](https://github.com/amir-s/rakh/issues/75)) ([79edbba](https://github.com/amir-s/rakh/commit/79edbbae8d51b85fecc4da5ec26ebc7c6c6f5585))
* support issue and pr templates in github subagent ([#79](https://github.com/amir-s/rakh/issues/79)) ([98ae34e](https://github.com/amir-s/rakh/commit/98ae34ef8f8af7ba891a4850e72a44c8bee89bdb))
* **ui:** enhance tab tooltip status popover ([#63](https://github.com/amir-s/rakh/issues/63)) ([637fc41](https://github.com/amir-s/rakh/commit/637fc416a847a16b7f4d80baf0eecbd6db98c842))


### Bug Fixes

* **approvals:** scope pending approvals by tab id ([#76](https://github.com/amir-s/rakh/issues/76)) ([e52e46c](https://github.com/amir-s/rakh/commit/e52e46c7f3b6923d1ff9f399ab02f9b706446624))
* **ci:** checkout repo before updating Cargo.lock ([#83](https://github.com/amir-s/rakh/issues/83)) ([ff59118](https://github.com/amir-s/rakh/commit/ff59118c634066b2bea93dd0bb0fdc6531ca3511))
* **ci:** fetch release branch via FETCH_HEAD ([#84](https://github.com/amir-s/rakh/issues/84)) ([4fbe34f](https://github.com/amir-s/rakh/commit/4fbe34f6deca1fdfd8d433bb9e2562e90bff50ff))
* **debug:** simplify shrink toggle in debug pane ([#78](https://github.com/amir-s/rakh/issues/78)) ([5d3bb32](https://github.com/amir-s/rakh/commit/5d3bb32bd46cb2b9c429db35d43c6bbaa798da6d))
* hide broken ⌘+K shortcut hint and expand subagent messages ([#65](https://github.com/amir-s/rakh/issues/65)) ([8c9e4b6](https://github.com/amir-s/rakh/commit/8c9e4b61d7f1b72c4bfff8a3a1c3adb53542009a))
* **notifications:** send attention alerts for inactive tabs ([#80](https://github.com/amir-s/rakh/issues/80)) ([767f50d](https://github.com/amir-s/rakh/commit/767f50da6b499da8d2877d89aff654a40fc6552b))
* **release:** update Cargo.lock when release PR is created ([#82](https://github.com/amir-s/rakh/issues/82)) ([3287e9d](https://github.com/amir-s/rakh/commit/3287e9dede5603b5e7bf4cc7ce8f06a6db2d6fe1))
* support tab middle-click close and reopen shortcut ([#62](https://github.com/amir-s/rakh/issues/62)) ([e18dc11](https://github.com/amir-s/rakh/commit/e18dc116b00169be4277907b7642ef02a1403865))
* synthesize error results for incomplete tool calls on stop ([#74](https://github.com/amir-s/rakh/issues/74)) ([2f6c607](https://github.com/amir-s/rakh/commit/2f6c60725e10256e454f9e59c5b3bbb718c13e46))

## [0.4.0](https://github.com/amir-s/rakh/compare/rakh-v0.3.2...rakh-v0.4.0) (2026-03-08)


### Features

* **chat:** add slash command autocomplete ([#7](https://github.com/amir-s/rakh/issues/7)) ([#53](https://github.com/amir-s/rakh/issues/53)) ([258b107](https://github.com/amir-s/rakh/commit/258b107e8c6d388f8edb6da95be574ba86d4f092))
* **chat:** replace workspace textarea with lexical editor ([#49](https://github.com/amir-s/rakh/issues/49)) ([29d889c](https://github.com/amir-s/rakh/commit/29d889cdbe80dd721c3f33d680898311eef4e3ed))

## [0.3.2](https://github.com/amir-s/rakh/compare/rakh-v0.3.1...rakh-v0.3.2) (2026-03-08)


### Bug Fixes

* add macOS microphone entitlement for production builds ([#47](https://github.com/amir-s/rakh/issues/47)) ([8697c9c](https://github.com/amir-s/rakh/commit/8697c9c799a1d79db8cadc8015c5488b9306c95c))

## [0.3.1](https://github.com/amir-s/rakh/compare/rakh-v0.3.0...rakh-v0.3.1) (2026-03-07)


### Bug Fixes

* pin tauri action to published tag ([#44](https://github.com/amir-s/rakh/issues/44)) ([2f69f53](https://github.com/amir-s/rakh/commit/2f69f53870dda1fb4d7040ae064357395d9bf2b4))

## [0.3.0](https://github.com/amir-s/rakh/compare/rakh-v0.2.0...rakh-v0.3.0) (2026-03-07)


### Features

* add /model slash command to swap active model mid-conversation ([#38](https://github.com/amir-s/rakh/issues/38)) ([6c6c31c](https://github.com/amir-s/rakh/commit/6c6c31c88bf87de3916187958482cf71a939aeb9))
* add CI workflow to run tests on every pull request ([f763ece](https://github.com/amir-s/rakh/commit/f763ece57468325bcabb17e964ed5f0085debd49))
* integrate Tauri updater ([#42](https://github.com/amir-s/rakh/issues/42)) ([b9dfd32](https://github.com/amir-s/rakh/commit/b9dfd329a63383aa0eeaa167485f3d79b6f17f89))
* move provider config from IndexedDB to disk at ~/.rakh/config ([#43](https://github.com/amir-s/rakh/issues/43)) ([c68ad90](https://github.com/amir-s/rakh/commit/c68ad900aa66b59c6740325c64c477ffe761e34c)), closes [#31](https://github.com/amir-s/rakh/issues/31)


### Bug Fixes

* **chrome:** prevent macOS titlebar double-click rollback ([#34](https://github.com/amir-s/rakh/issues/34)) ([b0934bd](https://github.com/amir-s/rakh/commit/b0934bdd16c372a5eebac70448a3573d0ee3b4ac))
* **storage:** separate debug app store root from release ([#33](https://github.com/amir-s/rakh/issues/33)) ([f47b23c](https://github.com/amir-s/rakh/commit/f47b23c09ff084e9434ec0d82b61ada6d3d271a6))

## [0.2.0](https://github.com/amir-s/rakh/compare/rakh-v0.1.3...rakh-v0.2.0) (2026-03-07)


### Features

* add summary and artifact conversation cards ([#16](https://github.com/amir-s/rakh/issues/16)) ([2144446](https://github.com/amir-s/rakh/commit/21444466453bca253c0e82ceb8b5288bc8d892c6))

## [0.1.3](https://github.com/amir-s/rakh/compare/rakh-v0.1.2...rakh-v0.1.3) (2026-03-07)


### Bug Fixes

* avoid showing archived session artifacts in new tabs ([#3](https://github.com/amir-s/rakh/issues/3)) ([c626956](https://github.com/amir-s/rakh/commit/c62695683555453f8dab25636167fcd238000f2f))

## [0.1.2](https://github.com/amir-s/rakh/compare/rakh-v0.1.1...rakh-v0.1.2) (2026-03-06)


### Bug Fixes

* **tauri:** use drag drop config compatible with v2 builds ([c011204](https://github.com/amir-s/rakh/commit/c01120481d3dcd60e0369a4df50de17fc0aeb481))

## [0.1.1](https://github.com/amir-s/rakh/compare/rakh-v0.1.0...rakh-v0.1.1) (2026-03-06)


### Bug Fixes

* trigger release pipeline ([a9dc093](https://github.com/amir-s/rakh/commit/a9dc093731fe6a4af2b265a7a0f9943d5db0593d))
