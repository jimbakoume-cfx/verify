import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkServer, type ServerState as Status } from "./supabase";

const CLASS: Record<Status, string> = {
  checking: "",
  ok: "ok",
  "not-configured": "warn",
  unreachable: "error",
};

export function ServerStatus() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>("checking");
  useEffect(() => {
    void checkServer().then(setStatus);
  }, []);
  return (
    <div className={`status ${CLASS[status]}`} role="status">
      <span className="dot" aria-hidden="true" />
      <span>{t(`server.${status}`)}</span>
    </div>
  );
}
