> Historical snapshot. Claims and commands below describe the original investigation, not the current app. See [current documentation](../MOBILE.md).

# Android spike notes

A feasibility spike from October 2026. The desktop app was built for Android with only the gates
below, then booted in the emulator. It isn't a phone UI. The sample budget from the Welcome screen
opens and works, so the Rust core, SQLite, the IPC and the React window all run on a phone. This
lists what broke or looks wrong there, so the real port (the `mobile` branch) knows where the work
is.

Tested on an emulator: Android Studio's Medium Phone AVD (API 37, Google Play x86_64 image, WHPX)
on Windows 11. The WebView reports a 411×914 CSS-pixel viewport at 2.625× and the user agent
`Mozilla/5.0 (Linux; Android 10; K; wv) … Chrome/145 Mobile Safari/537.36`. Chrome's reduced
user agent always says Android 10, so the user agent can tell Android but not its version.

## What changed to make it build

- `src-tauri/src/lib.rs`: `run()` is the mobile entry point (`#[cfg_attr(mobile, tauri::mobile_entry_point)]`).
- `tauri-plugin-updater` is a desktop-only dependency (`Cargo.toml`), registered only under
  `#[cfg(desktop)]`.
- `updates_enabled` (`src-tauri/src/updates.rs`) is false on a phone, and `src/updates.ts` then
  never calls the updater, not even for a manual check.
- Capabilities: `desktop.json` (the window frame permissions and `updater:default`, for
  linux/macOS/windows) and `mobile.json` (android/iOS: no window frame, no updater).
- `assistant_print` is a stub on phones that returns an error, because Tauri's
  `WebviewWindow::print()` exists only on desktop. That was the only compile error. Everything else
  compiled unchanged for `x86_64-linux-android`: bundled SQLite, rustls/ring, zip, calamine,
  rust_xlsxwriter, and the cfg fallbacks in `credentials.rs`, `assistant/vault.rs`,
  `cloud/mod.rs` and `reveal_path`.

`src/platform.ts` was left alone: `osFrom` and `mobile` are on the `mobile` branch. On this branch
the phone counts as `linux`.

## What breaks or looks wrong on the phone

### Layout

- It's the desktop layout at 411 px wide. The sidebar takes more than half the width. The budget
  table, the summary cards and the sample banner's button are cut off on the right, with no
  horizontal scrolling. The sample banner wraps one word per line.
- The page draws under the status bar and the gesture bar. API 37 apps are edge to edge, and the
  page has no safe-area insets, so the clock sits on the budget's avatar and the status icons
  cover the header buttons.
- Settings › General says "The Microsoft Store keeps UrBudget up to date." The updater is off
  correctly, but the wording assumes Windows (`UpdateSetting`).
- Shortcut hints (Ctrl+…) in tooltips and Settings › Shortcuts mean nothing on a phone.

### File inputs for imports

- `<input type="file">` works: it opens Android's system picker, and a picked JSON file reached
  the page with its name, size and type intact.
- The picker filters by MIME type, and Android has none for `.ofx`, `.qfx` or `.qif`. With the bank
  import's `accept=".csv,.ofx,.qfx,.qif,.txt"`, an `.ofx` file in Downloads didn't appear, and only
  the CSV did. OFX/QFX/QIF statements probably can't be picked until the input accepts `*/*` (or
  the matching `application/x-ofx` types) and checks the file after it's picked.

### Exports and backups land in an invisible folder

- Tauri's `app_data_dir` on Android is the app's private storage:
  `/data/user/0/com.localbudget.desktop/budgets/<id>/`. Budget databases, `backups/`,
  `exports/` (JSON budget exports, report and transaction CSVs, YNAB CSVs, assistant spreadsheets) and the recovery file
  all land there. A backup made from the phone was written there, and nothing outside the app can
  reach it without root.
- "Show in folder" (`reveal_path`) fails with "No such file or directory (os error 2)". It spawns
  `xdg-open`, which Android doesn't have. Opening an assistant file (`assistant_open`) takes the
  same path.
- Phones need a share sheet, or a "save to…" through the Storage Access Framework, in place of
  writing into the data folder and revealing it.

### Save on close never fires

- Back at the root ended the app process within 2 seconds. `tauri://close-requested` never fired.
  A listener recorded nothing, and with "Back up on close" turned on, no backup was written.
  Swiping the app away from Recents, or Android ending it in the background, gives no event either.
- So `prepareExit` in `useBudget.ts` never runs on a phone: no final flush, no backup on close,
  and no chance to keep the app open over unsaved changes or a pending conflict.
- Edits still save 400 ms after each change. After a relaunch, the sample budget and its edits
  were intact. The risk is that last 400 ms, plus the on-close backup that never happens. Saving
  when the page is hidden (`visibilitychange`/`pagehide`) is the fix, and it's on the `mobile`
  branch.

### Credential fallback

From the code (`STORE` is `None` off macOS/Windows), not exercised on the phone:

- The YNAB token can't be remembered. It's pasted for each import.
- The assistant's API keys and its ChatGPT refresh token last only until the app closes, and
  Android closes apps whenever it likes.
