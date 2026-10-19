// Runs the flow: the reducer (machine.ts) plus the side effects it asks for (API calls, reading the
// MRZ, uploads, waiting for the server's checks).
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  CONSENT_VERSION,
  DEFAULT_LANGUAGE,
  MRZ_EXPECTATION,
  SUPABASE_PUBLISHABLE_KEY,
  explicitLanguage,
  functionUrl,
  isSupportedLanguage,
  showLanguage,
  type CaptureSide,
  type DeclaredDocument,
  type FlowSession,
} from "@verify/shared";
import { createLazyMrzReader, unavailableRead } from "../mrz/lazyReader";
import { type MrzModel, type MrzReader, mrzModelFor } from "../mrz/types";
import { type FlowApi, createFlowApi } from "./api";
import { type ChecksTiming, waitForChecks } from "./checks";
import type { LivenessService } from "../liveness/send";
import { type FlowErrorCode, isTransient, toFlowError } from "./errors";
import { listenForBack, pushBackGuard } from "./history";
import { sessionLanguage } from "./language";
import {
  type FlowAction,
  type FlowState,
  type Shot,
  type UploadProgress,
  checksDecision,
  flowReducer,
  handlesBack,
  initialFlowState,
  mrzExpectationFor,
  pendingShots,
  sideShots,
} from "./machine";
import { UPLOAD_RETRY, withRetry } from "./retry";
import { putObjectWithSupabase } from "./storage";
import { forgetSessionToken } from "./token";
import { Uploader, uploadSteps } from "./upload";

/** Everything a screen can ask for. */
export interface FlowActions {
  start(): void;
  retryLoad(): void;
  /** `keepFaceImages`: the separate, optional box (M5), unticked unless the rider ticks it. */
  acceptConsent(keepFaceImages: boolean): void;
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
  /** M4, the document has expired: back to the document list. */
  chooseAnotherDocument(): void;
  /** M4, the document has expired: go on with it (staff see the flag). */
  continueExpired(): void;
  /** M5: what the face check screen asks of the server; null without a session link. */
  liveness: LivenessService | null;
  /** M5: the server recorded the face check. */
  livenessDone(): void;
  /** M5: the face check met an error; one that ends the session shows the session's error screen. */
  livenessFailed(error: FlowErrorCode): void;
}

export interface Boot {
  token: string | null;
  invalidLink: boolean;
}

export interface FlowOptions {
  /** How long to wait for the server's checks, and how often to ask (default: CHECKS_TIMING). */
  checks?: Partial<ChecksTiming>;
}

