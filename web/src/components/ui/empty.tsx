import * as stylex from "@stylexjs/stylex";
import type { HTMLAttributes } from "react";

const styles = stylex.create({
  root: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingBlock: 42,
    paddingInline: 16,
    textAlign: "center",
  },
  header: {
    maxWidth: 380,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  title: { color: "#1a1b25", fontWeight: 650 },
  description: { color: "#9c9eab", lineHeight: 1.6 },
});

export const Empty = (props: HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="empty" {...props} {...stylex.props(styles.root)} />
);
export const EmptyHeader = (props: HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="empty-header" {...props} {...stylex.props(styles.header)} />
);
export const EmptyTitle = (props: HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="empty-title" {...props} {...stylex.props(styles.title)} />
);
export const EmptyDescription = (props: HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="empty-description"
    {...props}
    {...stylex.props(styles.description)}
  />
);
