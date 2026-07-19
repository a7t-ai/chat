import { useEffect, useState } from "react";
import { fetchPasskeyAvailable, loginWithPasskey, passkeySupported, signUpWithPasskey } from "../lib/webauthn";
import { useT } from "../lib/i18n";
import { Button, InlineMessage } from "./ui";
import { DotGrid } from "./DotGrid";
import { Footer } from "./Footer";

// Passkey-only account auth (#169). Email OTP + invites were removed: a visitor either SIGNS UP
// (registers a passkey, the server CREATES their account + session, no email, no invite) or SIGNS IN
// with an existing passkey. Both ceremonies live in lib/webauthn.ts; every check is server-side. When
// the availability probe comes back not-available we show a plain, CTA-free WALL. That is exactly the
// public-edge case (GET /api/auth/passkey/available 401s over the edge because this instance is
// private), and it also covers passkeys dark (WEBAUTHN_RP_ID unset) or a browser that can't do
// WebAuthn. Styled like the old wall (DotGrid + card + lockup).

export function LoginView({ onAuthed }: { onAuthed: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null = still probing; true/false = the browser supports WebAuthn AND the server has it configured.
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!passkeySupported()) {
      setAvailable(false);
      return;
    }
    let alive = true;
    void fetchPasskeyAvailable().then((ok) => {
      if (alive) setAvailable(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function signIn() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const r = await loginWithPasskey();
      if (r.ok) {
        if (r.status === "authed") onAuthed();
        else setError(t("login.inactive")); // a revoked/never-granted account: owner-only recovery
      } else if (r.reason === "cancelled") {
        // User dismissed the OS prompt — stay quiet.
      } else {
        setError(t("login.passkeyError"));
      }
    } catch {
      setError(t("login.passkeyError"));
    } finally {
      setBusy(false);
    }
  }

  async function signUp() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const r = await signUpWithPasskey();
      if (r.ok) {
        onAuthed(); // account created + session minted → into the app
      } else if (r.reason === "cancelled") {
        // User dismissed the OS prompt — stay quiet.
      } else {
        setError(t("login.passkeyError"));
      }
    } catch {
      setError(t("login.passkeyError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center wall">
      <DotGrid />
      <div className="card wall-card">
        <img src="/lockup-stacked-dark.png" alt="a7t.chat" className="lockup lockup-stacked lockup-dark" />
        <img src="/lockup-stacked-light.png" alt="a7t.chat" className="lockup lockup-stacked lockup-light" />

        {available === false ? (
          // The wall: passkeys aren't reachable. This is exactly what a public-edge visitor sees,
          // because GET /api/auth/passkey/available 401s over the edge (private instance) and the probe
          // treats a non-ok response as "unavailable". Just the lockup + footer here: no text, no CTA,
          // nothing clickable to authenticate.
          null
        ) : (
          <>
            <h2>{t("login.passkeyTitle")}</h2>
            <p className="muted small">{t("login.passkeyIntro")}</p>
            <div className="token-form">
              <Button type="button" disabled={busy || available === null} onClick={signUp}>
                {t("login.passkeySignUp")}
              </Button>
              <Button variant="ghost" type="button" disabled={busy || available === null} onClick={signIn}>
                {t("login.passkeySignIn")}
              </Button>
            </div>
          </>
        )}

        {error && (
          <InlineMessage variant="danger" role="alert" className="login-err ui-anim-slide-down">
            {error}
          </InlineMessage>
        )}
      </div>
      <Footer />
    </main>
  );
}
