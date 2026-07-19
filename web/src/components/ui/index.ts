// Design-system barrel. Import primitives from here — `import { Button, Kbd, InlineMessage } from
// "../ui"` — never reach into atoms/ or molecules/ directly. Organised by Atomic Design layer
// (atoms → molecules → organisms); see ./README.md.

// Atoms
export { Badge, type BadgeVariant } from "./atoms/Badge";
export { Button, type ButtonSize, type ButtonVariant } from "./atoms/Button";
export { IconButton } from "./atoms/IconButton";
export { Input, TextArea } from "./atoms/Input";
export { Kbd } from "./atoms/Kbd";
export { SectionHeading } from "./atoms/SectionHeading";
export { Select } from "./atoms/Select";
export { ThinkingMark } from "./atoms/ThinkingMark";

// Molecules
export { Field } from "./molecules/Field";
export { InlineMessage, type InlineMessageVariant } from "./molecules/InlineMessage";
export { KeyCaptureField } from "./molecules/KeyCaptureField";
export { KeyCombo } from "./molecules/KeyCombo";
export { PanelActions } from "./molecules/PanelActions";
export { SegmentedControl } from "./molecules/SegmentedControl";
export { Slider } from "./molecules/Slider";
export { Toggle } from "./molecules/Toggle";

// Organisms
export { ChatBubble } from "./organisms/ChatBubble";
export { Menu, MenuItem, MenuSeparator } from "./organisms/Menu";
export { Modal } from "./organisms/Modal";
export { SidebarModal, type SidebarModalItem } from "./organisms/SidebarModal";

// Chat blocks (the real ones the markdown renderer uses — copy/download/expand toolbars).
// They live in components/ (tied to streamdown); re-exported here so the DS gallery + docs
// treat them as first-class chat elements.
export { CodeBlock } from "../CodeBlock";
export { TableBlock } from "../TableBlock";
