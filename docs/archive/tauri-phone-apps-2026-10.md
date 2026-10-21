> Historical snapshot, 21 October 2026. This was the guide to the Tauri phone builds of
> `desktop/`: the React window with a phone layout, packaged for Android and iOS. The native apps in
> `android/` and `ios/` replaced them, and they were removed from `desktop/` the same day, along
> with the phone layout and the files below (`gen/android`, `share.rs`, `play_billing.rs`, the
> Tauri phone configs). Its device observations are
> kept as evidence; they don't describe the current apps. See the
> [current mobile guide](../MOBILE.md). Store setup moved there too.

# UrBudget on iOS and Android (Tauri builds)

## Existing Tauri mobile clients

The phone apps are this same Tauri project. The Rust core (engine, SQLite store, imports, sync)
and the React window are shared. `src-tauri/tauri.ios.conf.json` and `tauri.android.conf.json`
override the mobile app version and platform settings. The customized Android project in
`src-tauri/gen/android` is committed. iOS currently generates `gen/apple` with `tauri ios init`;
commit any native iOS customization before relying on it in release builds.

The phone apps use the app id `app.urbudget`, not the desktop's `com.localbudget.desktop`. A store
never lets an app change its id after the first upload, so settle on it before then. Budgets on a
phone live in its own private app folder; sync is how they reach a computer.

Secrets (the assistant's API keys and ChatGPT sign-in, a remembered YNAB token, the account's
session, the sync key) are in the same sealed `secrets.bin` as on a computer (README › Secrets),
and its key goes where each system keeps keys. iOS has the Keychain, as macOS does. On Android,
[`SecretStore.kt`](../../shared/android/src/main/java/app/urbudget/SecretStore.kt), compiled by both Android projects, seals the key with AES-GCM under a key that never leaves the
Android Keystore, and saves it in the app's `no_backup` folder, which backups and device
transfers skip (the Keystore key couldn't follow it anyway). A `secrets.bin` restored from a
backup without it cannot be opened. The app preserves the ciphertext and blocks credential writes; signing in again cannot silently replace the vault. When key access returns, reads retry without a restart. If the key is permanently lost, first export/share the readable budgets and retain the old vault for diagnosis. There is no in-app vault-reset action yet; arrange an explicit credential reset with support rather than clearing app storage and losing budgets. Rust calls it over JNI
([shared `keystore.rs`](../../crates/urbudget-services/src/keystore.rs)) from the shared vault, so it works from any thread and before the window
exists. Secrets an earlier version sealed one by one move into the file when first read. Only
Rust refers to the class, so `proguard-rules.pro` keeps it in release builds. The window calls it
"Android Keystore" where a computer says Keychain or Windows encrypted storage.

In the window, `mobile` in `src/platform.ts` is true on a phone or tablet, and `<html>` carries
the class `mobile`. Phones save when the app leaves the screen (`useBudget.ts`), because they end
apps without asking. The page keeps clear of the notch and the home indicator
(`viewport-fit=cover` in `index.html`, `html.mobile` in `styles.css`). The page draws under
the system bars in its own theme, which can differ from the system's. On Android it tells
`MainActivity.kt` (in `gen/android`) which theme it shows (`src/theme.ts`), so the bars' icons
stay readable.

The layout goes by the window's width, not the system. At 640px and under (`PHONE` and
`usePhone()` in `src/ui/phone.ts`, and `@media (max-width: 640px)` in each page's stylesheet
under "Phones"), it is one column, laid out the way YNAB's phone app is. The structure follows
YNAB; the colours, type and words stay UrBudget's (Unassigned, not Ready to Assign).

- A tab bar floats over the bottom of the page as frosted glass (`--glass` in `styles.css`), and
  the lists scroll on under it; each keeps `--dock-room` at its end so its last row clears it.
  Its tabs are Budget, Transactions, Accounts, Reports and More. More opens the sidebar as a
  floating glass panel, with the budgets, the Loan planner, Payees & rules and
  Settings; the tabs cover the rest. "+ Transaction" floats above the tab bar on Budget,
  Transactions and Accounts, and shrinks to its plus while a list scrolls down.
