import { useTranslation } from "react-i18next";
import { Brand, LanguageToggle, ServerStatus } from "@verify/shared";
import type { StaffProfile } from "../lib/records";
import { canEditThresholds } from "../lib/roles";
import { thresholdsPath } from "../lib/routes";
import { Link } from "./Link";

export function TopBar({ profile, onSignOut }: { profile?: StaffProfile; onSignOut?: () => void }) {
  const { t } = useTranslation();
  return (
    <header className="topbar dash-topbar">
      <Link href="/" className="dash-home-link" aria-label={t("nav.home")}>
        <Brand product="Verify Ops" />
      </Link>
      <div className="dash-topbar-actions">
        {profile && (
          <span className="dash-user">
            <span className="dash-user-name">{profile.fullName}</span>
            <span className="badge">{t(`roles.${profile.role}`)}</span>
          </span>
        )}
        {profile && canEditThresholds(profile.role) && (
          <Link href={thresholdsPath} className="dash-nav-link">
            {t("nav.thresholds")}
          </Link>
        )}
        <LanguageToggle />
        {onSignOut && (
          <button type="button" className="small" onClick={onSignOut}>
            {t("nav.signOut")}
          </button>
        )}
      </div>
    </header>
  );
}

export function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="footer dash-footer">
      <ServerStatus />
      <div>{t("build", { id: __BUILD_ID__ })}</div>
    </footer>
  );
}
