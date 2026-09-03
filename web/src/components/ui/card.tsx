import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

const styles = stylex.create({
  title: { fontSize: 14, lineHeight: 1.3, fontWeight: 650 },
});

const classes = (style: string | undefined, extra?: string) =>
  [style, extra].filter(Boolean).join(" ");

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 {...props} className={classes(stylex.props(styles.title).className, className)} data-slot="card-title" />;
}
