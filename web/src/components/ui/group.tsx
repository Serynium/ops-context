import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";
import { GroupContext, type GroupOrientation } from "./group-context";

const styles = stylex.create({
  group: {
    display: "flex",
    width: "fit-content",
    maxWidth: "100%",
    "--group-separator-color": "rgba(0, 0, 0, 0.1)",
    ":focus-within": { "--group-separator-color": "#a3a3a3" },
  },
  horizontal: { flexDirection: "row" },
  vertical: { flexDirection: "column" },
  separator: {
    position: "relative",
    zIndex: 2,
    flexShrink: 0,
    pointerEvents: "none",
    backgroundColor: "var(--group-separator-color)",
  },
  separatorVertical: { width: 1, alignSelf: "stretch" },
  separatorHorizontal: { height: 1, width: "100%" },
});

export function Group({
  orientation = "horizontal",
  className,
  ...props
}: ComponentProps<"div"> & { orientation?: GroupOrientation }) {
  return (
    <GroupContext.Provider value={orientation}>
      <div
        role="group"
        {...props}
        className={[
          stylex.props(
            styles.group,
            orientation === "horizontal" && styles.horizontal,
            orientation === "vertical" && styles.vertical,
          ).className,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        data-orientation={orientation}
        data-slot="group"
      />
    </GroupContext.Provider>
  );
}

export function GroupSeparator({
  orientation = "vertical",
  className,
  ...props
}: ComponentProps<"div"> & { orientation?: GroupOrientation }) {
  return (
    <div
      aria-hidden="true"
      role="separator"
      {...props}
      className={[
        stylex.props(
          styles.separator,
          orientation === "vertical" && styles.separatorVertical,
          orientation === "horizontal" && styles.separatorHorizontal,
        ).className,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-orientation={orientation}
      data-slot="group-separator"
    />
  );
}
