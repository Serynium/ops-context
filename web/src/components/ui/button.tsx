import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";
import { useGroupOrientation } from "./group-context";

const styles = stylex.create({
  root: {
    position: "relative",
    height: 36,
    paddingInline: 11,
    borderBlockStartWidth: 1,
    borderBlockEndWidth: 1,
    borderInlineStartWidth: 1,
    borderInlineEndWidth: 1,
    borderStyle: "solid",
    borderRadius: 10,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    whiteSpace: "nowrap",
    fontSize: 16,
    lineHeight: 1.25,
    fontWeight: 500,
    outline: "none",
    cursor: "pointer",
    transitionProperty: "box-shadow, background-color, border-color",
    transitionDuration: "150ms",
    "@media (min-width: 640px)": { height: 32, fontSize: 14 },
    ":focus-visible": {
      zIndex: 1,
      boxShadow: "0 0 0 1px #ffffff, 0 0 0 3px #a3a3a3",
    },
    ":disabled": {
      opacity: 0.64,
      cursor: "default",
      pointerEvents: "none",
    },
  },
  small: {
    height: 32,
    paddingInline: 9,
    gap: 6,
    "@media (min-width: 640px)": { height: 28 },
  },
  icon: {
    width: 36,
    paddingInline: 0,
    "@media (min-width: 640px)": { width: 32 },
  },
  groupedHorizontal: {
    borderRadius: 0,
    borderInlineStartWidth: 0,
    borderInlineEndWidth: 0,
    ":first-child": {
      borderInlineStartWidth: 1,
      borderStartStartRadius: 10,
      borderEndStartRadius: 10,
    },
    ":last-child": {
      borderInlineEndWidth: 1,
      borderStartEndRadius: 10,
      borderEndEndRadius: 10,
    },
  },
  groupedVertical: {
    borderRadius: 0,
    borderBlockStartWidth: 0,
    borderBlockEndWidth: 0,
    ":first-child": {
      borderBlockStartWidth: 1,
      borderStartStartRadius: 10,
      borderStartEndRadius: 10,
    },
    ":last-child": {
      borderBlockEndWidth: 1,
      borderEndStartRadius: 10,
      borderEndEndRadius: 10,
    },
  },
  default: {
    borderColor: "#262626",
    backgroundColor: "#262626",
    color: "#fafafa",
    boxShadow:
      "0 1px 2px rgba(38, 38, 38, 0.24), inset 0 1px rgba(255, 255, 255, 0.16)",
    ":hover": { backgroundColor: "rgba(38, 38, 38, 0.9)" },
    ":active": {
      backgroundColor: "rgba(38, 38, 38, 0.9)",
      boxShadow: "inset 0 1px rgba(0, 0, 0, 0.08)",
    },
  },
  outline: {
    borderColor: "rgba(0, 0, 0, 0.1)",
    backgroundColor: "#ffffff",
    color: "#262626",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05), inset 0 1px rgba(0, 0, 0, 0.04)",
    ":hover": { backgroundColor: "rgba(0, 0, 0, 0.02)" },
    ":active": { backgroundColor: "rgba(0, 0, 0, 0.02)", boxShadow: "none" },
  },
  ghost: {
    borderColor: "transparent",
    backgroundColor: "transparent",
    color: "#262626",
    ":hover": { backgroundColor: "rgba(0, 0, 0, 0.04)" },
    ":active": { backgroundColor: "rgba(0, 0, 0, 0.04)" },
  },
  destructiveOutline: {
    borderColor: "rgba(0, 0, 0, 0.1)",
    backgroundColor: "#ffffff",
    color: "#b91c1c",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05), inset 0 1px rgba(0, 0, 0, 0.04)",
    ":hover": {
      borderColor: "rgba(239, 68, 68, 0.32)",
      backgroundColor: "rgba(239, 68, 68, 0.04)",
    },
    ":active": {
      borderColor: "rgba(239, 68, 68, 0.32)",
      backgroundColor: "rgba(239, 68, 68, 0.04)",
      boxShadow: "none",
    },
  },
  loading: { color: "transparent", userSelect: "none" },
  spinner: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 999,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "currentColor",
    borderTopColor: "transparent",
    animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
    animationDuration: "700ms",
    animationIterationCount: "infinite",
  },
  spinnerDefault: { color: "#fafafa" },
  spinnerNeutral: { color: "#262626" },
});

export interface ButtonProps extends Omit<ComponentProps<"button">, "size"> {
  variant?: "default" | "outline" | "ghost" | "destructive-outline";
  size?: "default" | "sm" | "icon";
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  const group = useGroupOrientation();
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-disabled={loading || undefined}
      data-loading={loading ? "" : undefined}
      data-slot="button"
      {...props}
      {...stylex.props(
        styles.root,
        size === "sm" && styles.small,
        size === "icon" && styles.icon,
        group === "horizontal" && styles.groupedHorizontal,
        group === "vertical" && styles.groupedVertical,
        variant === "default" && styles.default,
        variant === "outline" && styles.outline,
        variant === "ghost" && styles.ghost,
        variant === "destructive-outline" && styles.destructiveOutline,
        loading && styles.loading,
      )}
    >
      <>
        {children}
        {loading && (
          <span
            aria-hidden="true"
            {...stylex.props(
              styles.spinner,
              variant === "default" && styles.spinnerDefault,
              variant !== "default" && styles.spinnerNeutral,
            )}
          />
        )}
      </>
    </button>
  );
}
