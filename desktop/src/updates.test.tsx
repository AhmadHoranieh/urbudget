import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  version: vi.fn(),
  steps: [] as string[],
}));
vi.mock("./bridge", () => ({ desktop: true }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocked.check }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocked.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocked.version }));
import { IDLE_BEFORE_UPDATE, useAutomaticUpdate, useUpdatedNotice, useUpdates } from "./updates";
import { UpdateChip, UpdateSetting } from "./UpdateNotice";
const saveAndInstall = async (install: () => Promise<void>) => {
  mocked.steps.push("save");
  await install();
};

type Progress = (event: {
  event: string;
  data?: { contentLength?: number; chunkLength?: number };
}) => void;
const update = () => ({
  version: "0.4.1",
  body: "Faster reports",
  download: vi.fn(async (onEvent: Progress) => {
    mocked.steps.push("download");
    onEvent({ event: "Started", data: { contentLength: 200 } });
    onEvent({ event: "Progress", data: { chunkLength: 100 } });
    onEvent({ event: "Progress", data: { chunkLength: 100 } });
    onEvent({ event: "Finished" });
  }),
  install: vi.fn(async () => {
    mocked.steps.push("install");
  }),
  close: vi.fn(async () => {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocked.steps = [];
  mocked.invoke.mockImplementation(async (command: string) => {
    if (command === "update_channel") return "direct";
    mocked.steps.push(command);
  });
});
afterEach(cleanup);

async function found(next: ReturnType<typeof update> | null) {
  mocked.check.mockResolvedValue(next);
  const hook = renderHook(() => useUpdates());
  await act(async () => {
    await hook.result.current.check(true);
  });
  return hook;
}

describe("updates", () => {
  it("says when this is the newest version", async () => {
    const { result } = await found(null);
    expect(result.current.available).toBeNull();
    expect(result.current.current).toBe(true);
  });

  it("offers a newer version and installs it only after the budget is saved", async () => {
    const next = update();
    const { result } = await found(next);
    expect(result.current.available).toEqual({
      version: "0.4.1",
      notes: "Faster reports",
    });
    await act(async () => {
      await result.current.install(saveAndInstall);
    });
    expect(mocked.steps).toEqual([
      "download",
      "save",
      "install",
      "restart_app",
    ]);
  });

  it("installs nothing while changes can't be saved, and keeps the download for the next try", async () => {
    const next = update();
    const { result } = await found(next);
    await act(async () => {
      await expect(
        result.current.install(async () => {
          throw new Error("Save or resolve your changes first.");
        }),
      ).rejects.toThrow(/Save or resolve/);
    });
    expect(next.install).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/Save or resolve/);
    expect(result.current.phase).toBe("idle");

    await act(async () => {
      await result.current.install(saveAndInstall);
    });
    expect(next.download).toHaveBeenCalledTimes(1);
    expect(next.install).toHaveBeenCalledTimes(1);
  });

  it("checks the correct provider after launch and daily for Store copies", async () => {
    vi.useFakeTimers();
    try {
      mocked.check.mockResolvedValue(null);
      const installed = renderHook(() => useUpdates());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      expect(mocked.check).toHaveBeenCalledTimes(1);
      expect(installed.result.current.current).toBe(true);
      installed.unmount();

      mocked.check.mockClear();
      mocked.invoke.mockImplementation(async (command: string) =>
        command === "update_channel" ? "microsoftStore" : true,
      );
      const fromStore = renderHook(() => useUpdates());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      expect(fromStore.result.current.available?.version).toBeNull();
      expect(
        mocked.invoke.mock.calls.filter(
          ([command]) => command === "check_store_update",
        ),
      ).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25 * 3600_000);
      });
      expect(
        mocked.invoke.mock.calls.filter(
          ([command]) => command === "check_store_update",
        ),
      ).toHaveLength(2);
      await act(async () => {
        await fromStore.result.current.check(true);
      });
      expect(mocked.check).not.toHaveBeenCalled();
      expect(fromStore.result.current.channel).toBe("microsoftStore");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never falls back to the standalone installer if channel identification fails", async () => {
    mocked.invoke.mockRejectedValue(new Error("Channel lookup failed"));
    const { result } = renderHook(() => useUpdates());
    await act(async () => {
      await result.current.check(true);
    });
    expect(result.current.error).toContain("Channel lookup failed");
    expect(mocked.check).not.toHaveBeenCalled();
    expect(result.current.current).toBe(false);
    mocked.invoke.mockImplementation(async (command: string) =>
      command === "update_channel" ? "microsoftStore" : false,
    );
    await act(async () => {
      await result.current.check(true);
    });
    expect(result.current.current).toBe(true);
    expect(mocked.check).not.toHaveBeenCalled();
  });

  it("waits for channel identification even when Check now is pressed immediately", async () => {
    let resolve!: (value: string) => void;
    mocked.invoke.mockImplementation((command: string) =>
      command === "update_channel"
        ? new Promise<string>((done) => {
            resolve = done;
          })
        : Promise.resolve(false),
    );
    const { result } = renderHook(() => useUpdates());
    let checking!: Promise<void>;
    act(() => {
      checking = result.current.check(true);
    });
    expect(mocked.check).not.toHaveBeenCalled();
    await act(async () => {
      resolve("microsoftStore");
      await checking;
    });
    expect(mocked.invoke).toHaveBeenCalledWith("check_store_update");
    expect(mocked.check).not.toHaveBeenCalled();
  });

  it("retries channel identification automatically after a transient startup failure", async () => {
    vi.useFakeTimers();
    try {
      mocked.invoke.mockRejectedValue(new Error("Windows is busy"));
      const { result } = renderHook(() => useUpdates());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      expect(mocked.check).not.toHaveBeenCalled();
      mocked.invoke.mockImplementation(async (command: string) =>
        command === "update_channel" ? "microsoftStore" : true,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25 * 3600_000);
      });
      expect(result.current.available?.version).toBeNull();
      expect(mocked.invoke).toHaveBeenCalledWith("check_store_update");
      expect(mocked.check).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves and keeps the edit lock through Store installation, then restarts", async () => {
    let finish!: (value: boolean) => void;
    mocked.invoke.mockImplementation(async (command: string) => {
      if (command === "update_channel") return "microsoftStore";
      if (command === "check_store_update") return true;
      if (command === "download_store_update") return "consent";
      mocked.steps.push(command);
      if (command === "install_store_update")
        return new Promise<boolean>((done) => {
          finish = done;
        });
    });
    const { result } = renderHook(() => useUpdates());
    await act(async () => {
      await result.current.check(true);
    });
    let installing!: Promise<void>;
    act(() => {
      installing = result.current.install(async (install) => {
        mocked.steps.push("locked-and-saved");
        try {
          await install();
        } finally {
          mocked.steps.push("unlocked");
        }
      });
    });
    expect(result.current.phase).toBe("installing");
    expect(mocked.steps).toEqual(["locked-and-saved", "install_store_update"]);
    await act(async () => {
      await result.current.check(true);
      await result.current.install(saveAndInstall);
    });
    expect(mocked.steps).toEqual(["locked-and-saved", "install_store_update"]);
    await act(async () => {
      finish(true);
      await installing;
    });
    expect(mocked.steps).toEqual([
      "locked-and-saved",
      "install_store_update",
      "restart_app",
      "unlocked",
    ]);
    expect(mocked.check).not.toHaveBeenCalled();
  });

  it("does not request a Store install when saving fails", async () => {
    mocked.invoke.mockImplementation(async (command: string) =>
      command === "update_channel" ? "microsoftStore" : true,
    );
    const { result } = renderHook(() => useUpdates());
    await act(async () => {
      await result.current.check(true);
    });
    await act(async () => {
      await expect(
        result.current.install(async () => {
          throw new Error("Unsaved budget");
        }),
      ).rejects.toThrow("Unsaved budget");
    });
    expect(mocked.invoke).not.toHaveBeenCalledWith("install_store_update");
    expect(result.current.phase).toBe("idle");
  });

  it.each(["canceled", "no longer available"])(
    "does not restart when a Store update is %s",
    async (outcome) => {
      mocked.invoke.mockImplementation(async (command: string) => {
        if (command === "update_channel") return "microsoftStore";
        if (command === "check_store_update") return true;
        if (outcome === "canceled") throw new Error("Update canceled");
        return false;
      });
      const { result } = renderHook(() => useUpdates());
      await act(async () => {
        await result.current.check(true);
      });
      await act(async () => {
        const install = result.current.install(saveAndInstall);
        if (outcome === "canceled")
          await expect(install).rejects.toThrow("Update canceled");
        else await install;
      });
      expect(mocked.invoke).not.toHaveBeenCalledWith("restart_app");
      expect(result.current.phase).toBe("idle");
      if (outcome === "no longer available")
        expect(result.current.available).toBeNull();
      else expect(result.current.error).toContain("canceled");
    },
  );

  it("provides a Store check, availability notice and Store fallback in Settings", async () => {
    let available = false;
    mocked.invoke.mockImplementation(async (command: string) =>
      command === "update_channel" ? "microsoftStore" : available,
    );
    function Settings() {
      const updates = useUpdates();
      return (
        <>
          <UpdateSetting
            updates={updates}
            version="1.0.6"
            onInstall={vi.fn()}
          />
          <UpdateChip updates={updates} onOpen={vi.fn()} />
        </>
      );
    }
    render(<Settings />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open Microsoft Store" }),
    ).toBeTruthy();
    available = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    });
    expect(
      screen.getByRole("button", { name: "Install Store update" }),
    ).toBeTruthy();
    expect(
      screen.getByTitle("Update available from Microsoft Store"),
    ).toBeTruthy();
    expect(screen.queryByText(/version null/)).toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Open Microsoft Store" }),
      );
    });
    expect(mocked.invoke).toHaveBeenCalledWith("open_update_store");
  });

  it("keeps quiet about a failed background check", async () => {
    mocked.check.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUpdates());
    await act(async () => {
      await result.current.check();
    });
    expect(result.current.error).toBeNull();
    await act(async () => {
      await result.current.check(true);
    });
    expect(result.current.error).toMatch(/offline/);
  });

  it("downloads a found update in the background, so installing doesn't wait for it", async () => {
    const next = update();
    const { result } = await found(next);
    expect(next.download).toHaveBeenCalledTimes(1);
    expect(result.current.ready).toBe(true);
    expect(result.current.phase).toBe("idle");
    await act(async () => {
      await result.current.install(saveAndInstall);
    });
    expect(next.download).toHaveBeenCalledTimes(1);
    expect(mocked.steps).toEqual(["download", "save", "install", "restart_app"]);
  });

  it("keeps a failed background download quiet and downloads again when installing", async () => {
    const next = update();
    next.download.mockRejectedValueOnce(new Error("offline"));
    mocked.check.mockResolvedValue(next);
    const { result } = renderHook(() => useUpdates());
    await act(async () => {
      await result.current.check();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.ready).toBe(false);
    expect(result.current.available?.version).toBe("0.4.1");
    await act(async () => {
      await result.current.install(saveAndInstall);
    });
    expect(next.download).toHaveBeenCalledTimes(2);
    expect(next.install).toHaveBeenCalledTimes(1);
  });

  function store(download: string) {
    mocked.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "update_channel") return "microsoftStore";
      if (command === "check_store_update") return true;
      if (command === "download_store_update") return download;
      mocked.steps.push(args ? `${command} ${JSON.stringify(args)}` : command);
      return true;
    });
  }

  it("installs a downloaded Store update without a prompt and reopens UrBudget", async () => {
    store("ready");
    const { result } = renderHook(() => useUpdates());
    await act(async () => {
      await result.current.check(true);
    });
    expect(result.current.ready).toBe(true);
    await act(async () => {
      await result.current.install(saveAndInstall);
    });
    expect(mocked.steps).toEqual([
      "save",
      'apply_store_update {"relaunch":true}',
      "restart_app",
    ]);
  });

  it("asks Windows first when the Store won't update silently", async () => {
    store("consent");
    const { result } = renderHook(() => useUpdates());
    await act(async () => {
      await result.current.check(true);
    });
    expect(result.current.ready).toBe(false);
    expect(result.current.available).not.toBeNull();
    await act(async () => {
      await result.current.install(saveAndInstall);
    });
    expect(mocked.steps).toEqual(["save", "install_store_update", "restart_app"]);
    expect(await result.current.installOnExit()).toBe(false);
    expect(mocked.steps).not.toContain('apply_store_update {"relaunch":false}');
  });

  it("forgets a Store update that's gone by the time it downloads", async () => {
    store("none");
    const { result } = renderHook(() => useUpdates());
    await act(async () => {
      await result.current.check(true);
    });
    expect(result.current.available).toBeNull();
    expect(result.current.current).toBe(true);
  });

  it("installs a downloaded Store update on closing, without reopening UrBudget", async () => {
    store("ready");
    const { result } = renderHook(() => useUpdates());
    expect(await result.current.installOnExit()).toBe(false);
    await act(async () => {
      await result.current.check(true);
    });
    expect(await result.current.installOnExit()).toBe(true);
    expect(mocked.steps).toEqual(['apply_store_update {"relaunch":false}']);
  });

  it("never installs on closing for a standalone copy, whose installer reopens the app", async () => {
    const { result } = await found(update());
    expect(await result.current.installOnExit()).toBe(false);
    expect(mocked.steps).toEqual(["download"]);
  });

  it("says once, after an update, which version is now running", async () => {
    const seen: string[] = [];
    localStorage.removeItem("lb:version");
    mocked.version.mockResolvedValue("1.0.8");
    let hook = renderHook(() => useUpdatedNotice((v) => seen.push(v)));
    await act(async () => {});
    hook.unmount();
    expect(seen).toEqual([]);
    mocked.version.mockResolvedValue("1.0.9");
    hook = renderHook(() => useUpdatedNotice((v) => seen.push(v)));
    await act(async () => {});
    hook.unmount();
    renderHook(() => useUpdatedNotice((v) => seen.push(v)));
    await act(async () => {});
    expect(seen).toEqual(["1.0.9"]);
  });
});

