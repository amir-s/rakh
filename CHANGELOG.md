# Changelog

## [0.19.0](https://github.com/amir-s/rakh/compare/rakh-v0.18.0...rakh-v0.19.0) (2026-03-19)


### Features

* add /ship pull request workflow ([c1573ef](https://github.com/amir-s/rakh/commit/c1573ef521210f17df94eb4ffe5c3d86d4f23447))
* **github:** add "Reference in Chat" and "Open in New Session" to issue modal ([#202](https://github.com/amir-s/rakh/issues/202)) ([3d72823](https://github.com/amir-s/rakh/commit/3d7282336bba5ed6d0640acceb771056979d6b2d))


### Bug Fixes

* **agent-runtime:** keep the main prompt static per session ([3d948e7](https://github.com/amir-s/rakh/commit/3d948e734844098d8f4d8d86e97dc1f410faca6f))
* **agent-runtime:** refresh prompt only during compaction ([#208](https://github.com/amir-s/rakh/issues/208)) ([feaba11](https://github.com/amir-s/rakh/commit/feaba11fcec1870eabd521596455f8b91bc589be))
* **agent-runtime:** stabilize main system prompt cache ([e1eb8a7](https://github.com/amir-s/rakh/commit/e1eb8a7a9d2e62cf192ebe553c9f30bee362f26c))
* **tauri:** separate dev app identity from prod ([f976cd5](https://github.com/amir-s/rakh/commit/f976cd5b6e659e6f74c015648fcf4740d49c8a26))

## [0.18.0](https://github.com/amir-s/rakh/compare/rakh-v0.17.1...rakh-v0.18.0) (2026-03-19)


### Features

* add anthropic prompt caching breakpoints ([3955861](https://github.com/amir-s/rakh/commit/3955861ed73a20b81abe79c00111217735b50fa5))
* add clickable markdown file references ([c530ec4](https://github.com/amir-s/rakh/commit/c530ec46bbcc432f611daf4e7f953734e70e9cf3))
* add GitHub issues command bar integration ([27ebb83](https://github.com/amir-s/rakh/commit/27ebb83e6167be4c14f97e069ae0b26a00e0764c)), closes [#127](https://github.com/amir-s/rakh/issues/127)
* **agent:** add configurable main loop safeguards ([684fb1e](https://github.com/amir-s/rakh/commit/684fb1edfe8e367df63074bcb28ddae38da36205))
* **markdown:** add mermaid zoom controls ([96e2253](https://github.com/amir-s/rakh/commit/96e22531a78b7e47d25726063a3f6981c8ba22a7))
* **markdown:** render mermaid diagrams ([eb1c92f](https://github.com/amir-s/rakh/commit/eb1c92fccc3c9dd03251b1b145952e4c070c453c))
* **session-cost:** add toggleable cost component charts ([9323afa](https://github.com/amir-s/rakh/commit/9323afacd77c23a256d8df5a5fbd093aec6718ce))


### Bug Fixes

* always show workspace command bar ([4968df2](https://github.com/amir-s/rakh/commit/4968df29b20186fadcf15ae24858cd735f3a6761)), closes [#127](https://github.com/amir-s/rakh/issues/127)
* polish GitHub issues popover ([6b1176a](https://github.com/amir-s/rakh/commit/6b1176aff16e868089733a8e0f0681397e227979)), closes [#127](https://github.com/amir-s/rakh/issues/127)
* refine GitHub issues interactions ([8232f1a](https://github.com/amir-s/rakh/commit/8232f1ae4eacf1661714702f9be85ac7c1521aff)), closes [#127](https://github.com/amir-s/rakh/issues/127)

## [0.17.1](https://github.com/amir-s/rakh/compare/rakh-v0.17.0...rakh-v0.17.1) (2026-03-18)


### Bug Fixes

* hide tool io compaction when disabled ([b204581](https://github.com/amir-s/rakh/commit/b204581f35b4c1f0ca107b9b9773f88d1e544de9))
* **logging:** organize agent runtime logs ([52001fd](https://github.com/amir-s/rakh/commit/52001fd2d39907ab388ec3d55ba6c31888aee5cc))
* **ui:** correct session cost chart axes ([11699a9](https://github.com/amir-s/rakh/commit/11699a9b553c1017bb7c2e1a3d00948194250bc9))

## [0.17.0](https://github.com/amir-s/rakh/compare/rakh-v0.16.0...rakh-v0.17.0) (2026-03-18)


### Features

* **ui:** show compaction flare on tool icons ([b03d7a1](https://github.com/amir-s/rakh/commit/b03d7a111559a13c3506d9986a49ba8915738e02))


### Bug Fixes

* allow hidden tool io compaction params ([d5b9124](https://github.com/amir-s/rakh/commit/d5b9124efc01a3093eaaef9c25e778df7e47813c))

## [0.16.0](https://github.com/amir-s/rakh/compare/rakh-v0.15.1...rakh-v0.16.0) (2026-03-17)


### Features

* add instant chart tooltips ([c6b7e54](https://github.com/amir-s/rakh/commit/c6b7e54ec656a1d27e7af1b56faa8eaf83684a77))
* add session cost modal ([ecf3dd2](https://github.com/amir-s/rakh/commit/ecf3dd2ca4da6a2c281d1ec14774c547e08e3c14))


### Bug Fixes

* show cumulative totals in cost tooltip ([d6615a5](https://github.com/amir-s/rakh/commit/d6615a53b8ae6fde25a84ffe7a9784c25be2f45b))

## [0.15.1](https://github.com/amir-s/rakh/compare/rakh-v0.15.0...rakh-v0.15.1) (2026-03-17)


### Bug Fixes

* show automatic compaction subagent output ([cfe80ef](https://github.com/amir-s/rakh/commit/cfe80ef89cdd363526e46c3872cc89d6313557ff))
* store compacted history as user handoff ([949c29b](https://github.com/amir-s/rakh/commit/949c29b14a98431337c9db28e549580f5245287b))
* use synthetic compacted-history handoff ([b0412a0](https://github.com/amir-s/rakh/commit/b0412a025c5da5f7a2be9493931964e5a4881bfc))

## [0.15.0](https://github.com/amir-s/rakh/compare/rakh-v0.14.0...rakh-v0.15.0) (2026-03-17)


### Features

* add context compaction controls and auto-compactor ([3349790](https://github.com/amir-s/rakh/commit/33497902e24cd849d15500eb5bf8b9489b79e2ae)), closes [#184](https://github.com/amir-s/rakh/issues/184)
* add project learned-facts memory ([6bf111e](https://github.com/amir-s/rakh/commit/6bf111e9b4563bc4cb23f5d98b2e39e60db196f3))
* add settings-managed rakh launcher ([1ec2695](https://github.com/amir-s/rakh/commit/1ec26954dfce2526ea0faf579e72a8ef0fbd28ca))
* **agent:** add manual context compaction ([3bd0bcf](https://github.com/amir-s/rakh/commit/3bd0bcfb702760ea5f33034197b0d63e1d2f415c))
* **agent:** support removing project memory facts ([dc62188](https://github.com/amir-s/rakh/commit/dc62188df19bf507cbd9951067c767eede3764d6))
* **chat:** add bubble copy and fork actions ([1d55edb](https://github.com/amir-s/rakh/commit/1d55edb2816270e8c2c0084db0ed3b4d42390461))
* **chat:** show copy success feedback ([ff9b8ab](https://github.com/amir-s/rakh/commit/ff9b8abef7f66c3964f1a8d200767fc7069b84d5))
* **project-memory:** assign stable ids to learned facts ([f32cc64](https://github.com/amir-s/rakh/commit/f32cc648a411d327c57d0e60e572fa7c07f8bbb2)), closes [#181](https://github.com/amir-s/rakh/issues/181)


### Bug Fixes

* **agent:** harden project memory updates ([c93fc3f](https://github.com/amir-s/rakh/commit/c93fc3f5e919042e43cfd9b676d896f9450123f2))
* always include .github dir regardless of includeHidden flag ([ecace28](https://github.com/amir-s/rakh/commit/ecace28fa4de193835edd33d3f2099362e6ee1cb)), closes [#172](https://github.com/amir-s/rakh/issues/172)
* **chat:** align trace action with bubble controls ([14d121b](https://github.com/amir-s/rakh/commit/14d121bdcfd0b4ecac512b6909e901ede8ab72c3))
* refresh model metadata when restoring sessions ([6c71327](https://github.com/amir-s/rakh/commit/6c71327bb148e8cde46a90d3b1bf72982cef3451))
* **settings:** persist compaction config on disk ([7073349](https://github.com/amir-s/rakh/commit/70733490c231265f9a193fa9b29ee7ab684ac6d0))

## [0.14.0](https://github.com/amir-s/rakh/compare/rakh-v0.13.0...rakh-v0.14.0) (2026-03-15)


### Features

* add session usage stats ([6c92920](https://github.com/amir-s/rakh/commit/6c92920dcdb4ce4f39ae6097bca2383af10de261))
* **context-gateway:** add debug compaction snapshots ([8722f2e](https://github.com/amir-s/rakh/commit/8722f2e54c90ba5bbbb62fad0f694f9d573dfbe0))
* **context-gateway:** add todo policy foundation ([845ec2c](https://github.com/amir-s/rakh/commit/845ec2c4fa3326e66a6f71d7bc5433f253741c32))
* **context-gateway:** compact api history and normalize todo notes ([6f89fc9](https://github.com/amir-s/rakh/commit/6f89fc9c20148df6e23e26809eaa4ac1c43ab391))
* **logging:** add logs window search ([9f31651](https://github.com/amir-s/rakh/commit/9f31651d1bbafc78644f0139be559d1f08fbd16f))
* **settings:** persist gateway policy config ([b5f490c](https://github.com/amir-s/rakh/commit/b5f490c22b47729e54771b1b2be6b84b9ce74fe8))
* **settings:** use icon actions for gateway policies ([db1ed6f](https://github.com/amir-s/rakh/commit/db1ed6fed94c2e2f0a893ce926b6967a828a9f9f))
* **tool-gateway:** artifactize and summarize oversized tool outputs ([9a2a580](https://github.com/amir-s/rakh/commit/9a2a58002ab009e9d0cd9cc29ab24537e30de578))
* **tool-gateway:** show per-tool compaction progress ([cb4214f](https://github.com/amir-s/rakh/commit/cb4214fba8dba31333eb06a110651591f778a05d))


### Bug Fixes

* handle missing usage ledger in persistence ([9c8f62c](https://github.com/amir-s/rakh/commit/9c8f62cbe66bb2c336b7d1e3ad1f4c4a1bcd9d05))
* **settings:** avoid effect-driven gateway policy resets ([97ceecf](https://github.com/amir-s/rakh/commit/97ceecf5647ed4f52a6ee3af3bc23157dbe590ff))
* **tests:** align rebased session schema and queue drain timing ([a18c754](https://github.com/amir-s/rakh/commit/a18c7546200fa09be9ac6dbccc02dc19b4631f7e))

## [0.13.0](https://github.com/amir-s/rakh/compare/rakh-v0.12.0...rakh-v0.13.0) (2026-03-14)


### Features

* add debug mode setting and log viewer shortcut ([fc59f8b](https://github.com/amir-s/rakh/commit/fc59f8b8c25edf610e4180bcdbf7a35010f92f41))
* inherit session icons from projects ([51734a2](https://github.com/amir-s/rakh/commit/51734a2b0ae65618f7c1c32525c021dcff4d553d))
* persist projects in config and add project icons ([7a80fb4](https://github.com/amir-s/rakh/commit/7a80fb44dcf6541209809481a8c34c52c7e83293))
* **settings:** add models.dev provider prefills ([3625800](https://github.com/amir-s/rakh/commit/362580038e692e80c710f67276e075efd5e5168a))
* **settings:** support custom model metadata ([5fda5fe](https://github.com/amir-s/rakh/commit/5fda5fe2ffcf00035967e41a40eb4a5b3d904d7e))


### Bug Fixes

* **settings:** show models.dev matches in a popover ([8e71332](https://github.com/amir-s/rakh/commit/8e713320cc9110b83f2811eca410206b26b4a4d3))
* **test:** await menu close assertion in ArchivedTabsMenu test ([0e066ac](https://github.com/amir-s/rakh/commit/0e066acd17dde0dd7b636c3fecce5e758e0109b4))

## [0.12.0](https://github.com/amir-s/rakh/compare/rakh-v0.11.0...rakh-v0.12.0) (2026-03-13)


### Features

* **logging:** revamp logs window controls ([f05d458](https://github.com/amir-s/rakh/commit/f05d45843da2b4f1c99db804974623bc97076cd9))


### Bug Fixes

* emit session_changed for archived session sync ([58eb620](https://github.com/amir-s/rakh/commit/58eb620cdd741e7176f0e26c1d5a233d16492e22))
* gate trace log actions behind debug mode ([32f50fa](https://github.com/amir-s/rakh/commit/32f50fa3e71e09c05358a1ffc6ec17f5ad24778d))
* highlight filtered log row ids ([dda74f6](https://github.com/amir-s/rakh/commit/dda74f6db2ee53e1394f4394e06d1af73c8aa1f9))
* keep pinned tabs visible while open ([7fbbdf6](https://github.com/amir-s/rakh/commit/7fbbdf661ca7825dde31ce7efeec5e4283e6f675))
* **logging:** persist clear as a since filter ([254500c](https://github.com/amir-s/rakh/commit/254500c9cdb5da7b12ffd0d995550ed969c68e91))
* **logging:** polish detached logs window behavior ([c1fde2b](https://github.com/amir-s/rakh/commit/c1fde2b99dfec4f9a162cf73206df7631647fc91))
* polish log row actions ([019e207](https://github.com/amir-s/rakh/commit/019e20731da7de2d3aa51424a4492af144a99cd1))
* restore log row id filters ([493d5dd](https://github.com/amir-s/rakh/commit/493d5ddcf5e0bd1a5159f53bed6f9ce275d0be26))
* simplify expanded grouped tool call header ([63c4771](https://github.com/amir-s/rakh/commit/63c4771bd65f97bd7e00fc5ac7c6c72e6e6bbad1))

## [0.11.0](https://github.com/amir-s/rakh/compare/rakh-v0.10.0...rakh-v0.11.0) (2026-03-13)


### Features

* add detached log viewer window ([770b5dd](https://github.com/amir-s/rakh/commit/770b5dd12d8f4a04db32b2785255a53644b8b395)), closes [#135](https://github.com/amir-s/rakh/issues/135)
* **chrome:** pin tabs from the top bar ([ac5bcb3](https://github.com/amir-s/rakh/commit/ac5bcb3f90baac3fe14b08d2bbb8d66db04ad44e))
* **logging:** add infrastructure-first structured logging ([5290f7a](https://github.com/amir-s/rakh/commit/5290f7af05448186f9d65799dbccbb033ad0119a))
* **sessions:** add pinned recent tabs ([b502721](https://github.com/amir-s/rakh/commit/b50272143a14fb1f4a0c85a389a2ee503f858ba5)), closes [#143](https://github.com/amir-s/rakh/issues/143)


### Bug Fixes

* **agent:** align static catalog with models.dev ([b73e0ff](https://github.com/amir-s/rakh/commit/b73e0ff497e2840640fdbbb69b627236cb3aabba))
* group inline tool calls across assistant messages ([d0aad0a](https://github.com/amir-s/rakh/commit/d0aad0a313b18ecf427b2888b1f5f56dbf7405a4))

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