- Sheets (dialogs, panels, a category's details), menus, the drawer and the assistant are frosted
  glass over a dimmed, slightly blurred page. A phone's dark theme is navy, as YNAB's is: the
  computer's charcoal reads green on phone screens. On the dark theme nothing floating casts a
  shadow, only an edge: a black shadow on a dark page looks like a smudge.
- A top bar of round buttons: the page's title, large, on the left (the month, centred, on the
  budget); the assistant and a ⋯ menu (undo, redo, Settings) on the right. A page puts its own
  buttons in the bar through `PhoneBarSlot` (`src/ui/phoneBar.tsx`): the budget's views, the
  register's search, Accounts' add, a report's way back. The saving status shows only while
  something isn't saved, and the trial and sync chips only when they need attention.
- Budget (`PhoneBudget.tsx`): Unassigned as a solid banner, a card when categories are
  overspent, then the groups as bands across the screen with their Assigned and Available
  totals, and each category a row with both, Available as a solid pill (green, amber, red or
  grey). The views, Collapse all and New group are in the filter button's menu. Tapping a
  category opens its details as a sheet from the bottom, where Assigned is edited and the
  category's menu is; tapping its pill moves money.
- Transactions: the days as bands with the date written out, each transaction its payee and
  amount over its categories as chips (a split's with their amounts), the account and the
  memo. Search and filters fold away behind the search button. An account's transactions (from
  Accounts) lead with its balances and go back to Accounts. A long press on a transaction
  selects it, with the system's own tap (`UrBudgetHaptics` in `MainActivity.kt`): a check
  slides in beside each row, taps add and remove rows, the top bar shows how many with Select
  all, and the selection's actions (Approve, Category, Cleared, Flag, Delete, and More for the
  rest) take the tab bar's place on the same glass. An action ends the selection.
- Accounts (`PhoneAccounts.tsx`): cash, credit, tracking and closed accounts, each kind a card
  with its total. A tap opens the account's transactions; a long press, its actions.
- Reports (`PhoneReports.tsx`): opens on cards for this month's spending by category, income
  against spending, net worth and cash age, over six months, and a list of every report. Each
  opens the report itself.
- Adding or editing a transaction takes the whole screen: the amount large on a keypad
  (`AmountPad.tsx`), which takes digits as cents from the right as YNAB's does (1, 2, 3, 4 makes
  12.34) and does sums, then the payee, category, account and date as rows of a card, and the
  rest in a second card. The keypad gives way to Save once it's Done.
- Other dialogs, and panels such as filters, dates and moving money (`Popover`), rise from the
  bottom as sheets over a dimmed page; dropdown lists and menus stay by what opened them.
- Payees, Settings and the Loan planner use the same cards and chips. Payees shows
  the list, then a payee's details with a way back. Scheduled transactions (dated ahead or
  repeating) are listed atop Transactions (tap one to edit it; ⋯ pauses or deletes it). Report bars sit under
  their names. The assistant rises as a sheet nearly the screen's height.
- Android's back button closes what's open, newest first: a menu or picker, a sheet or dialog,
  the selection, a category's or payee's details, an open report, the folded-out search, the
  assistant, the drawer. Then an account's transactions go back to Accounts and any other page
  to the first one. With nothing left, it puts the app away as usual. Each of these takes the
  button only while it's open (`useBackButton` in `src/ui/touch.ts`).
- The app says "device" where a computer says "computer" (`device` in `src/platform.ts`).

