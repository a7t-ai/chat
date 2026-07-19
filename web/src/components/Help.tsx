import { Footer } from "./Footer";

// Simple, public help / contact page (linked from the footer + About dialog). Mostly static:
// how to reach support and report a bug. Uses the shared doc-page shell
// (.doc-page > .doc + <Footer/>) so the public docs stay visually consistent.
// Sections that aren't wired yet (feature voting, community) are named but link nothing — no
// dead links until each ships. support@a7t.chat is the live inbox.
export function Help() {
  return (
    <main className="doc-page">
      <article className="doc">
        <h1>Help &amp; Contact</h1>
        <p>
          Need a hand with a7t.chat? Everything below is one email away — we read every message.
        </p>

        <h2>Contact</h2>
        <p>
          Email <a href="mailto:support@a7t.chat">support@a7t.chat</a> for anything: access
          requests, account questions, or general feedback.
        </p>

        <h2>Report a bug</h2>
        <p>
          Found something broken? Email{" "}
          <a href="mailto:support@a7t.chat?subject=Bug%20report">support@a7t.chat</a> with what you
          did, what you expected, and what happened instead. Screenshots help.
        </p>

        <h2>Feature voting</h2>
        <p>
          A public board to suggest and vote on features is on the way. Until then, send ideas to
          support and we&apos;ll fold them in.
        </p>

        <h2>Community</h2>
        <p>
          A place to swap tips with other users is coming soon. For now, support is the fastest way
          to reach us.
        </p>

        <p>
          <a className="btn primary doc-back" href="/">← Back to a7t.chat</a>
        </p>
      </article>
      <Footer />
    </main>
  );
}