export function useFlow(boot: Boot, options: FlowOptions = {}): { state: FlowState; actions: FlowActions } {
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

  // One MRZ reader for the visit: its engine and model are downloaded once (about 2.8 MB the first
  // time, then cached by the browser), and stopped when the app goes away. Test sessions read with
  // our own model (M4); the session is known before any document is chosen, so the reader is made
  // with the right one (a change of session, which never happens in one visit, would make a new one).
  const model = mrzModelFor(state.session?.isTest === true);
  const modelRef = useRef<MrzModel>(model);
  useEffect(() => {
    modelRef.current = model;
  });
  const readerRef = useRef<{ model: MrzModel; reader: MrzReader } | null>(null);
  const reader = useCallback(() => {
    const wanted = modelRef.current;
    if (readerRef.current?.model !== wanted) {
      readerRef.current?.reader.dispose();
      readerRef.current = { model: wanted, reader: createLazyMrzReader(undefined, undefined, wanted) };
    }
    return readerRef.current.reader;
  }, []);
  useEffect(
    () => () => {
      readerRef.current?.reader.dispose();
      readerRef.current = null;
    },
    [],
  );

  // Start that download as soon as a document with code lines is chosen, so it is usually done by
  // the time its photo is taken; again when that side's camera opens, in case it failed.
  const { document } = state;
  const mrzSide = document ? (MRZ_EXPECTATION[document]?.side ?? null) : null;
  const atMrzCamera = screen.name === "capture" && screen.side === mrzSide;
  useEffect(() => {
    if (mrzSide) reader().warmUp();
  }, [mrzSide, reader]);
  useEffect(() => {
    if (atMrzCamera) reader().warmUp();
  }, [atMrzCamera, reader]);

  // The reading screen reads the photo just taken. Leaving it (Back) aborts the read; a result for a
  // photo that is no longer the one being read is ignored by the reducer.
  const readingShot = screen.name === "reading" ? state.shots[screen.side] : undefined;
  useEffect(() => {
    const expectation = readingShot ? mrzExpectationFor(document, readingShot.side) : null;
    if (!readingShot || !expectation) return;
    const shot = readingShot;
    const controller = new AbortController();
    let settled = false;
    const engine = modelRef.current.engine;
    const read = shot.gray
      ? reader().read(shot.gray, expectation, {
          signal: controller.signal,
          onProgress: (progress) => dispatch({ type: "mrz/progress", shot, progress }),
        })
      : Promise.resolve(unavailableRead(expectation.format, engine));
    void read
      .catch(() => unavailableRead(expectation.format, engine))
      .then((result) => {
        settled = true;
        if (!controller.signal.aborted) dispatch({ type: "mrz/read", shot, result });
      });
    // Only a read still running is aborted: aborting restarts the reader's engine.
    return () => {
      if (!settled) controller.abort();
    };
  }, [readingShot, document, reader]);

  // Closing or leaving the page during an upload, while the server checks the photos or during the
  // face check, before the submit, loses the photos: ask first (where browsers allow).
  const checking = screen.name === "checking";
  const uploading =
    state.upload.status === "running" || state.upload.status === "queued" || checking || screen.name === "liveness";
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

  // Uploads start when the reducer queues them: the photos after the last one is accepted (then the
  // checking screen), the submit once the checks are over, and either again on "Try again".
  const { status: uploadStatus } = state.upload;
  useEffect(() => {
    if (uploadStatus !== "queued" || !uploader) return;
    const listener = {
      progress: (progress: UploadProgress) => dispatch({ type: "upload/progress", progress }),
      sideDone: (side: CaptureSide) => dispatch({ type: "upload/sideDone", side }),
    };
    if (state.upload.stage === "submit") {
      // The bar ends where the photos' upload left it: their steps, then this one.
      const shots = sideShots(state);
      const total = uploadSteps(shots);
      const photos = shots.length;
      dispatch({
        type: "upload/started",
        progress: { done: total - 1, total, phase: "submit", photo: 0, photos, attempt: 1 },
      });
      void uploader
        .submit(listener, { total, photos })
        .then((outcome) =>
          dispatch(
            outcome.ok
              ? { type: "upload/submitted", session: outcome.session }
              : { type: "upload/failed", error: outcome.error, side: null },
          ),
        );
      return;
    }
    const shots = pendingShots(state);
    const photos = shots.length;
    dispatch({
      type: "upload/started",
      progress: {
        done: 0,
        total: uploadSteps(shots),
        phase: photos ? "link" : "submit",
        photo: photos ? 1 : 0,
        photos,
        attempt: 1,
      },
    });
    void uploader
      .uploadSides(shots, listener)
      .then((outcome) =>
        dispatch(
          outcome.ok ? { type: "upload/sent" } : { type: "upload/failed", error: outcome.error, side: outcome.side },
        ),
      );
    // Only a newly queued upload starts a run; `state` is read at that moment on purpose.
  }, [uploadStatus, uploader]);

  // The checking screen asks for the server's checks until they are settled or the time is up, then
  // submits or sends the rider back to the camera. Leaving the screen stops the wait. A ring that
  // never came, a server that is down or an error: the photos go as they are, with no error shown.
  // M4: while the rider decides about an expired document, nothing is asked; "Continue anyway"
  // starts a new wait.
  const waitMs = options.checks?.waitMs;
  const pollMs = options.checks?.pollMs;
  const waiting = checking && state.expiredNotice !== "shown";
  useEffect(() => {
    if (!waiting || !api) return;
    const controller = new AbortController();
    void waitForChecks({
      getChecks: (signal) => api.getChecks(signal),
      decide: (checks) => checksDecision(stateRef.current, checks),
      timing: { waitMs, pollMs },
      signal: controller.signal,
    }).then((result) => {
      if (!result || controller.signal.aborted) return;
      dispatch(result.type === "decided" ? result.decision : { type: "checks/timeout" });
    });
    return () => controller.abort();
  }, [waiting, api, waitMs, pollMs]);

  const actions = useMemo<FlowActions>(() => {
    const language = () => (isSupportedLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE);
    return {
      start: () => dispatch({ type: "start" }),
      retryLoad: () => void loadSession(),
      acceptConsent: (keepFaceImages) =>
        void request(
          (a) => a.consent({ consentVersion: CONSENT_VERSION, language: language(), keepFaceImages }),
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
      chooseAnotherDocument: () => dispatch({ type: "expired/another" }),
      continueExpired: () => dispatch({ type: "expired/continue" }),
      liveness: api
        ? {
            challenge: () => api.livenessChallenge(),
            upload: putObjectWithSupabase,
            record: (body) => api.recordLiveness(body),
          }
        : null,
      livenessDone: () => dispatch({ type: "liveness/done" }),
      livenessFailed: (error) => dispatch({ type: "liveness/failed", error }),
    };
  }, [i18n, loadSession, request, api]);

  return { state, actions };
}
