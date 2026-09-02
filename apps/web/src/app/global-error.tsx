"use client";

/**
 * Last-resort error boundary (issue #33): catches errors thrown in the
 * ROOT layout and its chrome (auth(), getTranslations, Sidebar/Topbar)
 * and on the (auth) pages — error.tsx does not wrap the layout of its
 * own segment, so those used to hit the raw framework 500.
 *
 * Replaces the root layout entirely, so it ships its own <html>/<body>
 * and stays intentionally dependency-free: no i18n provider exists at
 * this point (bilingual text is hardcoded per the docs' guidance to
 * keep global-error minimal), styling is inline (globals.css/fonts come
 * from the root layout, which just failed).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="de">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#0b1020",
          color: "#e5e7eb",
        }}
      >
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 40, margin: 0 }} aria-hidden>
            ⚠️
          </p>
          <h1 style={{ fontSize: 18, margin: "12px 0 4px" }}>
            Etwas ist schiefgelaufen / Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", margin: "0 0 16px" }}>
            Das Intranet hat einen unerwarteten Fehler. Bitte erneut versuchen —
            wenn es bleibt, sag der IT Bescheid.
            <br />
            The intranet hit an unexpected error. Please retry — if it persists,
            tell IT.
            {error.digest ? (
              <>
                <br />
                <span style={{ fontSize: 12 }}>Ref: {error.digest}</span>
              </>
            ) : null}
          </p>
          <button
            onClick={() => reset()}
            style={{
              padding: "10px 18px",
              borderRadius: 12,
              border: "none",
              background: "#4f46e5",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Erneut versuchen / Try again
          </button>
        </main>
      </body>
    </html>
  );
}
