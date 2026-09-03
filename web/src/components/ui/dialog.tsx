import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "preact/hooks";
import type { ComponentProps } from "react";

const styles = stylex.create({
  dialog: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    width: "100%",
    height: "100%",
    maxWidth: "none",
    maxHeight: "none",
    margin: 0,
    padding: 16,
    borderWidth: 0,
    backgroundColor: "transparent",
    display: "grid",
    gridTemplateRows: "1fr auto 3fr",
    justifyItems: "center",
    overflow: "hidden",
    ":not([open])": { display: "none" },
    "@media (max-width: 639px)": {
      gridTemplateRows: "1fr auto",
      padding: 0,
      paddingTop: 48,
    },
  },
  popup: {
    position: "relative",
    gridRowStart: 2,
    display: "flex",
    flexDirection: "column",
    width: "100%",
    minWidth: 0,
    maxWidth: 512,
    maxHeight: "100%",
    color: "#1a1b25",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#e4e6ee",
    borderRadius: 16,
    boxShadow: "0 16px 48px rgba(23, 24, 31, 0.14)",
    outline: "none",
    "@media (max-width: 639px)": {
      maxWidth: "none",
      borderInlineWidth: 0,
      borderBottomWidth: 0,
      borderRadius: 0,
    },
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 24,
    paddingBottom: 12,
  },
  title: {
    paddingRight: 28,
    fontSize: 20,
    lineHeight: 1,
    fontWeight: 650,
  },
  description: { color: "#6b6d7c", fontSize: 14, lineHeight: 1.5 },
  panel: {
    minHeight: 0,
    padding: 24,
    paddingTop: 4,
    overflowY: "auto",
  },
  panelStack: { display: "flex", flexDirection: "column", gap: 12 },
  footer: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingInline: 24,
    paddingTop: 12,
    paddingBottom: 24,
  },
  footerDefault: {
    paddingBlock: 16,
    backgroundColor: "rgba(0, 0, 0, 0.03)",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "#e4e6ee",
  },
  close: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    display: "grid",
    placeItems: "center",
    padding: 0,
    color: "#6b6d7c",
    backgroundColor: "transparent",
    borderWidth: 0,
    borderRadius: 10,
    outline: "none",
    ":hover": { color: "#1a1b25", backgroundColor: "rgba(0, 0, 0, 0.04)" },
    ":focus-visible": { boxShadow: "0 0 0 2px #a3a3a3" },
  },
  closeIcon: { width: 16, height: 16 },
});

const classes = (style: string | undefined, extra?: string) =>
  [style, extra].filter(Boolean).join(" ");

export function Dialog({
  open,
  onOpenChange,
  children,
  className,
  ...props
}: Omit<ComponentProps<"dialog">, "open"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      {...props}
      ref={ref}
      className={classes(stylex.props(styles.dialog).className, className)}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
      data-slot="dialog"
    >
      {children}
    </dialog>
  );
}

export function DialogPopup({
  showCloseButton = true,
  onClose,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  showCloseButton?: boolean;
  onClose?: () => void;
}) {
  return (
    <div
      {...props}
      className={classes(stylex.props(styles.popup).className, className)}
      data-slot="dialog-popup"
    >
      {children}
      {showCloseButton && (
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          {...stylex.props(styles.close)}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            {...stylex.props(styles.closeIcon)}
          >
            <path d="m3 3 10 10M13 3 3 13" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      {...props}
      className={classes(stylex.props(styles.header).className, className)}
      data-slot="dialog-header"
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      {...props}
      className={classes(stylex.props(styles.title).className, className)}
      data-slot="dialog-title"
    />
  );
}

export function DialogDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      {...props}
      className={classes(stylex.props(styles.description).className, className)}
      data-slot="dialog-description"
    />
  );
}

export function DialogPanel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={classes(
        stylex.props(styles.panel, styles.panelStack).className,
        className,
      )}
      data-slot="dialog-panel"
    />
  );
}

export function DialogFooter({
  variant = "default",
  className,
  ...props
}: ComponentProps<"footer"> & { variant?: "default" | "bare" }) {
  return (
    <footer
      {...props}
      className={classes(
        stylex.props(
          styles.footer,
          variant === "default" && styles.footerDefault,
        ).className,
        className,
      )}
      data-slot="dialog-footer"
    />
  );
}
