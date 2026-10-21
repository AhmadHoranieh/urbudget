# Release status

Reviewed 21 October 2026. Update this page after a release or a verified account milestone.

| Platform | Status |
| --- | --- |
| Desktop | Published [v1.0.7](https://github.com/AhmadHoranieh/local-budget/releases/tag/v1.0.7), tag commit `9f5a9dd`, on 21 October 2026. Windows and universal macOS installers and signed update packages are live on urbudget.app. |
| Shared source | Desktop 1.0.7 is published, including reviewed YNAB and bank-import fixes, budget totals and editing improvements, and Store update support. The native Android and iOS apps are on `main`; each app now has its own version, `desktop-v`/`android-v`/`ios-v` tags and release workflow ([RELEASING.md](../RELEASING.md)). |
| Microsoft Store | The [1.0.7 submission workflow](https://github.com/AhmadHoranieh/local-budget/actions/runs/39505002258) passed. Store certification and availability are not yet verified. |
| Android | Native app source version `1.0.7` (version code 1000007), package `app.urbudget`. Not submitted to Play as of the last verified setup session. The release workflow hasn't run: the `google-play` environment has no upload-key secrets yet. The Tauri phone build it replaces was removed. |
| iOS | Native app source version `1.0.7`, bundle `app.urbudget`. Simulator tests pass and a debug build ran on an iPhone; store purchases remain release work. The release workflow hasn't run: it needs the App Store Connect app record and API key. The Tauri phone build it replaces was removed. |

The 1.0.7 source review at `f9ea19e` passed 617 UI tests and 406 Rust tests, TypeScript checks,
the production frontend build, and a Windows native debug build. Manual review used an isolated
sample budget and was accepted before the version bump. Three opt-in Rust benchmarks were
left ignored. Evidence is retained locally in `reports/merge-main-*.log` and
`reports/manual-review-app-build.log`; these results do not confirm signed installers or publication.
After the version bump, `npm run check` also passed for 1.0.7 (production build, 617 UI tests,
406 Rust tests), recorded in `reports/release-1.0.7-check.log`.

The 1.0.7 [installer build](https://github.com/AhmadHoranieh/local-budget/actions/runs/39502213347),
[app validation](https://github.com/AhmadHoranieh/local-budget/actions/runs/39502214032), and
[publication](https://github.com/AhmadHoranieh/local-budget/actions/runs/39505002370) passed.
Live Windows/macOS installers returned HTTP 200 and matched GitHub asset sizes and digests.
Windows x64 and both macOS architectures offer signed 1.0.7 updates to 1.0.6 clients and return
HTTP 204 to 1.0.7 clients. Release notes match the approved changelog. Evidence is retained locally
in `reports/release-1.0.7-live-verification.json`.

The older Android upload bundle built from `cd2efa9` is retained as signing evidence only.
It predates consolidation and the credential fixes: **build and test a new signed bundle from
current main before upload**. Inspect its versionCode against Play Console and increase it if
that code has already been uploaded. Do not change the existing desktop release tag.

The latest completed local app validation for `23b7b91` recorded 366 UI tests, 225 Rust tests,
6 Android JVM tests and 4 Android emulator tests, plus Windows/Android builds and release lint.
These are results for that commit, not permanent expected test counts. Evidence is retained
locally in `reports/review-fixes-20261019/`; [GitHub validation](https://github.com/AhmadHoranieh/local-budget/actions/runs/39308920011)
is the source for that run's remote status.

The 1.0.6 release review on 20 October passed 361 Rust tests, 529 UI tests across 70 files,
330 web/API tests across 13 files and 6 CI-selector tests. TypeScript checks, the production
frontend build and the Windows native debug build passed. Both ignored synthetic benchmarks
were run explicitly and passed; all twelve accounting/report fingerprints match the previous
engine review. Evidence is retained locally in `reports/release-1.0.6-20261020/`.
The previous Android CI run exhausted runner disk space during APK compilation. Validation now
omits Rust debug symbols and both Android workflows remove unused SDK-managed NDK versions;
[cross-platform validation](https://github.com/AhmadHoranieh/local-budget/actions/runs/39349691141)
passed on Windows, macOS, Android and iOS Simulator. The Android runner had 17 GiB free after
toolchain setup, and both APK builds, unit tests and release lint completed successfully.

The [installer build](https://github.com/AhmadHoranieh/local-budget/actions/runs/39352032488)
and [publication workflow](https://github.com/AhmadHoranieh/local-budget/actions/runs/39395243293)
passed. Public Windows/macOS installer URLs returned HTTP 200. Windows x64 and both macOS
architectures offer signed version 1.0.6 updates to 1.0.5 clients and return HTTP 204 to 1.0.6
clients. Publication evidence is retained in the same release-review directory.

The last observed Play account state was a newly created Personal account awaiting identity,
physical-device and phone verification. No app/catalog or live purchase configuration had been
created in that session. Check Console before acting; do not infer completion from elapsed time.
The owner's private Play checklist owns the remaining account, product,
review-access and real-purchase testing steps. The [mobile guide](MOBILE.md) owns the
build procedure and platform limitations.

Publishing a desktop release, uploading a mobile bundle, deploying the website, and pushing
source to main are separate actions. A source push alone does not update installed desktop apps.
