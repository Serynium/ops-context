import * as stylex from "@stylexjs/stylex";
import { Link, useParams } from "../router";
import { api } from "../api";
import { EventRow } from "../components/event-row";
import { Fact } from "../components/fact";
import { useInfiniteQuery, useQuery } from "../query";
import { formatDate } from "../lib/events";
import { styles } from "../styles";
import {
	Button,
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
	ErrorMessage,
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
	LevelBadge,
	ProjectIcon,
	Skeleton,
} from "../components/ui";

export function GroupPage() {
	const { projectId, fingerprint } = useParams({ strict: false }) as {
		projectId: string;
		fingerprint: string;
	};
	const head = useQuery({
		queryKey: ["group-head", projectId, fingerprint],
		queryFn: () =>
			api.events({
				project: projectId,
				fingerprint,
				grouped: "true",
				limit: "1",
			}),
	});
	const events = useInfiniteQuery({
		queryKey: ["group", projectId, fingerprint],
		queryFn: ({ pageParam }) =>
			api.eventGroup(projectId, fingerprint, {
				before: pageParam,
				limit: "50",
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.next_cursor,
	});
	const first = head.data?.events[0];
	const items = events.data?.pages.flatMap((page) => page.events) ?? [];
	return (
		<div {...stylex.props(styles.detailPage)}>
			<div {...stylex.props(styles.crumb)}>
				<Link to="/" {...stylex.props(styles.link)}>
					Inbox
				</Link>
				<span>/</span>
				<span {...stylex.props(styles.mono)}>{fingerprint}</span>
			</div>
			{head.isError && <ErrorMessage error={head.error} />}
			{first && (
				<Frame>
					<FramePanel variant="compact">
						<div {...stylex.props(styles.head)}>
							<div {...stylex.props(styles.meta)}>
								<ProjectIcon
									icon={first.project_icon || "circle:orange"}
									size={14}
								/>
								{first.project_name}
								<span>·</span>
								<LevelBadge level={first.level} />
								{first.source && (
									<>
										<span>·</span>
										{first.source}
									</>
								)}
							</div>
							<h1 {...stylex.props(styles.h1)}>
								{first.title}{" "}
								<span {...stylex.props(styles.count)}>
									{first.group?.count ?? items.length} occurrence
									{(first.group?.count ?? items.length) === 1 ? "" : "s"}
								</span>
							</h1>
							<div {...stylex.props(styles.facts)}>
								<Fact label="Fingerprint" value={fingerprint} />
								{first.group && (
									<>
										<Fact
											label="First seen"
											value={formatDate(first.group.first_seen)}
										/>
										<Fact
											label="Last seen"
											value={formatDate(first.group.last_seen)}
										/>
									</>
								)}
							</div>
						</div>
					</FramePanel>
				</Frame>
			)}
			<Frame>
				<FrameHeader>
					<FrameTitle>Occurrences</FrameTitle>
					{first?.group && (
						<FrameDescription>
							{formatDate(first.group.first_seen)} –{" "}
							{formatDate(first.group.last_seen)}
						</FrameDescription>
					)}
				</FrameHeader>
				<FramePanel variant="compact" {...stylex.props(styles.detailList)}>
					{events.isLoading ? (
						<Skeleton rows={4} />
					) : events.isError ? (
						<ErrorMessage error={events.error} />
					) : items.length ? (
						<>
							{items.map((event) => (
								<EventRow key={event.id} event={event} grouped />
							))}
							{events.hasNextPage && (
								<div {...stylex.props(styles.rightActions)}>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => void events.fetchNextPage()}
									>
										Load more
									</Button>
								</div>
							)}
						</>
					) : (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No occurrences</EmptyTitle>
								<EmptyDescription>
									Nothing with this fingerprint in this project.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					)}
				</FramePanel>
			</Frame>
		</div>
	);
}
