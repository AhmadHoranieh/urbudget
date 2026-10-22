import { cloud } from "./cloud";
import { errorText } from "./format";
import { useToast } from "./ui";
import { t } from "./i18n";

export function PrivacySettings() {
  const toast = useToast();
  return <section className="panel">
    <h2>{t("Privacy & data")}</h2>
    <p>{t("Learn what stays on your device and what optional sync, bank connections, purchases and the assistant share. To delete your account and cloud budgets, open Account & sync and choose Delete account.")}</p>
    <button className="secondary" onClick={() => void cloud.open("/privacy/")
      .catch(e => toast({ message: errorText(e), tone: "error" }))}>{t("Privacy policy")}</button>
  </section>;
}
