import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

/**
 * "Wakeel" text wordmark (the accepted reference uses the product name as text). Replace with the
 * approved logo asset when supplied; keep the accessible name.
 */
export function Wordmark({ href = "/", app = false }: { href?: string; app?: boolean }) {
  return (
    <Link href={href} className="wordmark" aria-label="Wakeel - WakeelBoost Work Desk home">
      <span className="wordmark-text">Wakeel</span>
      {app && <span className="wordmark-app">WakeelBoost Work Desk</span>}
    </Link>
  );
}

/**
 * Official The Alternative Bank logo (approved asset, public/brand). Two renditions: light lettering
 * for dark surfaces and dark lettering for light surfaces; CSS shows the one that matches the theme.
 * The logo is never redrawn or recoloured.
 */
export function BankLogo({ height = 28, className = "" }: { height?: number; className?: string }) {
  const width = Math.round((height * 451) / 214);
  return (
    <span className={`bank-logo ${className}`} role="img" aria-label="The Alternative Bank">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="bank-logo-on-dark" src="/brand/altbank-logo-on-dark.png" width={width} height={height} alt="" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="bank-logo-on-light" src="/brand/altbank-logo-on-light.png" width={width} height={height} alt="" />
    </span>
  );
}

/** "WakeelBoost · a platform of The Alternative Bank" endorsement line. */
export function BankEndorsement({ height = 24 }: { height?: number }) {
  return (
    <span className="bank-endorse">
      <span className="bank-endorse-text">A platform of</span>
      <BankLogo height={height} />
    </span>
  );
}

export const FOOTER_TEXT = "Powered by DKTA Technologies @2026";

export function Footer({ className = "footer" }: { className?: string }) {
  return (
    <footer className={className}>
      <span>WakeelBoost Work Desk · The Alternative Bank · Internal use only</span>
      <span>{FOOTER_TEXT}</span>
    </footer>
  );
}

/**
 * Authentication scene from the landing reference: full-bleed merchant photograph (official Wakeel
 * page image, stored locally) blended into graphite (dark) or warm off-white (light), with the
 * content in the foreground on the left. Used for sign-in, OTP, session-expired and error screens.
 */
export function AuthScene({ children, theme }: { children: React.ReactNode; theme: "light" | "dark" }) {
  return (
    <section className="auth" aria-label="WakeelBoost Work Desk staff sign-in">
      <figure className="auth-photo" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/wakeel-merchant-1080.jpg"
          srcSet="/images/wakeel-merchant-640.jpg 640w, /images/wakeel-merchant-1080.jpg 1080w"
          sizes="(max-width: 670px) 100vw, 76vw"
          alt=""
          fetchPriority="high"
        />
      </figure>
      <header className="auth-header">
        <div className="auth-brand">
          <Wordmark href="/sign-in" />
          <BankEndorsement height={34} />
        </div>
        <ThemeToggle initial={theme} variant="pill" />
      </header>
      <main className="auth-main" id="main">
        {children}
      </main>
      <footer className="auth-footer">{FOOTER_TEXT}</footer>
    </section>
  );
}

/** Backwards-compatible frame used by error and access pages. */
export function AuthFrame({ children, theme = "dark" }: { children: React.ReactNode; theme?: "light" | "dark"; right?: React.ReactNode }) {
  return (
    <AuthScene theme={theme}>
      <div className="auth-card">{children}</div>
    </AuthScene>
  );
}

export function PlainFrame({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="plain-frame">
      <header>
        <Wordmark href="/sign-in" app />
        {right}
      </header>
      <main id="main">{children}</main>
      <Footer />
    </div>
  );
}
