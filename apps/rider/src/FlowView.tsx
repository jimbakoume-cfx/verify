// Renders the current screen of the flow. Pure view of FlowState: the dev preview renders it with
// fake states, the app with the real controller (useFlow).
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CaptureScreenProps } from "./capture/CaptureScreen";
import type { LivenessScreenProps } from "./liveness/LivenessScreen";
import { ErrorBoundary } from "./ErrorBoundary";
import { type FlowState, canUseShot, mrzReview, sideShots } from "./flow/machine";
import type { FlowActions } from "./flow/useFlow";
import { CheckingScreen } from "./screens/Checking";
import { ConsentScreen, DeclinedScreen } from "./screens/Consent";
import { DocumentChoiceScreen } from "./screens/DocumentChoice";
import { DoneScreen, SessionErrorScreen } from "./screens/End";
import { ReadingScreen } from "./screens/Reading";
import { ReviewScreen } from "./screens/Review";
import { TurnOverScreen } from "./screens/TurnOver";
import { UploadScreen } from "./screens/Upload";
import { WelcomeScreen } from "./screens/Welcome";

const loadCapture = () => import("./capture/CaptureScreen");
// React.lazy remembers a failed import for good, so a retry needs a new lazy component.
let CaptureScreen = lazy(loadCapture);
// M5: the face check, also on demand (fetched while the server checks the photos).
const loadLiveness = () => import("./liveness/LivenessScreen");
let LivenessScreen = lazy(loadLiveness);

function CaptureLoading() {
  const { t } = useTranslation();
  return (
    <div className="capture capture-loading" role="status">
      <p className="hint-pill searching">{t("capture.loading")}</p>
    </div>
  );
}

function CaptureLoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="capture capture-loading">
      <section className="card capture-load-failed" role="alert">
        <h1>{t("capture.loadFailedTitle")}</h1>
        <p>{t("capture.loadFailed")}</p>
        <button type="button" className="primary" onClick={onRetry}>
          {t("common.retry")}
        </button>
      </section>
    </div>
  );
}

/**
 * The camera screen, loaded on demand. If its code cannot be loaded, "Try again" loads it once
 * more (a dropped connection); if that fails too, the page reloads, which is the only way to get
 * the current code after a redeploy (the token survives in sessionStorage).
 */
function CaptureLoader(props: CaptureScreenProps) {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    loadCapture().then(
      () => {
        CaptureScreen = lazy(loadCapture);
        setAttempt((n) => n + 1);
      },
      () => window.location.reload(),
    );
  }, []);
  return (
    <ErrorBoundary key={attempt} fallback={<CaptureLoadFailed onRetry={retry} />}>
      <Suspense fallback={<CaptureLoading />}>
        <CaptureScreen {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** The face check screen, loaded on demand, with the same retry as the camera's. */
function LivenessLoader(props: LivenessScreenProps) {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    loadLiveness().then(
      () => {
        LivenessScreen = lazy(loadLiveness);
        setAttempt((n) => n + 1);
      },
      () => window.location.reload(),
    );
  }, []);
  return (
    <ErrorBoundary key={attempt} fallback={<CaptureLoadFailed onRetry={retry} />}>
      <Suspense fallback={<CaptureLoading />}>
        <LivenessScreen {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

export function FlowView({ state, actions, debug }: { state: FlowState; actions: FlowActions; debug: boolean }) {
  const { screen } = state;
  const side = "side" in screen ? screen.side : null;

  // Each step starts at the top of the page.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen.name, side]);

  // Fetch the camera code while the rider reads the consent text (slow networks). A failure here
  // is reported by CaptureLoader when the camera is needed.
  useEffect(() => {
    if (screen.name === "consent" || screen.name === "document") loadCapture().catch(() => {});
    if (screen.name === "upload" || screen.name === "checking") loadLiveness().catch(() => {});
  }, [screen.name]);

  switch (screen.name) {
    case "welcome":
      return (
        <WelcomeScreen
          load={state.load}
          session={state.session}
          error={state.error}
          onStart={actions.start}
          onRetry={actions.retryLoad}
        />
      );
    case "consent":
      return (
        <ConsentScreen
          busy={state.busy}
          error={state.error}
          onAccept={actions.acceptConsent}
          onDecline={actions.declineConsent}
        />
      );
    case "declined":
      return <DeclinedScreen onReview={actions.reviewConsent} />;
    case "document":
      return (
        <DocumentChoiceScreen
          initial={state.document ?? state.session?.declaredDocument ?? null}
          busy={state.busy}
          error={state.error}
          onChoose={actions.chooseDocument}
        />
      );
    case "capture":
      if (!state.document) return null;
      return (
        <CaptureLoader
          key={screen.side}
          side={screen.side}
          document={state.document}
          error={state.error}
          retake={state.retakeReasons[screen.side] ?? null}
          debug={debug}
          onCaptured={actions.captured}
          onBack={actions.back}
        />
      );
    case "turnOver":
      return (
        <TurnOverScreen
          document={state.document}
          retake={state.retakeReasons[screen.side] ?? null}
          onContinue={actions.turnOverReady}
        />
      );
    case "reading": {
      const shot = state.shots[screen.side];
      if (!shot) return null;
      return <ReadingScreen shot={shot} document={state.document} progress={state.readProgress} onBack={actions.back} />;
    }
    case "review": {
      const shot = state.shots[screen.side];
      if (!shot) return null;
      return (
        <ReviewScreen
          shot={shot}
          document={state.document}
          canUse={canUseShot(state, shot)}
          mrz={mrzReview(state, shot)}
          debug={debug}
          onUse={actions.useShot}
          onRetake={actions.retake}
        />
      );
    }
    case "upload":
      return <UploadScreen upload={state.upload} error={state.error} onRetry={actions.retryUpload} />;
    case "checking":
      return (
        <CheckingScreen
          shots={sideShots(state)}
          document={state.document}
          expired={state.expiredNotice === "shown"}
          onAnotherDocument={actions.chooseAnotherDocument}
          onContinueAnyway={actions.continueExpired}
        />
      );
    case "liveness":
      return (
        <LivenessLoader
          service={actions.liveness}
          debug={debug}
          error={state.error}
          onDone={actions.livenessDone}
          onFailed={actions.livenessFailed}
        />
      );
    case "done":
      return <DoneScreen />;
    case "sessionError":
      return <SessionErrorScreen reason={screen.reason} />;
  }
}
