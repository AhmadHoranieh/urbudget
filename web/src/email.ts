import type { Env } from "./env";
import { ApiError, countEvent, recordProblem } from "./util";

export interface Email {
  /** What kind of email it is, for the admin page when sending fails (subjects can hold a code). */
  kind: "sign-in code";
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends through Resend. Without an API key (local development) the email is only logged. */
export async function sendEmail(env: Env, email: Email): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email] to ${email.to}: ${email.subject}\n${email.text}`);
    return;
  }
  let failure = "";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [email.to],
        reply_to: env.SUPPORT_EMAIL,
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });
    if (!response.ok) failure = `Resend answered ${response.status}: ${await response.text()}`;
  } catch (error) {
    failure = `Resend couldn't be reached: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (failure) {
    console.error(`[email] ${failure}`);
    await recordProblem(env.DB, "email", email.to, `${email.kind}: ${failure}`);
    throw new ApiError(502, "email_failed", "We couldn't send the email. Try again in a minute.");
  }
  // Counted against Resend's sending limits on the admin page.
  await countEvent(env.DB, "email", email.kind);
}
