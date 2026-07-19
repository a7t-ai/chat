import { DotGrid } from "./DotGrid";
import { Footer } from "./Footer";

// Public 404, rendered by App when the URL doesn't match a known route (see isKnownRoute in
// lib/route). Stacks on the shared .center/.wall/.card treatment (the same shell as the login
// wall) so an unknown path lands somewhere themed and on-brand instead of the home app. The
// "Back to chat" CTA is a real link to "/" (styled as a button, mirroring WatchView) — a full
// navigation, so the server serves index.html and the app boots at home.
export function NotFound() {
  return (
    <main className="center wall">
      <DotGrid />
      <div className="card wall-card notfound-card">
        <p className="notfound-code">404</p>
        <h1>Page not found</h1>
        <p className="muted">
          That link doesn't point anywhere on a7t.chat. It may have moved, or the address has a typo.
        </p>
        <div className="notfound-actions">
          <a className="btn primary" href="/">
            Back to chat
          </a>
          <a className="link-btn" href="/help">
            Get help
          </a>
        </div>
      </div>
      <Footer />
    </main>
  );
}