A tablet keeps the desktop layout. To look at the phone layout on Windows, run the QA build
(`npm run qa`) with an Android user agent added to `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
(`--user-agent="… Android …"`; `src/platform.ts` reads it once, at load), and lay the window out
at a phone's size over the debugging port (`Emulation.setDeviceMetricsOverride`, 411×914, with
`mobile: true`). With another checkout's app open, give this one its own
`WEBVIEW2_USER_DATA_FOLDER`, Vite port and debugging port: WebView2 won't share a profile
between apps started with different arguments.

## The assistant's ChatGPT sign-in

A phone signs in the way a computer does ([shared `assistant/auth.rs`](../../crates/urbudget-services/src/assistant/auth.rs)): OAuth with PKCE,
and a one-time listener on `127.0.0.1` that takes the browser's callback. OpenAI accepts no other
redirect. In October 2026, signed in, `urbudget://auth/callback` and
`https://urbudget.app/auth/callback` were both refused ("Invalid authorize request",
`param: redirect_uri`), for a new registration and for UrBudget's issued client alike. So a deep
link (`tauri-plugin-deep-link`), an Android App Link or an iOS Universal Link can't carry the
callback. Test redirects while signed in: signed out, the authorize page shows the login form
whatever the redirect is.

What differs on a phone is how the page opens. A phone can't start a browser program, so
`open_sign_in` hands the page to the opener plugin (`tauri-plugin-opener`, phones only) and asks
for its in-app browser: a Custom Tab on Android, Safari's in-app view (`SFSafariViewController`)
on iOS. Both open over the app, and closing them goes straight back to it. The assistant's other
links (usage and API keys) go to the phone's own app for them (`open_browser`). Reporting a reply
opens an in-app form where the user reviews and edits the excerpt before sending it to support.
The plugin is only called from Rust, so the window's capabilities don't grant it.

### Android

It works. Tested on the emulator (API 37, Chrome 145) with `tauri android build --debug`:

1. Continue with ChatGPT opens a Custom Tab in UrBudget's own task. On a phone where Chrome has
   never been opened, Chrome's first-run screens come before the tab.
2. Once the app leaves the screen, Android blocks its network within seconds. About a minute
   later it freezes the app, even while it's still the "previous app". Neither stops the
   callback. Loopback is exempt from the background firewall, and the kernel queues the browser's
   connection for the listener while the app is frozen. But nothing can answer yet, so after
   Continue the tab stays on OpenAI's consent page with its button spinning.
3. Closing the tab brings the app back. Android thaws it, the listener takes the waiting callback,
   and the sign-in finishes. `wait_for_callback` takes a waiting callback even past its five-minute
   limit. While it waits, the app says to close the tab. Someone who finishes within the minute
   sees "You're signed in" in the tab instead.
4. The refresh token is kept with the other secrets, sealed under the Android Keystore key
   (above), so the sign-in should outlast Android ending the app, and Settings says it's kept in
   Android Keystore. API keys, the account session and the sync key were tested that way. The
   ChatGPT sign-in itself hasn't been yet. The client id OpenAI issued is kept in
   `assistant.json`, so signing in again doesn't register UrBudget again. OpenAI does ask for
   consent each time.

A foreground service while the tab is open would keep the app from freezing, so the tab could
say "You're signed in" straight away. It would need a notification, the `shortService` type (three
minutes at most) and Kotlin in `gen/android`. It isn't done, because closing the tab works.

### iOS (needs a Mac)

iOS Simulator builds pass in CI. ChatGPT sign-in and runtime behavior on an iPhone remain
unvalidated, so `chatgptSignIn` in `src/platform.ts` keeps iOS assistant access limited to API keys.
The code is already in place: `open_sign_in` presents `SFSafariViewController` over the app. While
that view is open, iOS keeps the app active, so the listener on `127.0.0.1` answers the callback.
Opening Safari itself wouldn't work, because iOS suspends an app a few seconds after it leaves the
screen. On a Mac:

1. Let `chatgptSignIn` include iOS, then `npm run tauri -- ios dev` and sign in, on the
   Simulator and on an iPhone.
