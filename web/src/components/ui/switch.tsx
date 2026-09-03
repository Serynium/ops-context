import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

const styles = stylex.create({
  root: {
    position: "relative",
    display: "inline-flex",
    width: 34,
    height: 20,
    flexShrink: 0,
    borderRadius: 999,
    padding: 2,
    backgroundColor: "#e4e6ee",
    cursor: "pointer",
    ":focus-within": { boxShadow: "0 0 0 3px #ffd7b0" },
  },
  checked: { backgroundColor: "#f48120" },
  disabled: { cursor: "default", opacity: 0.5 },
  input: { position: "absolute", inset: 0, opacity: 0, cursor: "inherit" },
  thumb: {
    width: 16,
    height: 16,
    borderRadius: 999,
    backgroundColor: "#fdfdfe",
    boxShadow: "0 1px 3px rgba(23,24,31,.15)",
    transitionProperty: "transform",
    transitionDuration: "160ms",
  },
  thumbChecked: { transform: "translateX(14px)" },
});

export function Switch({
  checked = false,
  disabled,
  onCheckedChange,
  ...props
}: Omit<ComponentProps<"input">, "type" | "checked"> & {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <label
      {...stylex.props(
        styles.root,
        checked && styles.checked,
        disabled && styles.disabled,
      )}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        {...props}
        onChange={(event) => {
          props.onChange?.(event);
          onCheckedChange?.(event.currentTarget.checked);
        }}
        {...stylex.props(styles.input)}
      />
      <span
        aria-hidden="true"
        {...stylex.props(styles.thumb, checked && styles.thumbChecked)}
      />
    </label>
  );
}
