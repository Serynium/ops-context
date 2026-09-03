import * as stylex from "@stylexjs/stylex";
import { useState } from "preact/hooks";
import { formatStackTrace, stackFrame } from "../lib/events";

const styles = stylex.create({
	root: {
		overflow: "hidden",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "#e4e6ee",
		borderRadius: 10,
		backgroundColor: "#ffffff",
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
	},
	header: { display: "flex", alignItems: "center", gap: 4, padding: 6 },
	toggle: {
		display: "flex",
		alignItems: "center",
		gap: 9,
		minWidth: 0,
		flexGrow: 1,
		paddingBlock: 7,
		paddingInline: 6,
		borderWidth: 0,
		borderRadius: 7,
		backgroundColor: "transparent",
		textAlign: "left",
		":hover": { backgroundColor: "#fafafc" },
		":focus-visible": { outline: "2px solid #aeb3ed", outlineOffset: -2 },
	},
	warning: { color: "#b91c1c", flexShrink: 0, fontSize: 14 },
	error: {
		display: "flex",
		alignItems: "baseline",
		gap: 8,
		minWidth: 0,
		fontSize: 13,
		lineHeight: 1.4,
	},
	type: { color: "#b91c1c", fontWeight: 700, flexShrink: 0 },
	message: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	action: {
		display: "grid",
		placeItems: "center",
		width: 28,
		height: 28,
		padding: 0,
		borderWidth: 0,
		borderRadius: 7,
		backgroundColor: "transparent",
		color: "#6b6d7c",
		":hover": { backgroundColor: "#f0f1f5", color: "#1a1b25" },
		":focus-visible": { outline: "2px solid #aeb3ed" },
	},
	icon: { width: 14, height: 14, display: "block" },
	chevron: {
		fontSize: 14,
		transitionProperty: "transform",
		transitionDuration: "150ms",
	},
	chevronOpen: { transform: "rotate(180deg)" },
	content: {
		maxHeight: 400,
		overflow: "auto",
		padding: 12,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: "#f0f1f5",
		backgroundColor: "#fafafc",
	},
	frame: { fontSize: 12, lineHeight: 1.7, overflowWrap: "anywhere" },
	internal: { color: "#b4b6c2" },
	external: { color: "#343640" },
	muted: { color: "#9c9eab" },
	path: { color: "#6b6d7c" },
});

export function StackTrace({
	errorType,
	message,
	frames,
	defaultOpen = true,
}: {
	errorType?: string;
	message?: string;
	frames: ReadonlyArray<unknown>;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const [copied, setCopied] = useState(false);
	const trace = formatStackTrace(errorType, message, frames);
	const copy = async () => {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(trace);
			} else {
				const input = document.createElement("textarea");
				input.value = trace;
				input.style.position = "fixed";
				input.style.opacity = "0";
				document.body.append(input);
				try {
					input.select();
					if (!document.execCommand("copy")) throw new Error("Copy failed");
				} finally {
					input.remove();
				}
			}
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1_600);
		} catch {
			setCopied(false);
		}
	};

	return (
		<div {...stylex.props(styles.root)}>
			<div {...stylex.props(styles.header)}>
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
					{...stylex.props(styles.toggle)}
				>
					<span aria-hidden="true" {...stylex.props(styles.warning)}>
						⚠
					</span>
					<span {...stylex.props(styles.error)}>
						{errorType && (
							<span {...stylex.props(styles.type)}>{errorType}</span>
						)}
						<span {...stylex.props(styles.message)}>
							{message || "Stack trace"}
						</span>
					</span>
				</button>
				<button
					type="button"
					aria-label={copied ? "Stack trace copied" : "Copy stack trace"}
					title={copied ? "Copied" : "Copy stack trace"}
					onClick={() => void copy()}
					{...stylex.props(styles.action)}
				>
					{copied ? (
						<svg
							aria-hidden="true"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							{...stylex.props(styles.icon)}
						>
							<path d="m5 12 4 4L19 6" />
						</svg>
					) : (
						<svg
							aria-hidden="true"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							{...stylex.props(styles.icon)}
						>
							<rect x="8" y="8" width="11" height="11" rx="2" />
							<path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
						</svg>
					)}
				</button>
				<button
					type="button"
					aria-label={open ? "Collapse stack trace" : "Expand stack trace"}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
					{...stylex.props(styles.action)}
				>
					<svg
						aria-hidden="true"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						{...stylex.props(
							styles.icon,
							styles.chevron,
							open && styles.chevronOpen,
						)}
					>
						<path d="m6 9 6 6 6-6" />
					</svg>
				</button>
			</div>
			{open && (
				<div {...stylex.props(styles.content)}>
					{frames.length ? (
						frames
							.slice()
							.reverse()
							.map((value, index) => {
								const frame = stackFrame(value);
								return (
									<div
										key={`${frame.file}:${frame.line}:${frame.func}:${index}`}
										{...stylex.props(
											styles.frame,
											frame.internal ? styles.internal : styles.external,
										)}
									>
										<span {...stylex.props(styles.muted)}>
											{frame.raw.startsWith("at ") ? "" : "at "}
										</span>
										{frame.func && <span>{frame.func} </span>}
										{frame.file && (
											<>
												<span {...stylex.props(styles.muted)}>(</span>
												<span {...stylex.props(styles.path)}>
													{frame.file}
													{frame.line ? `:${frame.line}` : ""}
													{frame.column ? `:${frame.column}` : ""}
												</span>
												<span {...stylex.props(styles.muted)}>)</span>
											</>
										)}
										{!frame.file && !frame.func && frame.raw}
									</div>
								);
							})
					) : (
						<div {...stylex.props(styles.frame, styles.internal)}>
							No stack frames
						</div>
					)}
				</div>
			)}
		</div>
	);
}
