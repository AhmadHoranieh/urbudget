import { cloud } from "./cloud";
import { errorText } from "./format";
import { useToast } from "./ui";

export function PrivacySettings() {
  const toast = useToast();
  return <section className="panel">
    <h2>Privacy & data</h2>
    <p>Learn what stays on your device and what optional sync, bank connections, purchases and the assistant share. To delete your account and cloud budgets, open Account & sync and choose Delete account.</p>
    <button className="secondary" onClick={() => void cloud.open("/privacy/")
      .catch(e => toast({ message: errorText(e), tone: "error" }))}>Privacy policy</button>
  </section>;
}
