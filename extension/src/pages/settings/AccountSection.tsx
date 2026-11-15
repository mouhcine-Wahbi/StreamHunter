import { useState, type FormEvent } from "react";
import { CloudOff, LogOut, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAuth } from "@/hooks/useAuth";
import { ApiError } from "@/services/api-client";

type Mode = "signin" | "register";
const MODES: readonly { id: Mode; label: string }[] = [
  { id: "signin", label: "Sign in" },
  { id: "register", label: "Create account" },
];

function describe(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.kind === "network" || e.kind === "timeout") return "Backend not reachable. Check the backend URL above.";
    const fieldErrors = (e.detail as { error?: { details?: { errors?: { loc: string[]; msg: string }[] } } })?.error?.details
      ?.errors;
    if (fieldErrors?.length) return fieldErrors.map((f) => `${f.loc.at(-1)}: ${f.msg}`).join(" · ");
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}

export function AccountSection() {
  const { state, signIn, register, signOut } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status === "loading") return null;

  if (state.status === "unreachable") {
    return (
      <EmptyState compact tone="warn" icon={<CloudOff className="size-5" />} title="Backend not reachable">
        Start the backend to sign in. Your session is kept until then.
      </EmptyState>
    );
  }

  if (state.status === "signed_in") {
    return (
      <Card className="flex items-center gap-3 p-4">
        <div className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent">
          <UserRound className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">{state.user.username}</div>
          <div className="truncate text-xs text-fg-muted">{state.user.email}</div>
        </div>
        <Button size="sm" variant="ghost" icon={<LogOut className="size-3.5" />} onClick={() => void signOut()}>
          Sign out
        </Button>
      </Card>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "signin") await signIn(email.trim(), password);
      else await register(email.trim(), username.trim(), password);
      setPassword("");
    } catch (err) {
      setError(describe(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="StreamHunter account">
      <Segmented label="Account action" value={mode} options={MODES} onChange={(m) => (setMode(m), setError(null))} />
      <Field label="Email">
        {({ id }) => (
          <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        )}
      </Field>
      {mode === "register" && (
        <Field label="Username" hint="2–64 letters, numbers, dots, dashes or underscores.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              autoComplete="username"
              required
              minLength={2}
              maxLength={64}
              pattern="[A-Za-z0-9_.\-]+"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>
      )}
      <Field label="Password" hint={mode === "register" ? "At least 10 characters." : undefined}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={mode === "register" ? 10 : 1}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </Field>
      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" loading={pending}>
        {mode === "signin" ? "Sign in" : "Create account"}
      </Button>
    </form>
  );
}
