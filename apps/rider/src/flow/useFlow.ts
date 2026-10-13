// Runs the flow: the reducer (machine.ts) plus the side effects it asks for (API calls, uploads).
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  CONSENT_VERSION,
  DEFAULT_LANGUAGE,
  SUPABASE_PUBLISHABLE_KEY,
  explicitLanguage,
  functionUrl,
  isSupportedLanguage,
  showLanguage,
  type DeclaredDocument,
  type FlowSession,
} from "@verify/shared";
import { type FlowApi, createFlowApi } from "./api";
import { isTransient, toFlowError } from "./errors";
import { listenForBack, pushBackGuard } from "./history";
import { sessionLanguage } from "./language";
import {
  type FlowAction,
  type FlowState,
  type Shot,
  flowReducer,
  handlesBack,
  initialFlowState,
  pendingShots,
} from "./machine";
import { UPLOAD_RETRY, withRetry } from "./retry";
import { putObjectWithSupabase } from "./storage";
import { forgetSessionToken } from "./token";
import { Uploader } from "./upload";

/** Everything a screen can ask for. */
export interface FlowActions {
  start(): void;
  retryLoad(): void;
  acceptConsent(): void;
  declineConsent(): void;
  reviewConsent(): void;
  chooseDocument(document: DeclaredDocument): void;
  /** One step back (the camera's Back button, and the phone's). */
  back(): void;
  captured(shot: Shot): void;
  retake(): void;
  useShot(): void;
  turnOverReady(): void;
  retryUpload(): void;
}

export interface Boot {
  token: string | null;
  invalidLink: boolean;
}

export function useFlow(boot: Boot): { state: FlowState; actions: FlowActions } {
  const [state, dispatch] = useReducer(flowReducer, boot, (b: Boot) =>
    initialFlowState({ hasToken: b.token !== null, invalidLink: b.invalidLink }),
  );
  const { i18n } = useTranslation();
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const api = useMemo<FlowApi | null>(
    () =>
      boot.token
        ? createFlowApi({ baseUrl: functionUrl("flow"), token: boot.token, apiKey: SUPABASE_PUBLISHABLE_KEY })
        : null,
    [boot.token],
  );
  const uploader = useMemo(() => (api ? new Uploader({ api, putObject: putObjectWithSupabase }) : null), [api]);

  const loadSession = useCallback(async () => {
    if (!api) return;
    dispatch({ type: "session/loading" });
    try {
      dispatch({ type: "session/loaded", session: await api.getSession() });
    } catch (err) {
      dispatch({ type: "session/failed", error: toFlowError(err).code });
    }
  }, [api]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // A link that can no longer be used is forgotten, so a reload does not try it again.
  useEffect(() => {
    if (state.screen.name === "sessionError") forgetSessionToken();
  }, [state.screen.name]);

  // The session's language (chosen by whoever created it), unless the rider or the link chose one.
  const sessionLocale = state.session?.locale;
  useEffect(() => {
    const next = sessionLanguage(sessionLocale ?? null, explicitLanguage(), i18n.language);
    if (next) void showLanguage(next);
  }, [sessionLocale, i18n]);

  // The phone's Back button steps back through the photos instead of leaving the page (history.ts).
  const { screen } = state;
  useEffect(() => {
    if (handlesBack(screen)) pushBackGuard();
  }, [screen]);
  useEffect(
    () =>
      listenForBack({
        handlesBack: () => handlesBack(stateRef.current.screen),
        stepBack: () => {
          const next = flowReducer(stateRef.current, { type: "nav/back" });
          dispatch({ type: "nav/back" });
          return handlesBack(next.screen);
        },
      }),
    [],
  );

  // Closing or leaving the page during an upload loses the photos: ask first (where browsers allow).
  const uploading = state.upload.status === "running" || state.upload.status === "queued";
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  // Consent and document choice: small idempotent calls, retried automatically on a bad network.
  const request = useCallback(
    async (call: (api: FlowApi) => Promise<FlowSession>, done: (session: FlowSession) => FlowAction) => {
      if (!api) return;
      dispatch({ type: "request/start" });
      try {
        const session = await withRetry(() => call(api), {
          policy: UPLOAD_RETRY,
          toError: toFlowError,
          shouldRetry: isTransient,
        });
        dispatch(done(session));
      } catch (err) {
        dispatch({ type: "request/failed", error: toFlowError(err).code });
      }
    },
    [api],
  );

  // Uploads start when the reducer queues them (after the last photo is accepted, or "Try again").
  const { status: uploadStatus } = state.upload;
  useEffect(() => {
    if (uploadStatus !== "queued" || !uploader) return;
    const shots = pendingShots(state);
    const photos = shots.length;
    dispatch({
      type: "upload/started",
      progress: { done: 0, total: photos * 3 + 1, phase: photos ? "link" : "submit", photo: photos ? 1 : 0, photos, attempt: 1 },
    });
    void uploader
      .run(shots, {
        progress: (progress) => dispatch({ type: "upload/progress", progress }),
        sideDone: (side) => dispatch({ type: "upload/sideDone", side }),
      })
      .then((outcome) =>
        dispatch(
          outcome.ok
            ? { type: "upload/submitted", session: outcome.session }
            : { type: "upload/failed", error: outcome.error, side: outcome.side },
        ),
      );
    // Only a newly queued upload starts a run; `state` is read at that moment on purpose.
  }, [uploadStatus, uploader]);

  const actions = useMemo<FlowActions>(() => {
    const language = () => (isSupportedLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE);
    return {
      start: () => dispatch({ type: "start" }),
      retryLoad: () => void loadSession(),
      acceptConsent: () =>
        void request(
          (a) => a.consent({ consentVersion: CONSENT_VERSION, language: language() }),
          (session) => ({ type: "consent/accepted", session }),
        ),
      declineConsent: () => dispatch({ type: "consent/decline" }),
      reviewConsent: () => dispatch({ type: "consent/review" }),
      chooseDocument: (declaredDocument) => {
        const { session, document } = stateRef.current;
        // The same document again: the server already has it, no second request (and audit row).
        if (session && document === declaredDocument && session.declaredDocument === declaredDocument) {
          dispatch({ type: "document/chosen", session });
          return;
        }
        void request(
          (a) => a.setDocumentType({ declaredDocument }),
          (next) => ({ type: "document/chosen", session: next }),
        );
      },
      back: () => dispatch({ type: "nav/back" }),
      captured: (shot) => dispatch({ type: "capture/taken", shot }),
      retake: () => dispatch({ type: "review/retake" }),
      useShot: () => dispatch({ type: "review/accept" }),
      turnOverReady: () => dispatch({ type: "turnOver/ready" }),
      retryUpload: () => dispatch({ type: "upload/retry" }),
    };
  }, [i18n, loadSession, request]);

  return { state, actions };
}
