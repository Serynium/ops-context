import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";
import { useGroupOrientation } from "./group-context";

export type SelectSize = "sm" | "default" | "lg";

const styles = stylex.create({
	select: {
		width: "100%",
		minWidth: 0,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "#e4e6ee",
		borderRadius: 8,
		color: "#1a1b25",
		backgroundColor: "#fdfdfe",
		boxShadow: "0 1px 2px rgba(23,24,31,.04)",
		outline: "none",
		cursor: "pointer",
		":hover": { backgroundColor: "#fafafc" },
		":focus-visible": {
			borderColor: "#d6710e",
			boxShadow: "0 0 0 3px #ffd7b0",
		},
		":disabled": { cursor: "default", opacity: 0.64 },
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
	small: { minHeight: 28, paddingInline: 10, fontSize: 12 },
	default: { minHeight: 34, paddingInline: 12, fontSize: 13 },
	large: { minHeight: 40, paddingInline: 14, fontSize: 14 },
});

export function Select({
	size = "default",
	...props
}: Omit<ComponentProps<"select">, "size"> & { size?: SelectSize }) {
	const group = useGroupOrientation();
	return (
		<select
			{...props}
			{...stylex.props(
				styles.select,
				group === "horizontal" && styles.groupedHorizontal,
				group === "vertical" && styles.groupedVertical,
				size === "sm" && styles.small,
				size === "default" && styles.default,
				size === "lg" && styles.large,
			)}
		/>
	);
}
