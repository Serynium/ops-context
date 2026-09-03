import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

const styles = stylex.create({
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    backgroundColor: "#fdfdfe",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#f0f1f5",
    borderRadius: 14,
    color: "#1a1b25",
  },
  header: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: 10,
    paddingInline: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  title: { fontSize: 14, lineHeight: 1.3, fontWeight: 650 },
  description: { color: "#6b6d7c", fontSize: 13, lineHeight: 1.6, marginTop: 4 },
  action: { gridColumn: 2, gridRow: "1 / span 2", alignSelf: "center", justifySelf: "end" },
  panel: { flexGrow: 1, padding: 24 },
  panelAfterHeader: { paddingTop: 0 },
  flush: { padding: 8, paddingTop: 16 },
  compact: { paddingBlock: 14, paddingInline: 16 },
});

const classes = (style: string | undefined, extra?: string) =>
  [style, extra].filter(Boolean).join(" ");

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section {...props} className={classes(stylex.props(styles.card).className, className)} data-slot="card" />;
}
export function CardHeader({ className, ...props }: ComponentProps<"header">) {
  return <header {...props} className={classes(stylex.props(styles.header).className, className)} data-slot="card-header" />;
}
export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 {...props} className={classes(stylex.props(styles.title).className, className)} data-slot="card-title" />;
}
export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p {...props} className={classes(stylex.props(styles.description).className, className)} data-slot="card-description" />;
}
export function CardAction({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={classes(stylex.props(styles.action).className, className)} data-slot="card-action" />;
}
export function CardPanel({
  variant = "default",
  insetHeader = false,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "default" | "flush" | "compact";
  insetHeader?: boolean;
}) {
  return (
    <div
      {...props}
      className={classes(
        stylex.props(
          styles.panel,
          insetHeader && styles.panelAfterHeader,
          variant === "flush" && styles.flush,
          variant === "compact" && styles.compact,
        ).className,
        className,
      )}
      data-slot="card-panel"
    />
  );
}
export { CardPanel as CardContent };
