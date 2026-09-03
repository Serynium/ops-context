import * as stylex from "@stylexjs/stylex";
import { Link, useParams } from "../router";
import { useState } from "preact/hooks";
import { api, type EventItem, type Silence } from "../api";
import { useMutation, useQuery, useQueryClient } from "../query";
import { DataSections } from "../components/data-sections";
import { Fact } from "../components/fact";
import { formatDate, relative, safeUrl } from "../lib/events";
import { styles } from "../styles";
import {
	Actions,
	Alert,
	AlertDescription,
	Button,
	CodeBlock,
	ErrorMessage,
	Frame,
	FrameHeader,
	FramePanel,
	FrameTitle,
	LevelBadge,
	ProjectIcon,
	Skeleton,
	StatusDot,
} from "../components/ui";

export function EventDetailPage() {
	const { eventId } = useParams({ strict: false }) as { eventId: string };
	const queryClient = useQueryClient();
	const [silenceOpen, setSilenceOpen] = useState(false);
	const [showRaw, setShowRaw] = useState(false);
	const [message, setMessage] = useState("");
	const event = useQuery({
		queryKey: ["event", eventId],
		queryFn: () => api.event(eventId),
	});
	const deliveries = useQuery({
		queryKey: ["event-deliveries", eventId],
		queryFn: () => api.eventDeliveries(eventId),
	});
	const rules = useQuery({ queryKey: ["silences"], queryFn: api.silences });
	const silence = useMutation({
		mutationFn: ({
			field,
			scoped,
			item,
		}: {
			field: Silence["field"];
			scoped: boolean;
			item: EventItem;
		}) =>
			api.createSilence({
				field,
				value:
					field === "fingerprint"
						? item.fingerprint
						: field === "source"
							? item.source
							: item.title,
				...(scoped ? { project_id: item.project_id } : {}),
				note: `From event ${item.id}`,
			}),
		onSuccess: (rule) => {
			setMessage(
				`Silenced ${rule.field} “${rule.value}”. Future matches are stored but not pushed.`,
			);
			setSilenceOpen(false);
			void queryClient.invalidateQueries({ queryKey: ["silences"] });
		},
	});
	const unsilence = useMutation({
		mutationFn: () => api.unsilence(eventId),
		onSuccess: async () => {
			setMessage("Unsilenced and queued for push.");
			await queryClient.invalidateQueries({ queryKey: ["event", eventId] });
			await queryClient.invalidateQueries({
				queryKey: ["event-deliveries", eventId],
			});
		},
	});
	const removeRule = useMutation({
		mutationFn: api.deleteSilence,
		onSuccess: async () => {
			setMessage("Silence rule removed. Future matches will be pushed again.");
			await queryClient.invalidateQueries({ queryKey: ["silences"] });
		},
	});
	const item = event.data;
	const rule = item?.silence_id
		? rules.data?.silences.find((candidate) => candidate.id === item.silence_id)
		: undefined;
	return (
		<div {...stylex.props(styles.detailPage)}>
			<div {...stylex.props(styles.crumbRow)}>
				<div {...stylex.props(styles.crumb)}>
					<Link to="/" {...stylex.props(styles.link)}>
						Inbox
					</Link>
					<span>/</span>
					<span {...stylex.props(styles.mono, styles.truncate)}>{eventId}</span>
				</div>
				{item && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => setSilenceOpen((open) => !open)}
					>
						{silenceOpen ? "Cancel" : "Silence events like this"}
					</Button>
				)}
			</div>
			{item && silenceOpen && (
				<div {...stylex.props(styles.menu)}>
					<span {...stylex.props(styles.muted)}>
						Stop pushes for future events matching:
					</span>
					{item.fingerprint && (
						<button
							{...stylex.props(styles.menuButton)}
							onClick={() =>
								silence.mutate({ field: "fingerprint", scoped: true, item })
							}
						>
							fingerprint{" "}
							<span {...stylex.props(styles.mono)}>{item.fingerprint}</span> ·{" "}
							{item.project_name}
						</button>
					)}
					<button
						{...stylex.props(styles.menuButton)}
						onClick={() =>
							silence.mutate({ field: "title", scoped: true, item })
						}
					>
						title “{item.title}” · {item.project_name}
					</button>
					<button
						{...stylex.props(styles.menuButton)}
						onClick={() =>
							silence.mutate({ field: "title", scoped: false, item })
						}
					>
						title “{item.title}” · every project
					</button>
					{item.source && (
						<button
							{...stylex.props(styles.menuButton)}
							onClick={() =>
								silence.mutate({ field: "source", scoped: true, item })
							}
						>
							source <span {...stylex.props(styles.mono)}>{item.source}</span> ·{" "}
							{item.project_name}
						</button>
					)}
				</div>
			)}
			{event.isLoading ? (
				<Frame>
					<FramePanel>
						<Skeleton lines={4} />
					</FramePanel>
					<FramePanel>
						<Skeleton lines={3} />
					</FramePanel>
				</Frame>
			) : event.isError ? (
				<ErrorMessage error={event.error} />
			) : (
				item && (
					<>
						{item.silenced && (
							<Frame>
								<FrameHeader>
									<FrameTitle>Silenced</FrameTitle>
								</FrameHeader>
								<FramePanel
									variant="compact"
									{...stylex.props(styles.detailSection)}
								>
									<p {...stylex.props(styles.secondary)}>
										This event matched a silence rule and was not pushed to any
										browser.
									</p>
									{rule ? (
										<div {...stylex.props(styles.row)}>
											<span {...stylex.props(styles.pill, styles.pillAccent)}>
												{rule.field}
											</span>
											<span {...stylex.props(styles.mono)}>{rule.value}</span>
											<span {...stylex.props(styles.muted)}>
												· {rule.project_name || "every project"}
												{rule.note ? ` · ${rule.note}` : ""}
											</span>
										</div>
									) : (
										<p {...stylex.props(styles.muted)}>
											The rule that silenced it has since been removed.
										</p>
									)}
									<div {...stylex.props(styles.row)}>
										<Button
											variant="outline"
											size="sm"
											onClick={() => unsilence.mutate()}
										>
											Unsilence and push now
										</Button>
										{rule && (
											<Button
												variant="destructive-outline"
												size="sm"
												onClick={() => removeRule.mutate(rule.id)}
											>
												Remove rule
											</Button>
										)}
										<a href="/?silenced=true" {...stylex.props(styles.link)}>
											All silenced events
										</a>
									</div>
								</FramePanel>
							</Frame>
						)}
						{message && (
							<Alert variant="success">
								<AlertDescription>{message}</AlertDescription>
							</Alert>
						)}
						<Frame>
							<FramePanel variant="compact">
								<div {...stylex.props(styles.head)}>
									<div {...stylex.props(styles.meta)}>
										<ProjectIcon
											icon={item.project_icon || "circle:orange"}
											size={14}
										/>
										{item.project_name}
										<span>·</span>
										<LevelBadge level={item.level} />
										{item.source && (
											<>
												<span>·</span>
												<span>{item.source}</span>
											</>
										)}
										{item.type && (
											<>
												<span>·</span>
												<span>{item.type}</span>
											</>
										)}
									</div>
									<h1 {...stylex.props(styles.h1)}>{item.title}</h1>
									{item.body && (
										<p {...stylex.props(styles.body)}>{item.body}</p>
									)}
								</div>
								<div {...stylex.props(styles.facts)}>
									<Fact label="Occurred" value={formatDate(item.occurred_at)} />
									<Fact
										label="Received"
										value={`${formatDate(item.created_at)} · ${relative(item.created_at)}`}
									/>
									{item.fingerprint && (
										<Fact
											label="Fingerprint"
											value={
												<span {...stylex.props(styles.mono)}>
													{item.fingerprint} ·{" "}
													<Link
														to="/groups/$projectId/$fingerprint"
														params={{
															projectId: item.project_id,
															fingerprint: item.fingerprint,
														}}
														{...stylex.props(styles.link)}
													>
														all occurrences
													</Link>
												</span>
											}
										/>
									)}
									{item.external_id && (
										<Fact label="External id" value={item.external_id} />
									)}
									<Fact label="Event id" value={item.id} />
								</div>
							</FramePanel>
						</Frame>
						<Frame>
							<FramePanel variant="flush" {...stylex.props(styles.detailPanel)}>
								{item.actions.length > 0 && (
									<div {...stylex.props(styles.detailSection)}>
										<FrameTitle>Actions</FrameTitle>
										<Actions>
											{item.actions.flatMap((action) => {
												const url = safeUrl(action.url);
												return url
													? [
															<a
																key={`${action.label}:${url}`}
																href={url}
																target="_blank"
																rel="noopener noreferrer"
															>
																<Button size="sm">{action.label} ↗</Button>
															</a>,
														]
													: [];
											})}
										</Actions>
									</div>
								)}
								<DataSections data={item.data} />
								<div {...stylex.props(styles.detailSection)}>
									<div {...stylex.props(styles.detailSectionHeader)}>
										<FrameTitle>Raw JSON</FrameTitle>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setShowRaw((show) => !show)}
										>
											{showRaw ? "Hide" : "Show"}
										</Button>
									</div>
									{showRaw ? (
										<CodeBlock code={JSON.stringify(item, null, 2)} />
									) : (
										<span {...stylex.props(styles.muted)}>
											{Object.keys(item.data).length} top-level keys
										</span>
									)}
								</div>
								<div {...stylex.props(styles.detailSection)}>
									<FrameTitle>Push delivery</FrameTitle>
									{deliveries.data?.deliveries.length ? (
										deliveries.data.deliveries.map((delivery) => (
											<div key={delivery.id} {...stylex.props(styles.delivery)}>
												<span>
													{delivery.subscription_name ||
														delivery.subscription_id}
												</span>
												<StatusDot
													tone={
														delivery.status === "sent"
															? "success"
															: delivery.status === "failed"
																? "error"
																: "muted"
													}
												>
													{delivery.status}
												</StatusDot>
												<span
													{...stylex.props(styles.muted, styles.mobileHide)}
												>
													{delivery.error ||
														(delivery.response_status
															? `HTTP ${delivery.response_status}`
															: "")}
												</span>
												<span {...stylex.props(styles.muted, styles.right)}>
													{relative(delivery.attempted_at)}
												</span>
											</div>
										))
									) : (
										<span {...stylex.props(styles.muted)}>
											No delivery attempts recorded. Enable a browser to receive
											pushes.
										</span>
									)}
								</div>
							</FramePanel>
						</Frame>
					</>
				)
			)}
		</div>
	);
}
