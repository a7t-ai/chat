import { Hono } from "hono";
import { byokModelsFor } from "../byok/models.ts";
import { allowedModels, DEFAULT_MODEL } from "../chat/service.ts";
import { requireFeature } from "../entitlements/index.ts";
import { backend } from "../jano/client.ts";
import type { ModelInfo } from "../jano/types.ts";
import { mergeCatalog } from "./merge.ts";
import type { MergedModel } from "./types.ts";

// The model capability catalog endpoint (#63). Mounted at /api/models, so this is GET
// /api/models/catalog — the ENRICHED view (static metadata joined onto Jano's live list). It sits
// alongside the existing GET /api/models (the minimal id+label+default the current picker uses),
// which stays for back-compat; the richer picker (#17) migrates to this one.
const models = new Hono();

// Returns the merged catalog, SCOPED to the models THIS caller may use. The scoping is the same
// security boundary the chat path enforces (`allowedModels`): a non-admin only ever sees their
// snapshotted allowlist, never Jano's unbounded live list. Jano being down degrades to an empty
// list (the `.catch`), never a 500. Gated on `chat.send` to mirror the existing /api/models route.
models.get("/catalog", requireFeature("chat.send"), async (c) => {
  const auth = c.get("auth");
  // The caller's own BYOK models (#185) join Jano's local list: each configured provider's models,
  // prefixed `provider/` and marked byokOnly, so a stored key is actually pickable. `byokModelsFor`
  // already swallows per-provider failures; the extra `.catch` is a backstop so an unexpected throw
  // can NEVER 500 the catalog — the local models must always render.
  const [live, allowed, byok] = await Promise.all([
    backend.listModels().catch(() => [] as ModelInfo[]),
    allowedModels(auth),
    byokModelsFor(auth).catch(() => [] as MergedModel[]),
  ]);
  const allow = new Set(allowed);
  const merged = mergeCatalog(live).filter((m) => allow.has(m.id));
  return c.json({ models: [...merged, ...byok], default: DEFAULT_MODEL });
});

export default models;
