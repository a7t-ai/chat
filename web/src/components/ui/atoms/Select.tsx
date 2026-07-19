import type { SelectHTMLAttributes } from "react";

// ATOM · Select — the app's `.input` control as a native <select>. A drop-in for the hand-written
// `<select className="input …">` dropdowns (the collaborator role picker, the account plan). Pass
// <option>s as children and forward every native prop (value, onChange, disabled…).
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={className ? `input ${className}` : "input"} {...rest}>
      {children}
    </select>
  );
}
