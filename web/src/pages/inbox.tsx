import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useSearch } from "../router";
import { api } from "../api";
import { LEVELS, relative } from "../lib/events";
import { useInfiniteQuery, useQuery } from "../query";
import { styles } from "../styles";
import { inboxSearch, type InboxSearch } from "../search";
import {
  Button,
  Checkbox,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  ErrorMessage,
  Frame,
  FrameFooter,
  FramePanel,
  LevelBadge,
  ProjectIcon,
  Select,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui";

export function InboxPage() {
  const search: InboxSearch = inboxSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const events = useInfiniteQuery({
    queryKey: [
      "events",
      search.project,
      search.level,
      search.silenced,
      search.grouped,
    ],
    queryFn: ({ pageParam }) =>
      api.events({
        project: search.project,
        level: search.level,
        silenced: search.silenced,
        grouped: String(search.grouped !== false),
        before: pageParam,
        limit: "50",
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor,
    refetchInterval: 30_000,
  });
  const items = events.data?.pages.flatMap((page) => page.events) ?? [];
  const setFilter = (patch: Record<string, unknown>) =>
    void navigate({ to: "/", search: inboxSearch({ ...search, ...patch }) });
  return (
    <Stack>
      <div
        role="group"
        aria-label="Inbox filters"
        {...stylex.props(styles.filterToolbar)}
      >
        <div {...stylex.props(styles.filterFields)}>
          <div {...stylex.props(styles.filterProject)}>
            <Select
              aria-label="Project"
              size="sm"
              value={search.project ?? ""}
              onChange={(event) =>
                setFilter({ project: event.currentTarget.value || undefined })
              }
            >
              <option value="">All projects</option>
              {projects.data?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </div>
          <Select
            aria-label="Level"
            size="sm"
            value={search.level ?? ""}
            onChange={(event) =>
              setFilter({ level: event.currentTarget.value || undefined })
            }
          >
            <option value="">All levels</option>
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Visibility"
            size="sm"
            value={search.silenced ?? ""}
            onChange={(event) =>
              setFilter({ silenced: event.currentTarget.value || undefined })
            }
          >
            <option value="">All events</option>
            <option value="true">Silenced only</option>
            <option value="false">Pushed only</option>
          </Select>
        </div>
        <div {...stylex.props(styles.filterActions)}>
          <label {...stylex.props(styles.checkboxLabel)}>
            <Checkbox
              checked={search.grouped !== false}
              onCheckedChange={(grouped) => setFilter({ grouped })}
            />
            Group repeats
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void events.refetch()}
            disabled={events.isFetching}
          >
            Refresh
          </Button>
        </div>
      </div>
      {events.isError && <ErrorMessage error={events.error} />}
      <Frame>
        {events.isLoading || items.length === 0 ? (
          <FramePanel>
            {events.isLoading ? (
              <Skeleton rows={6} />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>
                    {search.silenced === "true"
                      ? "No silenced events"
                      : "No events yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {projects.data?.projects.length ? (
                      <>
                        Send one with curl or a client, or use the test button
                        in <Link to="/settings">settings</Link>.
                      </>
                    ) : (
                      <>
                        <Link to="/projects">Create a project</Link> to get an
                        API key, then send your first event.
                      </>
                    )}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </FramePanel>
        ) : (
          <Table variant="card" {...stylex.props(styles.eventTable)}>
            <colgroup>
              <col {...stylex.props(styles.eventProjectColumn)} />
              <col />
              <col {...stylex.props(styles.eventLevelColumn)} />
              <col {...stylex.props(styles.eventTimeColumn)} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Level</TableHead>
                <TableHead {...stylex.props(styles.eventTableTime)}>
                  Time
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((event) => {
                const repeats = Boolean(event.group && event.group.count > 1);
                return (
                  <TableRow key={event.id}>
                    <TableCell>
                      <div {...stylex.props(styles.eventProject)}>
                        <ProjectIcon
                          icon={event.project_icon || "circle:orange"}
                          size={14}
                        />
                        <span {...stylex.props(styles.truncate)}>
                          {event.project_name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell {...stylex.props(styles.eventTableMain)}>
                      <Link
                        to={
                          repeats
                            ? "/groups/$projectId/$fingerprint"
                            : "/events/$eventId"
                        }
                        params={
                          repeats
                            ? {
                                projectId: event.project_id,
                                fingerprint: event.fingerprint,
                              }
                            : { eventId: event.id }
                        }
                        {...stylex.props(styles.eventTableLink)}
                      >
                        <span {...stylex.props(styles.eventTableTitle)}>
                          <span {...stylex.props(styles.truncate)}>
                            {event.title}
                          </span>
                          {repeats && (
                            <span {...stylex.props(styles.count)}>
                              ×{event.group?.count}
                            </span>
                          )}
                        </span>
                        {event.body && (
                          <span {...stylex.props(styles.eventTableBody)}>
                            {event.body}
                          </span>
                        )}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <LevelBadge level={event.level} />
                      {event.silenced && (
                        <span {...stylex.props(styles.eventSilenced)}>
                          silenced
                        </span>
                      )}
                    </TableCell>
                    <TableCell {...stylex.props(styles.eventTableTime)}>
                      <time title={event.created_at}>
                        {relative(event.created_at)}
                      </time>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {events.hasNextPage && (
          <FrameFooter {...stylex.props(styles.frameActions)}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void events.fetchNextPage()}
              disabled={events.isFetchingNextPage}
            >
              {events.isFetchingNextPage ? "Loading" : "Load more"}
            </Button>
          </FrameFooter>
        )}
      </Frame>
    </Stack>
  );
}
