// The friendly wall shown to anyone without a valid credential.
// Visual design is deliberately minimal here; the full a7t design system lands with
// the frontend iteration. Copy is locked.
export function wallPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>a7t.chat</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
    background:#0b0b0c; color:#e8e8e6;
    font-family: ui-sans-serif, system-ui, -apple-system, "Switzer", sans-serif; }
  .card { text-align:center; padding:2rem; max-width:32rem; }
  h1 { font-family:"Switzer", ui-sans-serif, system-ui, -apple-system, sans-serif; font-weight:600;
    font-size:2.75rem; margin:0 0 .75rem; letter-spacing:.01em; }
  p { color:#a1a1aa; line-height:1.6; margin:0; font-size:1.05rem; }
  a { color:#e8e8e6; text-underline-offset:3px; }
</style></head>
<body><main class="card">
  <h1>a7t.chat</h1>
  <p>The chat is currently being tested.<br />Ask Leo for a credential at <a href="mailto:leo@a7t.ai">leo@a7t.ai</a> :)</p>
</main></body></html>`;
}
