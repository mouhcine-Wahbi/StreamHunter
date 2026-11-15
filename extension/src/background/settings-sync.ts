import { ApiClient } from "@/services/api-client";
import { getAuthToken, getSettings } from "@/store/storage";

/**
 * Pushes the local settings to the backend when signed in. The browser stays the source of
 * truth (what the user sees is what the backend uses); `backendUrl` never leaves the browser.
 * Failures are ignored: the next change or sign-in retries.
 */
export async function syncSettingsToBackend(): Promise<boolean> {
  const token = await getAuthToken();
  if (!token) return false;
  const settings = await getSettings();
  const { backendUrl, ...rest } = settings;
  try {
    await new ApiClient({ baseUrl: backendUrl, getToken: async () => token }).patch("/api/v1/settings", rest);
    return true;
  } catch {
    return false;
  }
}
