import { expect, it } from "vitest";
import { keyLabel, osFrom, tokenStoreFor } from "./platform";

it("tells the system from each webview's user agent", () => {
  expect(
    osFrom(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    ),
  ).toBe("windows");
  expect(osFrom("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(
    "macos",
  );
  expect(osFrom("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("linux");
  expect(osFrom("Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/29.1.1")).toBe("other");
});

it("keeps tokens only where the system has a supported credential store", () => {
  expect(tokenStoreFor("macos")).toBe("Keychain");
  expect(tokenStoreFor("windows")).toBe("Windows encrypted storage");
  expect(tokenStoreFor("linux")).toBeNull();
});

it("writes shortcuts with macOS symbols on a Mac and leaves them alone elsewhere", () => {
  expect(keyLabel("Ctrl+Z / Ctrl+Shift+Z", "macos")).toBe("⌘Z / ⇧⌘Z");
  expect(keyLabel("Undo (Ctrl+Z)", "macos")).toBe("Undo (⌘Z)");
  expect(keyLabel("Click, Ctrl+click, Shift+click", "macos")).toBe("Click, ⌘-click, ⇧-click");
  expect(keyLabel("Alt+↑ / Alt+↓", "macos")).toBe("⌥↑ / ⌥↓");
  expect(keyLabel("Shift+Enter", "macos")).toBe("⇧Enter");
  expect(keyLabel("/ or Ctrl+F", "macos")).toBe("/ or ⌘F");
  expect(keyLabel("Enter, F2 or double-click", "macos")).toBe("Enter, F2 or double-click");
  expect(keyLabel("Ctrl+Shift+Z", "windows")).toBe("Ctrl+Shift+Z");
});
