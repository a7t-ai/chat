import {
  ArrowUp,
  ChevronDown,
  Copy,
  EllipsisVertical,
  Globe,
  Info,
  Keyboard,
  MapPin,
  Mic,
  Paperclip,
  Pencil,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
  X,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import {
  Badge,
  Button,
  ChatBubble,
  CodeBlock,
  Field,
  IconButton,
  InlineMessage,
  Input,
  Kbd,
  KeyCaptureField,
  KeyCombo,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  PanelActions,
  SectionHeading,
  SegmentedControl,
  Select,
  SidebarModal,
  Slider,
  TableBlock,
  TextArea,
  ThinkingMark,
  Toggle,
} from "./ui";
import { buildMinimap } from "../lib/minimap";
import { getThemeId, setTheme } from "../lib/theme";
import { THEMES } from "../lib/themes";
import type { CatalogModel } from "../lib/api";
import { Minimap } from "./Minimap";
import { AccountButton } from "./AccountButton";
import { ModelPicker } from "./ModelPicker";
import { ConvoItem } from "./ConvoItem";
import { Footer } from "./Footer";
import { ProfileCard } from "./ProfileCard";
import { StatCard } from "./StatCard";
import { MapDrawerSkeleton } from "./Skeleton";

const MINIMAP_MESSAGES = [
  { role: "user" as const, content: "How do I debounce a resize handler in React?" },
  { role: "assistant" as const, content: "Wrap it in a ref-stored timer and clear it on cleanup. Here's a small hook you can drop in." },
  { role: "user" as const, content: "Can you show the hook?" },
  { role: "assistant" as const, content: "```ts\nfunction useDebounced(fn, ms) {\n  const t = useRef();\n  // ...\n}\n```" },
  { role: "user" as const, content: "And how would I test it?" },
  { role: "assistant" as const, content: "Fake timers: advance past `ms` and assert the callback ran once. Vitest's `vi.useFakeTimers()` handles it." },
];
const MINIMAP_MODEL = buildMinimap(MINIMAP_MESSAGES);

// Mock catalog for the ModelPicker specimen (#142): a free multimodal local model, a couple of
// paid frontier models (one $$ pro, one $$$ ultra) that are BYOK-only, and a free local one — enough
// that the search box, tier filters, favorite stars, and the $-tier / BYOK badges all render open.
const PICKER_MODELS = ["qwen3-omni", "gpt-5", "claude-opus-4", "llama-local"];
const PICKER_LABELS: Record<string, string> = {
  "qwen3-omni": "Qwen3 Omni",
  "gpt-5": "GPT-5",
  "claude-opus-4": "Claude Opus 4",
  "llama-local": "Llama 3 (local)",
};
const PICKER_CATALOG: Record<string, CatalogModel> = {
  "qwen3-omni": { id: "qwen3-omni", displayName: "Qwen3 Omni", input: ["text", "image"], tier: "free", byokOnly: false, provider: "qwen", recommendedFor: ["general", "vision"] },
  "gpt-5": { id: "gpt-5", displayName: "GPT-5", input: ["text", "image"], tier: "pro", byokOnly: true, provider: "openai", recommendedFor: ["coding", "long-docs"] },
  "claude-opus-4": { id: "claude-opus-4", displayName: "Claude Opus 4", input: ["text", "image"], tier: "ultra", byokOnly: true, provider: "anthropic", recommendedFor: ["reasoning", "long-docs"] },
  "llama-local": { id: "llama-local", displayName: "Llama 3 (local)", input: ["text"], tier: "free", byokOnly: false, provider: "local", recommendedFor: ["chat"] },
};
const PICKER_FAVORITES = ["gpt-5"];

const THEME_GROUPS = ["a7t", "Classic"] as const;

const FONT_OPTIONS = [
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "system", label: "System" },
] as const;

