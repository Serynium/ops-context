import * as stylex from "@stylexjs/stylex";
import type { ComponentPropsWithRef } from "react";
import { useGroupOrientation } from "./group-context";

const styles = stylex.create({
  control: {
    position: "relative",
    display: "inline-flex",
    width: "100%",
    minWidth: 0,
    borderBlockStartWidth: 1,
    borderBlockEndWidth: 1,
    borderInlineStartWidth: 1,
    borderInlineEndWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(0, 0, 0, 0.1)",
    borderRadius: 10,
    color: "#262626",
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05), inset 0 1px rgba(0, 0, 0, 0.04)",
    fontSize: 16,
    transitionProperty: "box-shadow, border-color",
    transitionDuration: "150ms",
    "@media (min-width: 640px)": { fontSize: 14 },
    ":focus-within": {
      zIndex: 1,
      borderColor: "#d6710e",
      boxShadow: "0 0 0 3px rgba(244, 129, 32, 0.22)",
    },
    ":has([aria-invalid='true'])": {
      borderColor: "rgba(239, 68, 68, 0.36)",
    },
    ":has(:disabled)": { opacity: 0.64 },
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
  input: {
    width: "100%",
    minWidth: 0,
    height: 34,
    paddingInline: 11,
    borderWidth: 0,
    borderRadius: "inherit",
    color: "#262626",
    backgroundColor: "transparent",
    outline: "none",
    lineHeight: "34px",
    "::placeholder": { color: "rgba(82, 82, 82, 0.72)" },
    ":disabled": { cursor: "not-allowed" },
    "@media (min-width: 640px)": { height: 30, lineHeight: "30px" },
  },
  small: {
    height: 30,
    paddingInline: 9,
    lineHeight: "30px",
    "@media (min-width: 640px)": { height: 26, lineHeight: "26px" },
  },
  large: {
    height: 38,
    lineHeight: "38px",
    "@media (min-width: 640px)": { height: 34, lineHeight: "34px" },
  },
});

export type InputProps = Omit<
  ComponentPropsWithRef<"input">,
  "size"
> & {
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
};

export function Input({
  size = "default",
  unstyled = false,
  className,
  ...props
}: InputProps) {
  const group = useGroupOrientation();
  const control = stylex.props(
    !unstyled && styles.control,
    !unstyled && group === "horizontal" && styles.groupedHorizontal,
    !unstyled && group === "vertical" && styles.groupedVertical,
  );
  return (
    <span
      {...control}
      className={[control.className, className].filter(Boolean).join(" ")}
      data-size={size}
      data-slot="input-control"
    >
      <input
        {...props}
        {...stylex.props(
          styles.input,
          size === "sm" && styles.small,
          size === "lg" && styles.large,
        )}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
      />
    </span>
  );
}
