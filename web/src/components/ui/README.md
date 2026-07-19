# Design system (`ui/`)

The shared component library for a7t.chat, organised by **Atomic Design**
([bradfrost.com/chapter-2](https://atomicdesign.bradfrost.com/chapter-2/)). Build screens by
composing these primitives instead of re-styling raw elements, so the app has one consistent
vocabulary.

**Live gallery:** [`/design-system`](/design-system) — every primitive rendered from the real
component. Add a specimen there when you add a primitive.

## Layers

```
ui/
  atoms/       # indivisible building blocks — one element, one job
  molecules/   # a few atoms working as a unit
  organisms/   # larger composed sections (added as we migrate)
  index.ts     # the public barrel — import from here, not from atoms/ or molecules/
```

| Layer | What it is | Here today |
|---|---|---|
| **Atoms** | The smallest units | `Button`, `IconButton`, `Input` / `TextArea`, `Kbd`, `Badge`, `SectionHeading`, `ThinkingMark` |
| **Molecules** | Small groups of atoms | `Field`, `SegmentedControl`, `Toggle`, `Slider`, `KeyCombo`, `KeyCaptureField`, `InlineMessage`, `PanelActions` |
| **Organisms** | Composed sections | `Modal`, `Menu` (`MenuItem` / `MenuSeparator`), `ChatBubble` |

The **Chat** primitives (`ChatBubble`, `ThinkingMark`, and message actions built from `IconButton`)
are the conversation-thread building blocks — they get their own section in the gallery.

## Conventions

- **Import from the barrel:** `import { Button, InlineMessage } from "../ui"`. Never deep-import
  `../ui/atoms/Button`.
- **Class prefix `.ui-*`** for design-system styles, in `styles/ui.css`. Wrapper atoms (`Button`,
  `Input`) intentionally reuse the app's existing classes (`.btn`, `.input`) so they're drop-in
  replacements for the hand-written call-sites.
- **Semantic colors** come from tokens — `--accent`, `--danger`, `--warning`, `--success`,
  `--info` (`styles/tokens.css`). Never hard-code a status hex; that's how one-off reds creep in.
- **Typed variants, not class strings:** `<Button variant="ghost" size="sm">`, not
  `className="btn ghost small"`.
- **Every primitive has a test** beside it (`*.test.tsx`) — the coverage gate counts every file.
- **CTAs go on the right.** A panel's footer/body action buttons belong on the right-most side of
  its action area — that's the standard, not a per-panel choice. Wrap them in `PanelActions`
  (right-aligned by default; `align="between"` splits a destructive action left / primary right)
  rather than hand-rolling a flex row. Header actions keep using `.panel-head-actions`.

## Adopting it

The system is seeded; call-sites migrate incrementally. When you touch a component, swap its
hand-rolled buttons/inputs/messages for the primitives. New UI should start from `ui/`.
