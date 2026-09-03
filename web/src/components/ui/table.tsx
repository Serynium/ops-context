import * as stylex from "@stylexjs/stylex";
import { useContext } from "preact/hooks";
import type { ComponentProps } from "react";
import { createContext } from "../../context";

export type TableVariant = "default" | "card";
const TableContext = createContext<TableVariant>("default");
const TableSectionContext = createContext<"body" | "footer" | "other">(
  "other",
);

const styles = stylex.create({
  container: { position: "relative", width: "100%", overflowX: "auto" },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    captionSide: "bottom",
    fontSize: 14,
  },
  tableCard: { borderCollapse: "separate", borderSpacing: 0 },
  body: { position: "relative" },
  bodyCard: {
    borderRadius: 12,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
    "::before": {
      content: "''",
      pointerEvents: "none",
      position: "absolute",
      inset: 1,
      borderRadius: 11,
      boxShadow: "0 1px rgba(0, 0, 0, 0.04)",
    },
  },
  row: {
    position: "relative",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "rgba(0, 0, 0, 0.08)",
  },
  rowBody: { ":last-child": { borderBottomWidth: 0 } },
  rowFooter: { ":last-child": { borderBottomWidth: 0 } },
  rowDefault: {
    ":hover": { backgroundColor: "rgba(0, 0, 0, 0.02)" },
  },
  rowCard: {
    borderBottomWidth: 0,
    "--table-cell-background": "#ffffff",
    "--table-cell-border-top-width": "0px",
    "--table-cell-start-radius": "0px",
    "--table-cell-end-radius": "0px",
    ":first-child": {
      "--table-cell-border-top-width": "1px",
      "--table-cell-start-radius": "12px",
    },
    ":last-child": { "--table-cell-end-radius": "12px" },
  },
  rowCardHover: {
    ":hover": { "--table-cell-background": "#fafafa" },
  },
  rowSelectedDefault: { backgroundColor: "#f5f5f5" },
  rowSelectedCard: { "--table-cell-background": "#f5f5f5" },
  head: {
    height: 40,
    paddingInline: 10,
    textAlign: "left",
    verticalAlign: "middle",
    color: "#686868",
    fontWeight: 500,
    lineHeight: 1,
    whiteSpace: "nowrap",
    ":has([role='checkbox'])": { width: 1 },
    ":first-child:has([role='checkbox'])": { paddingInlineEnd: 0 },
    ":last-child:has([role='checkbox'])": { paddingInlineStart: 0 },
  },
  cell: {
    padding: 10,
    textAlign: "left",
    verticalAlign: "middle",
    lineHeight: 1,
    whiteSpace: "nowrap",
    backgroundClip: "padding-box",
    ":has([role='checkbox'])": { width: 1 },
    ":first-child:has([role='checkbox'])": { paddingInlineEnd: 0 },
    ":last-child:has([role='checkbox'])": { paddingInlineStart: 0 },
  },
  cellCard: {
    borderTopWidth: "var(--table-cell-border-top-width)",
    borderTopStyle: "solid",
    borderTopColor: "rgba(0, 0, 0, 0.08)",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "rgba(0, 0, 0, 0.08)",
    backgroundColor: "var(--table-cell-background)",
    ":first-child": {
      paddingInlineStart: 9,
      borderInlineStartWidth: 1,
      borderInlineStartStyle: "solid",
      borderInlineStartColor: "rgba(0, 0, 0, 0.08)",
      borderStartStartRadius: "var(--table-cell-start-radius)",
      borderEndStartRadius: "var(--table-cell-end-radius)",
    },
    ":last-child": {
      paddingInlineEnd: 9,
      borderInlineEndWidth: 1,
      borderInlineEndStyle: "solid",
      borderInlineEndColor: "rgba(0, 0, 0, 0.08)",
      borderStartEndRadius: "var(--table-cell-start-radius)",
      borderEndEndRadius: "var(--table-cell-end-radius)",
    },
  },
  cellFooter: { paddingBlock: 14 },
  footer: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "rgba(0, 0, 0, 0.08)",
    backgroundColor: "rgba(0, 0, 0, 0.02)",
    fontWeight: 500,
  },
  footerCard: { borderTopWidth: 0, backgroundColor: "transparent" },
  caption: { marginTop: 16, color: "#686868", fontSize: 14 },
  captionCard: { marginBlock: 16 },
});

const classes = (...values: Array<string | undefined>) =>
  values.filter(Boolean).join(" ");

export type TableProps = ComponentProps<"table"> & {
  variant?: TableVariant;
};

export function Table({
  variant = "default",
  children,
  className,
  ...props
}: TableProps) {
  return (
    <TableContext.Provider value={variant}>
      <div
        {...stylex.props(styles.container)}
        data-slot="table-container"
        data-variant={variant}
      >
        <table
          {...props}
          className={classes(
            stylex.props(
              styles.table,
              variant === "card" && styles.tableCard,
            ).className,
            className,
          )}
          data-slot="table"
        >
          {children}
        </table>
      </div>
    </TableContext.Provider>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <TableSectionContext.Provider value="other">
      <thead {...props} className={className} data-slot="table-header" />
    </TableSectionContext.Provider>
  );
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  const variant = useContext(TableContext);
  return (
    <TableSectionContext.Provider value="body">
      <tbody
        {...props}
        className={classes(
          stylex.props(styles.body, variant === "card" && styles.bodyCard)
            .className,
          className,
        )}
        data-slot="table-body"
      />
    </TableSectionContext.Provider>
  );
}

export function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  const variant = useContext(TableContext);
  return (
    <TableSectionContext.Provider value="footer">
      <tfoot
        {...props}
        className={classes(
          stylex.props(
            styles.footer,
            variant === "card" && styles.footerCard,
          ).className,
          className,
        )}
        data-slot="table-footer"
      />
    </TableSectionContext.Provider>
  );
}

export function TableRow({
  className,
  hoverable = true,
  ...props
}: ComponentProps<"tr"> & { "data-state"?: string; hoverable?: boolean }) {
  const variant = useContext(TableContext);
  const section = useContext(TableSectionContext);
  return (
    <tr
      {...props}
      className={classes(
        stylex.props(
          styles.row,
          section === "body" && styles.rowBody,
          section === "footer" && styles.rowFooter,
          variant === "default" && hoverable && styles.rowDefault,
          variant === "card" && section === "body" && styles.rowCard,
          variant === "card" &&
            section === "body" &&
            hoverable &&
            styles.rowCardHover,
          props["data-state"] === "selected" &&
            (variant === "card"
              ? styles.rowSelectedCard
              : styles.rowSelectedDefault),
        ).className,
        className,
      )}
      data-slot="table-row"
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      {...props}
      className={classes(stylex.props(styles.head).className, className)}
      data-slot="table-head"
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  const variant = useContext(TableContext);
  const section = useContext(TableSectionContext);
  return (
    <td
      {...props}
      className={classes(
        stylex.props(
          styles.cell,
          variant === "card" && styles.cellCard,
          section === "footer" && styles.cellFooter,
        ).className,
        className,
      )}
      data-slot="table-cell"
    />
  );
}

export function TableCaption({
  className,
  ...props
}: ComponentProps<"caption">) {
  const variant = useContext(TableContext);
  return (
    <caption
      {...props}
      className={classes(
        stylex.props(
          styles.caption,
          variant === "card" && styles.captionCard,
        ).className,
        className,
      )}
      data-slot="table-caption"
    />
  );
}
