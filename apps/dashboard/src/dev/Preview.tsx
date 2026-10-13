// Dev-only (never in production builds): every screen with fake data, for screenshots and layout
// checks without a backend. Open /?screen=<name>, add &lang=en for English.
import { type ReactNode, useMemo } from "react";
import type { CaptureViewResponse, TestSessionResponse } from "@verify/shared";
import { StaffPages } from "../App";
import { type DashboardServices, ServicesContext } from "../api/services";
import type { OpenPhoto } from "../components/PhotoViewer";
import type { CaptureRecord, StaffProfile, VerificationListItem } from "../lib/records";
import { CaseView } from "../screens/CaseView";
import { EnrollScreen } from "../screens/Enroll";
import { LoadingScreen, NoAccessScreen, NotConfiguredScreen } from "../screens/Message";
import { SignInScreen } from "../screens/SignIn";

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const noop = () => undefined;
const never = () => new Promise<null>(noop);

const PROFILES: Record<StaffProfile["role"], StaffProfile> = {
  reviewer: { userId: "00000000-0000-4000-8000-000000000001", role: "reviewer", fullName: "Awa Reviewer", active: true },
  supervisor: { userId: "00000000-0000-4000-8000-000000000002", role: "supervisor", fullName: "Jean Supervisor", active: true },
  admin: { userId: "00000000-0000-4000-8000-000000000003", role: "admin", fullName: "Admin Example", active: true },
};

const CASE_ID = "7d0c1a52-3f0e-4c8e-9a51-2b6f4f1d9e10";

const VERIFICATIONS: VerificationListItem[] = [
  {
    id: CASE_ID,
    status: "submitted",
    declaredDocument: "cni",
    isTest: true,
    createdAt: minutes(-12),
    submittedAt: minutes(-4),
    sessionExpiresAt: minutes(18),
    captureCount: 2,
  },
  {
    id: "2b9f6a10-8c4d-4e1f-b7a3-5d2e9c0f1a22",
    status: "in_progress",
    declaredDocument: "passport",
    isTest: true,
    createdAt: minutes(-25),
    submittedAt: null,
    sessionExpiresAt: minutes(5),
    captureCount: 1,
  },
  {
    id: "c41e8d77-0a3b-4f5c-9e26-7b1d3a8f6c33",
    status: "created",
    declaredDocument: null,
    isTest: true,
    createdAt: minutes(-95),
    submittedAt: null,
    sessionExpiresAt: minutes(-65),
    captureCount: 0,
  },
  {
    id: "e5a2c9f0-6d1b-4a8e-8f37-9c4b2e7d1a44",
    status: "in_review",
    declaredDocument: "driving_licence",
    isTest: false,
    createdAt: minutes(-60 * 26),
    submittedAt: minutes(-60 * 26 + 6),
    sessionExpiresAt: minutes(-60 * 25),
    captureCount: 2,
  },
];

const CAPTURES: CaptureRecord[] = [
  {
    id: "a1111111-1111-4111-8111-111111111111",
    kind: "document_front",
    byteSize: 241_337,
    width: 1600,
    height: 1009,
    createdAt: minutes(-6),
    sha256: "9f2c4e1a7b3d5f60812a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d",
    deleted: false,
    quality: {
      source: "auto",
      sharpness: 412.6,
      glareRatio: 0.004,
      meanLuma: 138.2,
      framing: 0.93,
      videoWidth: 1920,
      videoHeight: 1080,
      elapsedMs: 3420,
      reusedElsewhere: false,
    },
  },
  {
    id: "b2222222-2222-4222-8222-222222222222",
    kind: "document_back",
    byteSize: 198_004,
    width: 1600,
    height: 1009,
    createdAt: minutes(-5),
    sha256: "1b3d5f7a9c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d",
    deleted: false,
    quality: {
      source: "manual",
      sharpness: 168.9,
      glareRatio: 0.031,
      meanLuma: 171.4,
      framing: 0.81,
      videoWidth: 1920,
      videoHeight: 1080,
      elapsedMs: 9180,
      reusedElsewhere: true,
    },
  },
];