const SETTINGS_SECTIONS = [
  { id: "profile", label: "Profile", icon: User },
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

const SAMPLE_CODE = `const greet = (name: string) => {
  return \`Hello, \${name}!\`;
};`;

// The living style guide (/design-system) — a public gallery of the design-system primitives,
// organised by Atomic Design layer. Every element below is the REAL component, so this page is
// both documentation and a smoke test. Especially handy on staging. See ui/README.md.

const TOKENS = [
  { name: "--accent", label: "Accent" },
  { name: "--send", label: "Send" },
  { name: "--danger", label: "Danger" },
  { name: "--warning", label: "Warning" },
  { name: "--success", label: "Success" },
  { name: "--muted", label: "Muted" },
];

function Specimen({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="ds-specimen">
      <span className="ds-specimen-label">{name}</span>
      <div className="ds-specimen-demo">{children}</div>
    </div>
  );
}

export function DesignSystem() {
  const [recording, setRecording] = useState(false);
  const [font, setFont] = useState<(typeof FONT_OPTIONS)[number]["value"]>("system");
  const [motion, setMotion] = useState(false);
  const [scale, setScale] = useState(0.95);
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState("profile");
  const [themeId, setThemeId] = useState(getThemeId());
  const [replayKey, setReplayKey] = useState(0);
  const [revealOpen, setRevealOpen] = useState(false);
  const [pickerModel, setPickerModel] = useState(PICKER_MODELS[0]); // the ModelPicker specimen's live selection
  const minimapScrollRef = useRef<HTMLElement>(null); // no live thread in the gallery — Minimap renders its static track

  function pickTheme(id: string) {
    setTheme(id);
    setThemeId(id);
  }

  return (
    <div className="ds-page">
      <header className="ds-head">
        <h1>Design System</h1>
        <p className="muted">
          a7t.chat's shared component library, organised by Atomic Design (atoms → molecules →
          organisms). Every element on this page is the live component — import them from{" "}
          <code>components/ui</code>.
        </p>
      </header>

      <section className="ds-section">
        <h2 className="ds-section-title">Tokens</h2>
        <p className="ds-section-note muted small">Semantic colors — theme-aware, one source of truth.</p>
        <div className="ds-swatches">
          {TOKENS.map((tk) => (
            <div key={tk.name} className="ds-swatch">
              <span className="ds-swatch-chip" style={{ background: `var(${tk.name})` }} />
              <span className="ds-swatch-label">
                {tk.label}
                <code>{tk.name}</code>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="ds-section">
        <h2 className="ds-section-title">Themes</h2>
        <p className="ds-section-note muted small">Every theme retints the tokens. Click one to preview it live.</p>
        {THEME_GROUPS.map((group) => (
          <div key={group} className="ds-specimen">
            <span className="ds-specimen-label">{group}</span>
            <div className="ds-specimen-demo" style={{ display: "block", width: "100%" }}>
              <div className="theme-grid">
                {THEMES.filter((th) => th.group === group).map((th) => (
                  <button
                    key={th.id}
                    type="button"
                    className={`theme-card ${themeId === th.id ? "active" : ""}`}
                    aria-pressed={themeId === th.id}
                    onClick={() => pickTheme(th.id)}
                  >
                    <span className="theme-prev" style={{ background: th.colors.bg, borderColor: th.colors.border }}>
                      <span className="theme-bar" style={{ background: th.colors.surface2, width: "85%" }} />
                      <span className="theme-bar" style={{ background: th.colors.accent, width: "45%" }} />
                      <span className="theme-bar" style={{ background: th.colors.muted, width: "65%" }} />
                    </span>
                    <span className="theme-name">{th.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="ds-section">
        <h2 className="ds-section-title">Atoms</h2>
        <Specimen name="Button">
          <Button variant="primary">Primary</Button>
          <Button>Default</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button size="sm">Small</Button>
          <Button disabled>Disabled</Button>
        </Specimen>
        <Specimen name="IconButton">
          <IconButton label="Search">
            <Search size={18} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Star">
            <Star size={18} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Delete">
            <Trash2 size={18} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Close" size="sm">
            <X size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Disabled" disabled>
            <Search size={18} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Active" active>
            <Star size={18} strokeWidth={1.75} />
          </IconButton>
        </Specimen>
        <Specimen name="Badge">
          <Badge variant="neutral">Neutral</Badge>
          <Badge variant="accent">Accent</Badge>
          <Badge variant="warning">staging</Badge>
          <Badge variant="success">Pro</Badge>
          <Badge variant="danger">Beta</Badge>
        </Specimen>
        <Specimen name="Kbd">
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>K</Kbd>
          <Kbd>Esc</Kbd>
          <Kbd>↵</Kbd>
        </Specimen>
        <Specimen name="Input / TextArea">
          <Input placeholder="Text input" defaultValue="" />
          <Input placeholder="Disabled" disabled />
          <TextArea placeholder="Multi-line, fixed height" rows={2} />
        </Specimen>
        <Specimen name="Select">
          <Select aria-label="Role" defaultValue="edit">
            <option value="view">Can view</option>
            <option value="suggest">Can suggest</option>
            <option value="edit">Can edit</option>
          </Select>
          <Select aria-label="Disabled" defaultValue="a" disabled>
            <option value="a">Disabled</option>
          </Select>
        </Specimen>
        <div className="ds-specimen">
          <span className="ds-specimen-label">SectionHeading</span>
          <div className="ds-specimen-demo ds-specimen-demo-col">
            <SectionHeading>Appearance</SectionHeading>
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2 className="ds-section-title">Molecules</h2>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Field</span>
          <div className="ds-specimen-demo ds-specimen-demo-col">
            <Field label="Display name" htmlFor="ds-name" hint="Shown to collaborators.">
              <Input id="ds-name" placeholder="Leo" />
            </Field>
            <Field label="Shortcut" error="That shortcut is taken">
              <Input placeholder="⌘⇧J" />
            </Field>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">SegmentedControl</span>
          <div className="ds-specimen-demo">
            <SegmentedControl value={font} options={FONT_OPTIONS} onChange={setFont} ariaLabel="Text font" />
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Toggle</span>
          <div className="ds-specimen-demo ds-specimen-demo-col" style={{ width: "min(22rem, 100%)" }}>
            <Toggle label="Reduce motion" checked={motion} onChange={setMotion} />
            <Toggle label="Press Enter to send" hint="Off: Enter adds a line, ⌘/Ctrl+Enter sends." checked={!motion} onChange={(v) => setMotion(!v)} />
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Slider</span>
          <div className="ds-specimen-demo" style={{ width: "min(22rem, 100%)" }}>
            <Slider
              label="Text size"
              value={scale}
              min={0.8}
              max={1.2}
              step={0.05}
              onChange={setScale}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </div>
        </div>
        <Specimen name="KeyCombo">
          <KeyCombo keys={["⌘", "⇧", "K"]} />
          <KeyCombo keys={["⌘", "."]} />
          <KeyCombo keys={["Esc"]} />
        </Specimen>
        <Specimen name="KeyCaptureField">
          <KeyCaptureField
            keys={["⌘", "."]}
            recording={recording}
            placeholder="Press keys…"
            ariaLabel="Demo shortcut capture"
            onStart={() => setRecording((r) => !r)}
          />
          <span className="muted small">click to toggle recording (sizes to its keys, right-anchored)</span>
        </Specimen>
        <div className="ds-specimen">
          <span className="ds-specimen-label">InlineMessage</span>
          <div className="ds-specimen-demo ds-specimen-demo-col">
            <InlineMessage variant="danger">Already used by “New chat”</InlineMessage>
            <InlineMessage variant="warning">This overwrites your current draft</InlineMessage>
            <InlineMessage variant="success">Saved</InlineMessage>
            <InlineMessage variant="info">Runs on your own key</InlineMessage>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">PanelActions</span>
          <div className="ds-specimen-demo ds-specimen-demo-col" style={{ width: "min(26rem, 100%)" }}>
            {/* Default: CTAs right-aligned — the design-system standard for a panel's action row. */}
            <PanelActions>
              <Button variant="ghost" size="sm">Cancel</Button>
              <Button variant="primary" size="sm">Save</Button>
            </PanelActions>
            {/* space-between: a destructive action anchors left, the primary on the right. */}
            <PanelActions align="between">
              <Button variant="danger" size="sm">Delete</Button>
              <Button variant="primary" size="sm">Add passkey</Button>
            </PanelActions>
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2 className="ds-section-title">Organisms</h2>
        <Specimen name="Modal">
          <Button onClick={() => setModalOpen(true)}>Open dialog</Button>
          {modalOpen && (
            <Modal
              title="Dialog title"
              onClose={() => setModalOpen(false)}
              headerActions={<Button variant="ghost" size="sm">Reset</Button>}
            >
              <p className="muted">
                The shared dialog shell — backdrop, centered panel, header with a title and actions.
                Click the backdrop, press Esc, or hit Close.
              </p>
            </Modal>
          )}
        </Specimen>
        <Specimen name="Menu">
          <Menu triggerLabel="Options" trigger={<EllipsisVertical size={18} strokeWidth={1.75} />}>
            <MenuItem icon={Star}>Star</MenuItem>
            <MenuItem icon={Pencil}>Rename</MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} variant="danger">Delete</MenuItem>
          </Menu>
          <span className="muted small">click to open</span>
        </Specimen>
        <div className="ds-specimen">
          <span className="ds-specimen-label">MenuItem states</span>
          <div className="ds-specimen-demo">
            <div className="ds-menu-preview" role="menu">
              <MenuItem icon={Star}>Default</MenuItem>
              <MenuItem icon={Pencil} active>
                Active
              </MenuItem>
              <MenuItem icon={Copy} disabled>
                Disabled
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={Trash2} variant="danger">
                Danger
              </MenuItem>
            </div>
          </div>
        </div>
        <Specimen name="SidebarModal">
          <Button onClick={() => setSettingsOpen(true)}>Open settings</Button>
          <span className="muted small">one modal, many sections — so the account menu stops growing linearly</span>
          {settingsOpen && (
            <SidebarModal
              title="Settings"
              items={SETTINGS_SECTIONS}
              activeId={section}
              onSelect={setSection}
              onClose={() => setSettingsOpen(false)}
            >
              <SectionHeading>{SETTINGS_SECTIONS.find((s) => s.id === section)?.label}</SectionHeading>
              <p className="muted">The “{section}” section renders here. Each menu item becomes a section instead of its own dialog.</p>
            </SidebarModal>
          )}
        </Specimen>
        <div className="ds-specimen">
          <span className="ds-specimen-label">ProfileCard</span>
          <div className="ds-specimen-demo ds-specimen-demo-col" style={{ width: "100%", alignItems: "stretch" }}>
            <ProfileCard name="Leo Cardoso" email="leo@a7t.chat" plan="owner" planLabel="Owner" />
            <ProfileCard name="Alex Rivera" email="alex@example.com" plan="pro" planLabel="Pro" />
            <ProfileCard name="Sam" plan="free" planLabel="Free" />
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">StatCard</span>
          <div className="ds-specimen-demo" style={{ width: "100%" }}>
            <div className="stat-cards" style={{ width: "100%" }}>
              <StatCard label="Users" value={128} />
              <StatCard label="Conversations" value={512} />
              <StatCard label="Tokens in / out" value="7,279 / 80,893" />
              <StatCard label="Active keys" value={0} />
            </div>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">AccountButton</span>
          <div className="ds-specimen-demo" style={{ width: "100%" }}>
            <div style={{ maxWidth: "15rem", width: "100%" }}>
              <AccountButton name="Leo Cardoso" role="Admin" label="Account menu" onClick={() => undefined} />
            </div>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">ConvoItem (sidebar)</span>
          <div className="ds-specimen-demo" style={{ width: "100%" }}>
            <div style={{ maxWidth: "16rem", width: "100%" }}>
              <ul className="convo-list">
                <ConvoItem
                  convo={{ id: "c1", title: "Lisbon, 4-day plan", model: "qwen", starred: true, updatedAt: 0 }}
                  active
                  onOpen={() => undefined}
                  onRename={() => undefined}
                  onGenerateTitle={() => undefined}
                  onToggleStar={() => undefined}
                  onDelete={() => undefined}
                />
                <ConvoItem
                  convo={{ id: "c2", title: "Debounce a resize handler", model: null, starred: false, updatedAt: 0 }}
                  active={false}
                  onOpen={() => undefined}
                  onRename={() => undefined}
                  onGenerateTitle={() => undefined}
                  onToggleStar={() => undefined}
                  onDelete={() => undefined}
                />
              </ul>
            </div>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Footer</span>
          <div className="ds-specimen-demo" style={{ display: "block", width: "100%" }}>
            <span className="muted small">Shared across the login wall, the 404 page, and the Help doc.</span>
            <div style={{ position: "relative", marginTop: "0.75rem" }}>
              <Footer />
            </div>
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2 className="ds-section-title">Chat</h2>
        <p className="ds-section-note muted small">The pieces that make up a conversation thread.</p>
        <div className="ds-specimen">
          <span className="ds-specimen-label">ChatBubble</span>
          <div className="ds-specimen-demo ds-specimen-demo-col" style={{ width: "100%" }}>
            <ChatBubble role="user">What's the weather in Lisbon this weekend?</ChatBubble>
            <ChatBubble role="assistant">
              Lisbon looks sunny and mild — highs around 24°C Saturday and Sunday, light breeze off the
              Tagus. A great weekend to be outside.
            </ChatBubble>
          </div>
        </div>
        <Specimen name="MessageActions">
          <IconButton label="Copy" size="sm">
            <Copy size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Good response" size="sm">
            <ThumbsUp size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Bad response" size="sm">
            <ThumbsDown size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Regenerate" size="sm">
            <RotateCcw size={16} strokeWidth={1.75} />
          </IconButton>
        </Specimen>
        <Specimen name="ThinkingMark">
          <ThinkingMark />
          <span className="muted small">shown while the assistant is generating</span>
        </Specimen>
        <div className="ds-specimen">
          <span className="ds-specimen-label">CodeBlock</span>
          <div className="ds-specimen-demo" style={{ display: "block", width: "100%" }}>
            <CodeBlock language="ts" code={SAMPLE_CODE} />
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">TableBlock</span>
          <div className="ds-specimen-demo" style={{ display: "block", width: "100%" }}>
            <TableBlock>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Context</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>qwen-chat</td>
                  <td>32K</td>
                  <td>Free</td>
                </tr>
                <tr>
                  <td>qwen-code</td>
                  <td>32K</td>
                  <td>Free</td>
                </tr>
                <tr>
                  <td>qwen-omni</td>
                  <td>32K</td>
                  <td>Free</td>
                </tr>
              </tbody>
            </TableBlock>
          </div>
        </div>
        <Specimen name="Location">
          <button type="button" className="cap-chip map-chip">
            <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>Lisbon</span>
          </button>
          <span className="muted small">inline [[map:…]] chip — opens the map surface on click</span>
        </Specimen>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Minimap</span>
          <div
            className="ds-specimen-demo"
            style={{ display: "block", position: "relative", height: "16rem", width: "100%", "--minimap-right": "0.6rem" } as CSSProperties}
          >
            <Minimap model={MINIMAP_MODEL} scrollRef={minimapScrollRef} messageCount={MINIMAP_MESSAGES.length} open />
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Capability pane</span>
          <div className="ds-specimen-demo" style={{ display: "block", width: "100%" }}>
            {/* The real .cap-drawer chrome (border, resizer), positioned inline for the gallery. In the
                app it's a fixed, drag-resizable right-side drawer that hosts a capability's Surface. */}
            <aside className="cap-drawer ds-cap-drawer-demo" aria-label="Map">
              <div className="cap-drawer-resizer" role="separator" aria-label="Resize panel" />
              {/* The REAL drawer header — .cap-drawer-head / .cap-drawer-title (icon + label) +
                  .cap-drawer-close — the exact chrome MapCanvas renders, so the gallery matches the app. */}
              <header className="cap-drawer-head">
                <span className="cap-drawer-title">
                  <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
                  Map
                </span>
                <button type="button" className="cap-drawer-close" aria-label="Close">
                  <X size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </header>
              <div className="ds-cap-drawer-body muted small">
                The active capability’s Surface renders here — pinned to the right of the thread, drag-resizable from
                the left edge, sliding in once. Maps is the example; new capabilities plug their own Surface into the
                same shell.
              </div>
            </aside>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Map</span>
          <div className="ds-specimen-demo" style={{ display: "block", width: "100%" }}>
            <aside className="cap-drawer ds-cap-drawer-demo" aria-label="Map">
              <MapDrawerSkeleton />
            </aside>
            <span className="muted small" style={{ display: "block", marginTop: "0.5rem" }}>
              The Maps capability Surface — a MapLibre canvas with geocoded pins. Shown as its loading state; the live
              map pulls tiles + geocoding when opened in a thread.
            </span>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Composer (prompt field)</span>
          <div className="ds-specimen-demo" style={{ display: "block", width: "100%" }}>
            {/* The prompt-field compound, rendered with the real composer classes (static — the live
                one lives in ChatView with the model picker / search / voice / send wired up). */}
            <div className="composer">
              {/* Sample in-prompt attachments gallery (#128): an image thumbnail chip + a doc chip,
                  each with a remove control — the strip that sits above the textarea once files are
                  attached from the paperclip button or a drag-and-drop. */}
              <ul className="composer-attachments">
                <li className="composer-attachment">
                  <span className="composer-attachment-thumb" aria-hidden="true">
                    <Paperclip size={14} strokeWidth={1.75} />
                  </span>
                  <span className="composer-attachment-meta">
                    <span className="composer-attachment-name">lisbon-map.png</span>
                    <span className="composer-attachment-sub muted">248 KB</span>
                  </span>
                  <button type="button" className="composer-attachment-remove" aria-label="Remove attachment">
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                </li>
                <li className="composer-attachment">
                  <span className="composer-attachment-thumb" aria-hidden="true">
                    <Paperclip size={14} strokeWidth={1.75} />
                  </span>
                  <span className="composer-attachment-meta">
                    <span className="composer-attachment-name">itinerary.md</span>
                    <span className="composer-attachment-sub muted">3.1 KB</span>
                  </span>
                  <button type="button" className="composer-attachment-remove" aria-label="Remove attachment">
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                </li>
              </ul>
              <textarea className="composer-input" rows={1} readOnly aria-label="Message" defaultValue="Plan a 4-day trip to Lisbon" />
              <div className="composer-toolbar">
                <div className="composer-tools-left">
                  <div className="model-picker">
                    <button type="button" className="model-picker-btn">
                      <span className="model-picker-name">Qwen3 35B</span>
                      <ChevronDown className="model-picker-caret" size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                  <button type="button" className="composer-attach" aria-label="Attach files">
                    <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button type="button" className="composer-search active" aria-pressed={true}>
                    <Globe size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className="composer-search-label">Search</span>
                  </button>
                </div>
                <div className="composer-tools-right">
                  <button type="button" className="mic" aria-label="Voice input">
                    <Mic size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button type="button" className="composer-send" aria-label="Send">
                    <ArrowUp size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
            <span className="muted small" style={{ display: "block", marginTop: "0.5rem" }}>
              Auto-growing input + a toolbar: the model picker, attach (files), web-search toggle, voice, and send.
              Attached files show as a gallery above the input before sending.
            </span>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Model picker (open)</span>
          <div className="ds-specimen-demo" style={{ display: "block", width: "100%" }}>
            {/* The real richer picker (#17), rendered open + inline so its search / filters / list
                show without a floating popover. In the composer it opens as an upward popover. */}
            <ModelPicker
              inline
              model={pickerModel}
              models={PICKER_MODELS}
              labels={PICKER_LABELS}
              catalog={PICKER_CATALOG}
              initialFavorites={PICKER_FAVORITES}
              onSelect={setPickerModel}
              disabled={false}
              openNonce={0}
            />
            <span className="muted small" style={{ display: "block", marginTop: "0.5rem" }}>
              The richer model picker: a search box, tier filters (all / favorites / free / premium), a
              per-model favorite star, and $-tier / BYOK badges. Pick a model to update the trigger.
            </span>
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2 className="ds-section-title">Motion</h2>
        <p className="ds-section-note muted small">
          Tokenized entrance animations. All respect “reduce motion” — the app’s accessibility toggle and the OS
          preference both disable them.
        </p>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Animations</span>
          <div className="ds-specimen-demo ds-specimen-demo-col" style={{ width: "100%" }}>
            <Button size="sm" onClick={() => setReplayKey((k) => k + 1)}>
              Replay
            </Button>
            <div key={replayKey} className="ds-motion-row">
              <span className="ds-motion-chip ui-anim-fade-in">fade-in</span>
              <span className="ds-motion-chip ui-anim-slide-up">slide-up</span>
              <span className="ds-motion-chip ui-anim-slide-down">slide-down</span>
              <span className="ds-motion-chip ui-anim-scale-in">scale-in</span>
            </div>
          </div>
        </div>
        <div className="ds-specimen">
          <span className="ds-specimen-label">Reveal (in + out)</span>
          <div className="ds-specimen-demo ds-specimen-demo-col" style={{ width: "100%", alignItems: "stretch" }}>
            <p className="muted small">
              A height + fade that animates both ways on every toggle, so neighbours glide instead of jumping.
              Used for the shortcut-conflict message. Toggle it:
            </p>
            <Toggle checked={revealOpen} onChange={setRevealOpen} label="Show message" />
            <div className={`ui-reveal ${revealOpen ? "open" : ""}`}>
              <div style={{ paddingTop: "0.35rem" }}>
                <InlineMessage variant="danger" role="status">
                  Already used by “Toggle sidebar”
                </InlineMessage>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
