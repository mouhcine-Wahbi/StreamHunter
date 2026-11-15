import { useCallback, useState } from "react";
import { ApiError } from "@/services/api-client";
import { useApiClient } from "@/hooks/useApiQuery";
import type { Clip } from "@/types/api";

/**
 * Requests (or retries) an official Twitch clip. If the moment is older than Twitch's buffer,
 * the backend answers `moment_passed`; the UI then asks the editor whether to capture the
 * *current* broadcast instead. It never does that silently.
 */
export function useClipRequest(onDone: () => void) {
  const client = useApiClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [momentPassed, setMomentPassed] = useState<string | null>(null);

  const request = useCallback(
    async (clipId: number, retry: boolean, acceptCurrentMoment = false) => {
      setPending(true);
      setError(null);
      try {
        const clip = await client.post<Clip>(`/api/v1/clips/${clipId}/${retry ? "retry" : "create"}`, {
          accept_current_moment: acceptCurrentMoment,
        });
        setMomentPassed(null);
        if (clip.status === "failed" && clip.error_message) setError(clip.error_message);
        onDone();
      } catch (e) {
        if (e instanceof ApiError && e.code === "moment_passed") setMomentPassed(e.message);
        else setError(e instanceof Error ? e.message : "Clip request failed");
      } finally {
        setPending(false);
      }
    },
    [client, onDone],
  );

  return { request, pending, error, momentPassed, dismissMomentPassed: () => setMomentPassed(null) };
}