// A drawn specimen card standing in for a signed image link: no real document, no personal data.
const SPECIMEN_URL = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1009" viewBox="0 0 1600 1009">
    <rect width="1600" height="1009" rx="48" fill="#dfe7f5"/>
    <rect x="80" y="200" width="420" height="540" rx="24" fill="#b8c6e0"/>
    <g fill="#8a9cc0"><rect x="580" y="230" width="760" height="44" rx="10"/><rect x="580" y="330" width="600" height="44" rx="10"/>
    <rect x="580" y="430" width="680" height="44" rx="10"/><rect x="580" y="530" width="420" height="44" rx="10"/></g>
    <text x="800" y="900" font-family="sans-serif" font-size="96" font-weight="700" fill="#081a51" text-anchor="middle">SPECIMEN</text>
  </svg>`,
)}`;

const testSession = (): TestSessionResponse => ({
  verificationId: CASE_ID,
  riderUrl: "https://verify.example.org/#s=PREVIEW-not-a-real-token-0123456789abcdefghij",
  expiresAt: minutes(29.5),
});

function fakeServices(): DashboardServices {
  const view = (): CaptureViewResponse => ({ url: SPECIMEN_URL, expiresIn: 60 });
  return {
    recentVerifications: async () => VERIFICATIONS,
    verification: async (id) => VERIFICATIONS.find((v) => v.id === id) ?? null,
    captures: async () => CAPTURES,
    createTestSession: async () => testSession(),
    viewCapture: async () => view(),
  };
}

const SCREENS = [
  "signin",
  "signin-error",
  "enroll",
  "enroll-filled",
  "enroll-error",
  "loading",
  "not-configured",
  "no-access",
  "home",
  "home-reviewer",
  "home-admin",
  "case",
  "case-admin",
] as const;

export function Preview({ screen }: { screen: string }) {
  const services = useMemo(fakeServices, []);
  const openPhotos = useMemo<Record<string, OpenPhoto>>(
    () => ({ [CAPTURES[0].id]: { url: SPECIMEN_URL, deadlineMs: Date.now() + 42_000 } }),
    [],
  );
  const staff = (profile: StaffProfile, page?: ReactNode, withSession = false) => (
    <ServicesContext.Provider value={services}>
      <StaffPages profile={profile} onSignOut={noop} initialTestSession={withSession ? testSession() : null}>
        {page}
      </StaffPages>
    </ServicesContext.Provider>
  );

  switch (screen) {
    case "signin":
      return <SignInScreen onSignIn={never} onSetUp={noop} />;
    case "signin-error":
      return (
        <SignInScreen
          initialEmail="staff@example.org"
          initialError="signIn.errors.invalidCredentials"
          onSignIn={never}
          onSetUp={noop}
        />
      );
    case "enroll":
      return <EnrollScreen onEnroll={never} onBack={noop} />;
    case "enroll-filled":
      return (
        <EnrollScreen
          initial={{ email: "jean.dupont@example.org", code: "ABCD-2345-EFGH", password: "correct horse battery", confirmation: "correct horse" }}
          onEnroll={never}
          onBack={noop}
        />
      );
    case "enroll-error":
      return (
        <EnrollScreen
          initial={{ email: "jean.dupont@example.org", code: "ABCD-2345-EFGH", password: "correct horse battery", confirmation: "correct horse battery" }}
          initialError="errors.invalid_invite"
          onEnroll={never}
          onBack={noop}
        />
      );
    case "loading":
      return <LoadingScreen />;
    case "not-configured":
      return <NotConfiguredScreen />;
    case "no-access":
      return <NoAccessScreen email="new.staff@example.org" onSignOut={noop} />;
    case "home":
      return staff(PROFILES.supervisor, undefined, true);
    case "home-reviewer":
      return staff(PROFILES.reviewer);
    case "home-admin":
      return staff(PROFILES.admin);
    case "case":
      return staff(PROFILES.supervisor, <CaseView id={CASE_ID} profile={PROFILES.supervisor} initialPhotos={openPhotos} />);
    case "case-admin":
      return staff(PROFILES.admin, <CaseView id={CASE_ID} profile={PROFILES.admin} />);
    default:
      return (
        <main className="page">
          <h1>Screen preview</h1>
          <ul>
            {SCREENS.map((name) => (
              <li key={name}>
                <a href={`/?screen=${name}`}>{name}</a>
              </li>
            ))}
          </ul>
        </main>
      );
  }
}