2. Check that the callback page loads in the view (an `http://127.0.0.1` page after an https one),
   that Done goes back to the app, and that the assistant answers.
3. The refresh token is kept in `secrets.bin`, its key in the Keychain (`vault.rs`), so the
   sign-in should outlast a relaunch. Check that too.

`SFSafariViewController` has two drawbacks. It doesn't share Safari's sign-ins, so people type their
OpenAI password each time. And the app can't close it once the callback arrives. If either matters,
the next step is `ASWebAuthenticationSession`, as a small Swift plugin with two commands. `start`
presents the session over the app, with `prefersEphemeralWebBrowserSession` off so it shares
Safari's sign-ins, and with no callback scheme. `finish` cancels it. The loopback redirect is not a
URL scheme the session can watch for, so the session never ends by itself: Rust calls `finish`
once the listener has the code, and the plugin ignores the "cancelled" error that follows. iOS
first asks "UrBudget wants to use openai.com to sign in". The app stays in front throughout, as
with the Safari view, so the listener keeps working. Writing, signing and testing that plugin all
need Xcode on a Mac.

## Files out

Exports, backups, reports and the assistant's spreadsheets are saved in the budget's folder,
inside the app's private folder, which a phone doesn't show. Where a computer's toast offers
"Show in folder", a phone's offers Share (`revealLabel` in `src/platform.ts`). `reveal_path`
checks the file is in the app's data folder, as it does on a computer, and then hands it to
`share.rs` instead of a file manager. A computer pauses a toast while the pointer is over it; a
phone has no pointer, so there a toast with a button stays 9 seconds, as an error does
(`ui/Toast.tsx`).

On Android, `share.rs` calls `SharePlugin.kt` in `gen/android`, a Tauri plugin registered from
Rust (so the window's capabilities don't grant it). Other apps can't read the private folder, so
it copies the file to `cache/shared/<time>/` and sends that copy with `ACTION_SEND` through the
FileProvider the manifest already declares (`res/xml/file_paths.xml` names `shared/`). Copies
from earlier shares go once they're an hour old. Export for YNAB saves a folder of three files,
which go together (`ACTION_SEND_MULTIPLE`).

The assistant's Open (a spreadsheet card, or a report saved as one) goes the same way with
`open`: `ACTION_VIEW` to an app that views .xlsx, such as Sheets or Excel, and the share sheet
when the phone has none (`open_file` in `assistant/mod.rs`).

The budget's own file isn't offered. It's open in WAL mode, so a copy could miss recent changes;
Back up now makes a whole one to share. So Settings › Advanced and Manage budgets leave out
their Show in folder on a phone.

