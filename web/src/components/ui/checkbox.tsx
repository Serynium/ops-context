import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

const styles = stylex.create({
  checkbox: {
    width: 16,
    height: 16,
    flexShrink: 0,
    accentColor: "#7c83e8",
    cursor: "pointer",
    ":focus-visible": { outlineColor: "#8b92ec", outlineWidth: 3 },
    ":disabled": { cursor: "not-allowed", opacity: 0.64 },
  },
});

export function Checkbox({
  onCheckedChange,
  ...props
}: Omit<ComponentProps<"input">, "type"> & {
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      {...props}
      onChange={(event) => {
        props.onChange?.(event);
        onCheckedChange?.(event.currentTarget.checked);
      }}
      {...stylex.props(styles.checkbox)}
    />
  );
}
