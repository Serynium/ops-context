import * as stylex from "@stylexjs/stylex";
import { display, eventFrames } from "../lib/events";
import { styles } from "../styles";
import { FrameTitle, JsonTree } from "./ui";
import { StackTrace } from "./stack-trace";

export function DataSections({ data }: { data: Record<string, unknown> }) {
	const object = (key: string) =>
		data[key] && typeof data[key] === "object" && !Array.isArray(data[key])
			? (data[key] as Record<string, unknown>)
			: undefined;
	const array = (key: string) =>
		Array.isArray(data[key])
			? (data[key] as ReadonlyArray<unknown>)
			: undefined;
	const exception = object("exception");
	const frames = eventFrames(data);
	const tags = object("tags");
	const context = object("context");
	const breadcrumbs = array("breadcrumbs");
	const rest = Object.fromEntries(
		Object.entries(data).filter(
			([key]) =>
				!["exception", "stacktrace", "tags", "context", "breadcrumbs"].includes(
					key,
				),
		),
	);

	return (
		<>
			{exception && (
				<div {...stylex.props(styles.detailSection)}>
					<StackTrace
						errorType={display(exception.type)}
						message={display(exception.message ?? exception.value)}
						frames={frames ?? []}
					/>
					{Object.entries(exception)
						.filter(
							([key]) => !["type", "message", "value", "frames"].includes(key),
						)
						.map(([key, value]) => (
							<div key={key} {...stylex.props(styles.contextRow)}>
								<span {...stylex.props(styles.factKey)}>{key}</span>
								<span {...stylex.props(styles.mono)}>{display(value)}</span>
							</div>
						))}
				</div>
			)}
			{frames && !exception && (
				<div {...stylex.props(styles.detailSection)}>
					<StackTrace frames={frames} />
				</div>
			)}
			{tags && (
				<div {...stylex.props(styles.detailSection)}>
					<FrameTitle>Tags</FrameTitle>
					<div {...stylex.props(styles.pillList)}>
						{Object.entries(tags).map(([key, value]) => (
							<span key={key} {...stylex.props(styles.pill)}>
								<span {...stylex.props(styles.muted)}>{key}</span>
								{display(value)}
							</span>
						))}
					</div>
				</div>
			)}
			{context && (
				<div {...stylex.props(styles.detailSection)}>
					<FrameTitle>Context</FrameTitle>
					{Object.entries(context).map(([key, value]) => (
						<div key={key} {...stylex.props(styles.contextRow)}>
							<span {...stylex.props(styles.factKey)}>{key}</span>
							{value && typeof value === "object" ? (
								<JsonTree value={value} />
							) : (
								<span {...stylex.props(styles.mono)}>{display(value)}</span>
							)}
						</div>
					))}
				</div>
			)}
			{breadcrumbs && (
				<div {...stylex.props(styles.detailSection)}>
					<FrameTitle>Breadcrumbs</FrameTitle>
					{breadcrumbs.map((breadcrumb, index) => {
						const value =
							breadcrumb && typeof breadcrumb === "object"
								? (breadcrumb as Record<string, unknown>)
								: {};
						return (
							<div key={index} {...stylex.props(styles.contextRow)}>
								<span {...stylex.props(styles.muted)}>
									{display(value.timestamp ?? value.time)}
								</span>
								<span>{display(value.message ?? value.msg ?? breadcrumb)}</span>
							</div>
						);
					})}
				</div>
			)}
			{Object.keys(rest).length > 0 && (
				<div {...stylex.props(styles.detailSection)}>
					<FrameTitle>Data</FrameTitle>
					{Object.entries(rest).map(([key, value]) => (
						<JsonTree key={key} name={key} value={value} />
					))}
				</div>
			)}
		</>
	);
}