On the phone the exports are where a computer has them: Export among the chips under the
Transactions search, Export CSV on a report, and Export transactions in an account's long-press
menu on Accounts (the sidebar's account menu on a computer).

Tested on the emulator (API 37): exporting transactions (all of them, and one account's), Back
up now, the full backup file, Export for YNAB (three files) and a report's CSV each open the share
sheet with the file named, offering Quick Share, Drive, Gmail and Gemini. Drive opened its upload
screen with the file; the emulator had no Google account, so the upload itself wasn't tried. With
no spreadsheet app installed, the assistant's Open went to the share sheet; opening straight into
Sheets or Excel hasn't been tried.

## Set up a computer

### Android (Windows, macOS or Linux)

1. Install [Android Studio](https://developer.android.com/studio). In its SDK Manager install:
   Android SDK Platform, Platform-Tools, Build-Tools, Command-line Tools, and NDK (Side by side).
2. Set the variables Tauri looks for. On Windows (adjust the NDK version to the folder you have):
   ```
   JAVA_HOME = C:\Program Files\Android\Android Studio\jbr
   ANDROID_HOME = %LOCALAPPDATA%\Android\Sdk
   NDK_HOME = %LOCALAPPDATA%\Android\Sdk\ndk\<version>
   ```
3. `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
4. The customized Android project is committed; do not regenerate it. `npm run tauri -- android dev` runs the app on an
   emulator (make one in Android Studio's Device Manager) or a phone with USB debugging on.
   On Windows, if init or dev stops because it can't create a symbolic link, turn on Developer
   Mode (Settings › System › For developers).

### iOS (macOS only)

1. Install Xcode from the App Store, open it once, and add an iOS Simulator runtime.
2. `brew install cocoapods`
3. `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`
4. Once: `npm run tauri -- ios init`. Then `npm run tauri -- ios dev` runs it in the Simulator;
   `npm run tauri -- ios dev --open` opens Xcode to run it on an iPhone. A device needs the Apple
   team: set `APPLE_DEVELOPMENT_TEAM` to the Team ID.

A phone running `dev` loads the window from this computer over Wi-Fi. The Tauri CLI asks which
address to use and passes it as `TAURI_DEV_HOST` (`vite.config.ts`). The phone and the computer
need to be on the same network.

### Debugging the window

`npm run qa` and `scripts/qa/cdp.mjs` need WebView2, so they only work on Windows. Android's
WebView shows up in Chrome at `chrome://inspect` in debug builds. iOS needs Safari on a Mac
(Develop › the Simulator or the iPhone).

## Builds on GitHub

Develop all platforms on `main`. `.github/workflows/app.yml` (**App validation**) runs on relevant pushes to `main`, pull requests targeting it, and manual dispatch. It runs the shared frontend build and tests once, then selects native checks by the changed files: Windows/macOS Rust tests and unsigned debug builds, Android debug APKs for ARM64 and x86_64 plus unit tests and release lint, and an iOS Simulator build. Manual dispatch checks every platform and attaches the APKs and Simulator build; Android validation reports are attached whenever available. Neither mobile CI build needs store-signing secrets. Android uses the committed native project; iOS currently generates its Xcode project during CI.

CI uses Node 22 and Rust stable, Java 17, Android command-line tools 23.0 (build 15859902), SDK package `platforms;android-37.0`, Build-Tools 36.0.0 and NDK 30.0.16248370. API 37.0 requires command-line tools 22 or newer; its package name includes `.0`, while Gradle keeps `compileSdk`/`targetSdk` at 37. The Android upload workflow uses the same pinned SDK/NDK. Keep Gradle, Android Gradle Plugin, Kotlin and Tauri versions compatible when changing the toolchain, and rerun all four platform jobs. The iOS job uses GitHub's macOS/Xcode environment and the ARM64 Simulator target.

After a local Tauri Android build, run Kotlin tests and release lint from `src-tauri/gen/android`:

```sh
./gradlew :app:testUniversalDebugUnitTest :app:lintUniversalRelease -x :app:rustBuildUniversalDebug -x :app:rustBuildUniversalRelease
```

Use `gradlew.bat` on Windows. The exclusions reuse the native libraries already built by Tauri; invoking its Rust task directly after the CLI exits cannot use the CLI's IPC server. Do not add `--offline` on a fresh machine.

With a test emulator or device connected, also run `./gradlew :app:connectedUniversalDebugAndroidTest -x :app:rustBuildUniversalDebug` to exercise real Android Keystore encryption and read failures. These tests create and remove disposable credential entries; use a test installation for device QA. On a fresh test installation, a startup regression also checks that Rust's file lock and JNI bridge persist the encrypted vault; it skips when a vault already exists rather than removing credentials. The host JVM tests cover injected missing-key and storage-failure cases without a device.

### Independent mobile versions

Android and iOS stay at **1.0.3** in `tauri.android.conf.json` and `tauri.ios.conf.json`, independently of desktop **1.0.5** in the base config/package. `npm run check:versions` catches missing overrides and desktop metadata drift, and runs before each frontend/native build. Update the mobile platform config for a mobile release and verify the resulting manifest version/build number; leave desktop versions alone. Keep application ID/bundle ID `app.urbudget` and the desktop identifier `com.localbudget.desktop` unchanged so consolidation preserves installed data and update identities.

Before releasing, test both interfaces with synthetic fixtures and older exported budgets: save/reopen, import/restore, transfers, schedules, sync conflicts and unknown-field preservation. Also check phone keyboard/Back/accessibility behavior and desktop keyboard/dialog behavior. CI compilation is not physical-device QA or store-purchase validation. [README.md](../../desktop/README.md#one-development-branch) describes the shared development flow.

## Not ready yet

- **What a phone leaves out.** Reordering categories (by dragging) and resizing columns need a
  mouse, so a phone keeps the category order set elsewhere. Accounts move up and down from their
  long press. A selection is picked row by row (or all at once): there's no dragging across rows
  to select a run of them. YNAB's phone app has a Home tab and an Edit mode for the plan; UrBudget has neither
  yet. Settings › Assistant leaves out using the budget in other AI apps: the MCP server is the
  app started with `--mcp`, which only an AI app on a computer can start.
- **Sync conflicts.** Done in Rust, not yet tried between a real phone and a computer. Sync now
  merges record by record against the version both devices last synced (`sync_merge.rs`; the
  base is kept in each budget's database), so a phone adding transactions while a computer has
  edits syncs without a question, and money assigned on both devices adds up. It asks only when
  both changed the same field differently, or one deleted a record the other edited, and
  Settings › Account & sync lists those records with each side's value. The server didn't
  change. Each download or merge still backs up the whole budget first; native retention now
  prunes after backup creation, including closed budgets and Android background sync.
- **Secrets on Android.** They're kept now (above), until the app is uninstalled or its storage
  is cleared: Android then deletes the Keystore key and the app's folders together. The trial's
  first day goes with them. A computer also keeps that day in its credential store, which
  outlives the app's data, and iOS keeps Keychain items after an uninstall (Apple doesn't promise
  it), so reinstalling doesn't restart the trial there. On Android nothing an app saves outlives
  its uninstall. A reinstall keeps the trial only if Android restores the app's backup, which it
  does from the user's Google account when their backup is on and the app comes from Play. The
  backup holds the app's folder, `license.json` with it, but not the secrets, so the user signs
  in again. Holding the trial past that takes a server: Play's own free trial (Play Billing, see
  Payments) or a trial tied to the account.
- **Files out on iOS.** Android shares exports, backups and reports (Files out, above). iOS has
  no share plugin yet, so Share there says it isn't available. It needs a small Swift plugin that
  presents `UIActivityViewController` with the file's URL, registered from `share.rs` the way
  the Kotlin one is. Neither phone offers a save dialog (`ACTION_CREATE_DOCUMENT`, a document
  picker); the share sheet's Drive or Files does that job.
- **The assistant.** Its ChatGPT sign-in works on Android but hasn't been tried on iOS (above).
  Its links open through the system. On Android a spreadsheet it made opens in a spreadsheet app
  or goes to the share sheet (Files out, above); on iOS opening one fails until iOS can share.
- **The keyboard and sheets.** Untested on a real phone: whether the on-screen keyboard pushes a
  sheet's fields up or covers them, given the app draws edge to edge.
- **Backups.** The on-close preference is hidden on phones. Manual Android backups are complete
  JSON files that Restore can read; internal protection copies remain SQLite. Restore validates
  and replaces the whole budget and first makes a protection copy. Native keep-5/10/30 retention
  applies at creation and persists across launches. Share a JSON backup off the device to protect
  against uninstall or device loss; app-private copies disappear with app storage.
- **iOS status bar.** With a theme chosen in Settings that differs from the system's, the status
  bar's text keeps the system's color. Android has a bridge for this (above); iOS needs the same
  in Swift.
- **Wording.** Some help text still refers to keyboard shortcuts, and Settings › Shortcuts has
  nothing to offer a phone.
