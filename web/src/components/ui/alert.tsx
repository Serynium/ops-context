import * as stylex from "@stylexjs/stylex";
import type { HTMLAttributes } from "react";

const styles = stylex.create({
  root: {
    display: "grid",
    gap: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: 10,
    paddingBlock: 12,
    paddingInline: 14,
    lineHeight: 1.5,
    fontSize: 13,
  },
  info: {
    borderColor: "#dbdff8",
    backgroundColor: "#eef0fb",
    color: "#5a62d4",
  },
  warning: {
    borderColor: "#f5b266",
    backgroundColor: "#fff8ef",
    color: "#9b5b12",
  },
  error: {
    borderColor: "#c8b8ef",
    backgroundColor: "#f5f0ff",
    color: "#6a45c4",
  },
  success: {
    borderColor: "#bce5d7",
    backgroundColor: "#ddf3ea",
    color: "#2f8f6e",
  },
  description: { color: "inherit" },
});

export function Alert({
  variant = "info",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  variant?: "info" | "warning" | "error" | "success";
}) {
  return (
    <div
      role="alert"
      data-slot="alert"
      {...props}
      {...stylex.props(styles.root, styles[variant])}
    />
  );
}
export const AlertDescription = (props: HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="alert-description"
    {...props}
    {...stylex.props(styles.description)}
  />
);
