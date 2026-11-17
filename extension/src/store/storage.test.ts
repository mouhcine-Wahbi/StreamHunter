import {
  getMonitoringState,
  getSettings,
  onStorageKeyChange,
  patchMonitoringState,
  STORAGE_KEYS,
  updateSettings,
} from "./storage";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { INITIAL_MONITORING_STATE } from "@/types/monitoring";

describe("storage", () => {
  it("returns defaults when nothing is stored", async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await getMonitoringState()).toEqual(INITIAL_MONITORING_STATE);
  });

  it("persists sanitized settings patches", async () => {
    await updateSettings({ monitoring: { intervalMinutes: 5 } });
    await updateSettings({ detection: { minHighlightScore: 999 } });
    const stored = fakeChrome.internals.store[STORAGE_KEYS.settings] as typeof DEFAULT_SETTINGS;
    expect(stored.monitoring.intervalMinutes).toBe(5);
    expect(stored.detection.minHighlightScore).toBe(100);
    expect((await getSettings()).monitoring.intervalMinutes).toBe(5);
  });

  it("re-sanitizes corrupted stored settings", async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { backendUrl: "ftp://x", monitoring: { intervalMinutes: "abc" } } });
    const s = await getSettings();
    expect(s).not.toHaveProperty("backendUrl"); // old settings from the backend era are dropped
    expect(s.monitoring.intervalMinutes).toBe(DEFAULT_SETTINGS.monitoring.intervalMinutes);
  });

  it("merges monitoring state patches", async () => {
    await patchMonitoringState({ enabled: true, status: "starting" });
    await patchMonitoringState({ status: "active" });
    expect(await getMonitoringState()).toMatchObject({ enabled: true, status: "active", consecutiveFailures: 0 });
  });

  it("notifies subscribers of a specific key only", async () => {
    const cb = vi.fn();
    const off = onStorageKeyChange(STORAGE_KEYS.monitoring, cb);
    await updateSettings({ monitoring: { intervalMinutes: 3 } });
    expect(cb).not.toHaveBeenCalled();
    await patchMonitoringState({ status: "active" });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    off();
    await patchMonitoringState({ status: "stopped" });
    expect(cb).toHaveBeenCalledTimes(1);
  });


});