- The UrBudget account session is kept in memory only (`memory_token`), so the phone signs out of
  sync every time the app restarts.
- Phones need the Android Keystore and the iOS Keychain. The iOS part is on the `mobile` branch.

### Other desktop-only paths

- Assistant ChatGPT sign-in waits for a callback on 127.0.0.1 and opens the browser with
  `xdg-open`, which doesn't exist on Android, so it can't start. This is from the code, not
  exercised. Phones need the system browser through a plugin (opener/deep link) and a custom-scheme
  or app-link redirect.
- The assistant's MCP settings show the command `/system/bin/app_process64 --mcp`, because
  `current_exe()` on Android is the zygote binary. The section should be hidden on phones.
- `device_name()` finds no `COMPUTERNAME` or `HOSTNAME` on Android, so the account and sync call
  the phone "This computer".
- Printing a report returns "Printing isn't available on this device yet."

## Build and dev-loop problems on Windows

- Symbolic links need Windows Developer Mode. `tauri android dev` symlinks the built `.so` into
  `gen/android/app/src/main/jniLibs` and stops without it.
- On Windows, `tauri android dev` points the app at the PC's network address by default. Vite here
  listens only on 127.0.0.1 and ignores `TAURI_DEV_HOST` (the `mobile` branch fixes that). With
  `--host 127.0.0.1`, the CLI forwards the port with `adb reverse` instead, which works for the
  emulator.
- Another checkout's Vite already held port 1420. The spike ran on 1421 with
  `-c <file>` overriding `build.devUrl` and `build.beforeDevCommand`.
- The `[DEVICE]` argument takes the device's name (`Medium_Phone_API_37.0`), not its adb serial
  (`emulator-5554`). Given a name it doesn't know, the CLI said so and then built for
  `aarch64-linux-android` with no device. With one emulator running, leave the argument out.
- `tauri android dev` stalls after Gradle has built the APK. It prints nothing more, runs no adb,
  and has no child process except Vite. It happened on both runs:
  - First run: the APK was built at 13:01. The CLI installed and launched the app on its own at
    13:25, for no reason I could find.
  - Second run: the APK was built at 13:30, and there was still no install at 14:16, 45 minutes
    later.

  Ruled out:
  - APK size: installing the 308 MB APK by hand took 1.5 s, and a run with
    `CARGO_PROFILE_DEV_DEBUG=line-tables-only` (a 117 MB library) stalled the same way.
  - The Gradle daemon holding the CLI's output pipe: `gradlew --stop` changed nothing.
  - An adb server started inside the build: the server predates the run.
  - A socket left open to the CLI: it holds only its listening socket.
  - Running `adb devices`, or launching the app, didn't wake it.
  - The CLI's own Android lock. `tauri android` commands lock
    `src-tauri/target/<triple>/debug/lock.android`, and a stalled `android dev` keeps holding it.
    Another checkout's Android builds, which were writing into this worktree's `target` folder,
    sat at "Blocking waiting for file lock on Android" until the stalled run was stopped. So the
    stall can block other builds. It isn't explained by the lock, though: the CLI prints that
    "Blocking" line whenever it has to wait for the lock, and neither of the stalled runs' logs
    has it.

  The workaround is to install by hand while the CLI keeps serving the page:
  `adb install -r app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk`, then
  `adb shell am start -n com.localbudget.desktop/.MainActivity`. The app then loads from the CLI's
  dev server through its `adb reverse`. Worth trying next: a newer Tauri CLI, or running from
  Android Studio (`android dev --open`).
- Vite reloads the page whenever Gradle writes its reports under `src-tauri/gen/android`. Vite's
  `server.watch.ignored` should skip `src-tauri/`.
- Gradle installed Android SDK Platform 36 on its own on the first build. Its license was already
  accepted.
- The debug APK is 308 MB: an unstripped debug `.so` for one ABI. With
  `CARGO_PROFILE_DEV_DEBUG=line-tables-only` the library drops to 117 MB and the APK's contents to
  about 120 MB. The file on disk stays around 320 MB, because AGP's incremental debug packaging
  rewrites it in place. Release builds will be far smaller.
- The generated project (gitignored here, throwaway): AGP 9.3.1, Gradle 9.6.1, compileSdk and
  targetSdk 37, minSdk 24, app id `com.localbudget.desktop`. AGP prints deprecation warnings
  (legacy variant API, `android.newDsl=false`, Java 8 source/target) that become errors in AGP 10.
  The `mobile` branch's `tauri.android.conf.json` moves the id to `app.urbudget` and minSdk to 26.

## Reproducing

With `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` set (see `MOBILE.md` on the `mobile` branch),
Developer Mode on, and the emulator running:

```
npm run tauri -- android init --ci
npm run tauri -- android dev --host 127.0.0.1
```

To inspect the page, forward the WebView's DevTools socket and open `chrome://inspect`, or drive
it over CDP:

```
adb shell cat /proc/net/unix | grep devtools          # @webview_devtools_remote_<pid>
adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
```
