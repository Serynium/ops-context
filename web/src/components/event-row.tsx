import * as stylex from "@stylexjs/stylex";
import { Link } from "../router";
import type { EventItem } from "../api";
import { relative } from "../lib/events";
import { styles } from "../styles";
import { LevelBadge, ProjectIcon } from "./ui";

export function EventRow({
  event,
  grouped = false,
}: {
  event: EventItem;
  grouped?: boolean;
}) {
  const repeats = !grouped && event.group && event.group.count > 1;
  return (
    <Link
      to={repeats ? "/groups/$projectId/$fingerprint" : "/events/$eventId"}
      params={
        repeats
          ? { projectId: event.project_id, fingerprint: event.fingerprint }
          : { eventId: event.id }
      }
      {...stylex.props(styles.eventRow, grouped && styles.groupEventRow)}
    >
      {!grouped && (
        <div {...stylex.props(styles.eventProject)}>
          <ProjectIcon
            icon={event.project_icon || "circle:periwinkle"}
            size={14}
          />
          <span {...stylex.props(styles.truncate)}>{event.project_name}</span>
        </div>
      )}
      <div {...stylex.props(styles.eventMain)}>
        <div {...stylex.props(styles.eventTitle)}>
          <span {...stylex.props(styles.truncate)}>{event.title}</span>
          {repeats && (
            <span {...stylex.props(styles.count)}>×{event.group?.count}</span>
          )}
        </div>
        {event.body && (
          <div {...stylex.props(styles.eventBody)}>{event.body}</div>
        )}
      </div>
      <div {...stylex.props(styles.eventLevel)}>
        <LevelBadge level={event.level} />
        {event.silenced && <div {...stylex.props(styles.muted)}>silenced</div>}
      </div>
      <time title={event.created_at} {...stylex.props(styles.eventTime)}>
        {relative(event.created_at)}
      </time>
    </Link>
  );
}
