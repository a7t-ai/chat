/// <reference types="vite/client" />

// Build-time env exposed to the client (Vite inlines VITE_-prefixed vars). Add typed
// `readonly VITE_*` fields to this interface as they're introduced so `import.meta.env.VITE_*`
// reads are checked rather than `any`. None are used today — this augments Vite's own
// `ImportMetaEnv` base (MODE/DEV/PROD/…) declared via the reference above.
// biome-ignore lint/suspicious/noEmptyInterface: extension point for future VITE_ vars
interface ImportMetaEnv {}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
