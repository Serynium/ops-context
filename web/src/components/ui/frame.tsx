import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

const styles = stylex.create({
	frame: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		padding: 4,
		borderRadius: 16,
		backgroundColor: "rgba(0, 0, 0, 0.03)",
	},
	panel: {
		position: "relative",
		padding: 20,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "rgba(0, 0, 0, 0.08)",
		borderRadius: 12,
		backgroundColor: "#ffffff",
		backgroundClip: "padding-box",
		boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
		":is([data-slot='frame-panel'] + [data-slot='frame-panel'])": {
			marginTop: 4,
		},
		"::before": {
			content: "''",
			pointerEvents: "none",
			position: "absolute",
			inset: 0,
			borderRadius: 11,
			boxShadow: "0 1px rgba(0, 0, 0, 0.04)",
		},
	},
	panelCompact: { padding: 12 },
	panelFlush: { padding: 0 },
	header: {
		display: "flex",
		flexDirection: "column",
		paddingInline: 20,
		paddingBlock: 16,
	},
	title: { fontSize: 14, fontWeight: 600 },
	description: { color: "#686868", fontSize: 14 },
	footer: { paddingInline: 20, paddingBlock: 16 },
});

const classes = (...values: Array<string | undefined>) =>
	values.filter(Boolean).join(" ");

export function Frame({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			{...props}
			className={classes(stylex.props(styles.frame).className, className)}
			data-slot="frame"
		/>
	);
}

export function FramePanel({
	variant = "default",
	className,
	...props
}: ComponentProps<"div"> & {
	variant?: "default" | "compact" | "flush";
}) {
	return (
		<div
			{...props}
			className={classes(
				stylex.props(
					styles.panel,
					variant === "compact" && styles.panelCompact,
					variant === "flush" && styles.panelFlush,
				).className,
				className,
			)}
			data-slot="frame-panel"
		/>
	);
}

export function FrameHeader({ className, ...props }: ComponentProps<"header">) {
	return (
		<header
			{...props}
			className={classes(stylex.props(styles.header).className, className)}
			data-slot="frame-panel-header"
		/>
	);
}

export function FrameTitle({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			{...props}
			className={classes(stylex.props(styles.title).className, className)}
			data-slot="frame-panel-title"
		/>
	);
}

export function FrameDescription({
	className,
	...props
}: ComponentProps<"div">) {
	return (
		<div
			{...props}
			className={classes(stylex.props(styles.description).className, className)}
			data-slot="frame-panel-description"
		/>
	);
}

export function FrameFooter({ className, ...props }: ComponentProps<"footer">) {
	return (
		<footer
			{...props}
			className={classes(stylex.props(styles.footer).className, className)}
			data-slot="frame-panel-footer"
		/>
	);
}