describe("automatic updates", () => {
  let focused = false;
  beforeEach(() => {
    vi.useFakeTimers();
    focused = false;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("installs a ready update once UrBudget has sat unused in the background", async () => {
    const install = vi.fn();
    renderHook(() => useAutomaticUpdate(true, () => true, install));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_BEFORE_UPDATE - 60_000);
    });
    expect(install).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(install).toHaveBeenCalledTimes(1);
    // A failed attempt waits for another quiet spell instead of retrying every minute.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_BEFORE_UPDATE - 60_000);
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("waits while UrBudget is in use, in front, or has something to lose", async () => {
    const install = vi.fn();
    let safe = false;
    const { rerender } = renderHook(({ ready }) => useAutomaticUpdate(ready, () => safe, install), {
      initialProps: { ready: false },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_BEFORE_UPDATE * 2);
    });
    rerender({ ready: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_BEFORE_UPDATE * 2);
    });
    expect(install).not.toHaveBeenCalled();
    safe = true;
    focused = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_BEFORE_UPDATE * 2);
    });
    expect(install).not.toHaveBeenCalled();
    focused = false;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      await vi.advanceTimersByTimeAsync(IDLE_BEFORE_UPDATE - 60_000);
    });
    expect(install).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(install).toHaveBeenCalledTimes(1);
  });
});
