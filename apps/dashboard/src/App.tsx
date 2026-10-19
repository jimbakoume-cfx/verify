import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type EnrollRequest, getSupabase, type TestSessionResponse } from "@verify/shared";
import { enroll } from "./api/admin";
import { createSupabaseServices, fetchOwnProfile, ServicesContext, type Supabase } from "./api/services";
import { Footer, TopBar } from "./components/Chrome";
import { ErrorText } from "./components/Feedback";
import { useAsync, usePath } from "./hooks";
import { errorMessageKey, signInErrorKey, toClientError } from "./lib/errors";
import type { StaffProfile } from "./lib/records";
import { parseRoute } from "./lib/routes";
import { forgetStoredSessions, signOutWithin } from "./lib/signOut";
import { CaseView } from "./screens/CaseView";
import { EnrollScreen } from "./screens/Enroll";
import { Home } from "./screens/Home";
import { LoadingScreen, MessageScreen, NoAccessScreen, NotConfiguredScreen } from "./screens/Message";
import { SignInScreen } from "./screens/SignIn";
import { ThresholdsPage } from "./screens/Thresholds";

export function App() {
  const supabase = getSupabase();
  return supabase ? <StaffApp supabase={supabase} /> : <NotConfiguredScreen />;
}

type AuthState = { status: "loading" } | { status: "signed_out" } | { status: "signed_in"; userId: string; email: string };

/** Session from Supabase Auth (persisted in localStorage and refreshed by supabase-js). */
function useAuthState(supabase: Supabase): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  useEffect(() => {
    // Fires INITIAL_SESSION first, then on every sign-in, sign-out and token refresh.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setState((prev) => {
        if (!session) return prev.status === "signed_out" ? prev : { status: "signed_out" };
        if (prev.status === "signed_in" && prev.userId === session.user.id) return prev;
        return { status: "signed_in", userId: session.user.id, email: session.user.email ?? "" };
      });
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);
  return state;
}

type AuthScreen = { name: "signIn"; email?: string; notice?: string } | { name: "enroll"; email?: string };

const normaliseEmail = (email: string) => email.trim().toLowerCase();

function StaffApp({ supabase }: { supabase: Supabase }) {
  const auth = useAuthState(supabase);
  const [screen, setScreen] = useState<AuthScreen>({ name: "signIn" });
  const [signingOut, setSigningOut] = useState(false);
  // Whatever happens later (sign-out, expired session), the next signed-out view is the sign-in form.
  useEffect(() => {
    if (auth.status === "signed_in") setScreen({ name: "signIn" });
    else setSigningOut(false);
  }, [auth.status]);

  async function signIn(email: string, password: string): Promise<string | null> {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: normaliseEmail(email), password });
      return error ? signInErrorKey(error) : null;
    } catch {
      return "errors.network";
    }
  }

  async function setUpAccount(request: EnrollRequest): Promise<string | null> {
    try {
      await enroll(request);
    } catch (error) {
      return errorMessageKey(toClientError(error).code, "enroll");
    }
    // The account exists now; signing in is a convenience, so a failure just leads to the sign-in form.
    if ((await signIn(request.email, request.password)) !== null) {
      setScreen({ name: "signIn", email: request.email, notice: "signIn.accountReady" });
    }
    return null;
  }

  async function signOut() {
    // The staff pages (and any open photo) leave the screen at once, whatever the network does.
    setSigningOut(true);
    await signOutWithin({
      // "local" ends this browser's session only, not the staff member's other devices.
      signOut: () => supabase.auth.signOut({ scope: "local" }),
      forgetSession: () => {
        try {
          forgetStoredSessions(window.localStorage);
        } catch {
          // Storage unavailable: nothing was persisted there.
        }
      },
      reload: () => window.location.reload(),
    });
  }

  if (auth.status === "loading") return <LoadingScreen />;
  if (signingOut && auth.status === "signed_in") return <SigningOutScreen />;
  if (auth.status === "signed_out") {
    return screen.name === "enroll" ? (
      <EnrollScreen
        initial={{ email: screen.email }}
        onEnroll={setUpAccount}
        onBack={(email) => setScreen({ name: "signIn", email })}
      />
    ) : (
      <SignInScreen
        key={screen.notice ?? "signIn"}
        initialEmail={screen.email}
        notice={screen.notice}
        onSignIn={signIn}
        onSetUp={(email) => setScreen({ name: "enroll", email })}
      />
    );
  }
  return (
    <SignedIn supabase={supabase} userId={auth.userId} email={auth.email} onSignOut={() => void signOut()} />
  );
}

function SigningOutScreen() {
  const { t } = useTranslation();
  return <MessageScreen title={t("nav.signingOut")} busy />;
}

function SignedIn({
  supabase,
  userId,
  email,
  onSignOut,
}: {
  supabase: Supabase;
  userId: string;
  email: string;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const profile = useAsync(() => fetchOwnProfile(supabase, userId), userId);
  const services = useMemo(() => createSupabaseServices(supabase), [supabase]);

  if (profile.loading && profile.data === undefined) return <LoadingScreen />;
  if (profile.error !== null && profile.error !== undefined) {
    return (
      <MessageScreen title={t("profileError.title")} onSignOut={onSignOut}>
        <ErrorText error={profile.error} />
        <button type="button" onClick={profile.reload}>
          {t("retry")}
        </button>
      </MessageScreen>
    );
  }
  if (!profile.data || !profile.data.active) return <NoAccessScreen email={email} onSignOut={onSignOut} />;

  return (
    <ServicesContext.Provider value={services}>
      <StaffPages profile={profile.data} onSignOut={onSignOut} />
    </ServicesContext.Provider>
  );
}

/** The signed-in pages. Also rendered by the dev screen preview with fake services. */
export function StaffPages({
  profile,
  onSignOut,
  initialTestSession = null,
  children,
}: {
  profile: StaffProfile;
  onSignOut: () => void;
  initialTestSession?: TestSessionResponse | null;
  /** Replaces the routed page (dev screen preview). */
  children?: ReactNode;
}) {
  const path = usePath();
  const route = parseRoute(path);
  // Held in memory only: the rider link carries a live session token.
  const [testSession, setTestSession] = useState<TestSessionResponse | null>(initialTestSession);

  return (
    <main className="page dash-wide">
      <TopBar profile={profile} onSignOut={onSignOut} />
      {children ??
        (route.name === "case" ? (
          <CaseView key={route.id} id={route.id} profile={profile} />
        ) : route.name === "thresholds" ? (
          <ThresholdsPage profile={profile} />
        ) : (
          <Home profile={profile} testSession={testSession} onTestSession={setTestSession} />
        ))}
      <Footer />
    </main>
  );
}
