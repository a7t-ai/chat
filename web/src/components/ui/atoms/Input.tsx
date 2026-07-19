import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

// ATOM · Input / TextArea — the app's `.input` text control (border, focus-accent, radius) as typed
// primitives. TextArea inherits the vertical-only resize from the shared `.input` styles. Forward
// every native prop (value, onChange, placeholder, maxLength…).
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={className ? `input ${className}` : "input"} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={className ? `input ${className}` : "input"} {...rest} />;
}
