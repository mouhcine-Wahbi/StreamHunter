import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/services/api-client";
import { sendRequest } from "@/services/runtime";
import { getAuthToken, onStorageKeyChange, setAuthToken, STORAGE_KEYS } from "@/store/storage";
import { useApiClient } from "./useApiQuery";

export interface AccountUser {
  id: number;
  email: string;
  username: string;
  created_at: string;
}

interface TokenResponse {
  access_token: string;
  expires_at: string;
  user: AccountUser;
}

export type AuthState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "signed_in"; user: AccountUser }
  | { status: "unreachable"; message: string };

/** StreamHunter account session. The token is a StreamHunter session, never a platform token. */
export function useAuth() {
  const client = useApiClient();
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => onStorageKeyChange(STORAGE_KEYS.authToken, () => setNonce((n) => n + 1)), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!(await getAuthToken())) return alive && setState({ status: "signed_out" });
      try {
        const user = await client.get<AccountUser>("/api/v1/auth/me");
        if (alive) setState({ status: "signed_in", user });
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) {
          await setAuthToken(null); // expired or revoked session
          setState({ status: "signed_out" });
        } else {
          setState({ status: "unreachable", message: e instanceof Error ? e.message : "Backend unreachable" });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, nonce]);

  const afterChange = () => void sendRequest({ type: "monitoring/check-now" }).catch(() => undefined);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await client.post<TokenResponse>("/api/v1/auth/login", { email, password });
      await setAuthToken(res.access_token);
      setState({ status: "signed_in", user: res.user });
      afterChange();
    },
    [client],
  );

  const register = useCallback(
    async (email: string, username: string, password: string) => {
      const res = await client.post<TokenResponse>("/api/v1/auth/register", { email, username, password });
      await setAuthToken(res.access_token);
      setState({ status: "signed_in", user: res.user });
      afterChange();
    },
    [client],
  );

  const signOut = useCallback(async () => {
    await client.post("/api/v1/auth/logout").catch(() => undefined); // revoke server-side if reachable
    await setAuthToken(null);
    setState({ status: "signed_out" });
  }, [client]);

  return { state, signIn, register, signOut };
}
