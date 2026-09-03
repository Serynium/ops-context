import * as stylex from "@stylexjs/stylex";
import { useState } from "preact/hooks";
import type { Project } from "../api";
import { LEVELS, relative } from "../lib/events";
import { styles } from "../styles";
import {
  Actions,
  Button,
  IconPicker,
  Input,
  ProjectIcon,
  Select,
  SettingRow,
  Switch,
  TableCell,
  TableRow,
} from "./ui";

export function ProjectCard({
  project,
  onPatch,
  onRotate,
  onDelete,
}: {
  project: Project;
  onPatch: (
    patch: Partial<Pick<Project, "name" | "icon" | "notify" | "min_level">>,
  ) => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <>
      <TableRow>
        <TableCell>
          <div {...stylex.props(styles.projectHead)}>
            <ProjectIcon
              icon={project.icon || "circle:orange"}
              size={20}
            />
            <div {...stylex.props(styles.projectText)}>
              <div {...stylex.props(styles.projectName)}>
                <span {...stylex.props(styles.truncate)}>{project.name}</span>
                <span {...stylex.props(styles.muted, styles.mono)}>
                  {project.slug}
                </span>
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell>
          {project.notify ? `≥ ${project.min_level}` : "Off"}
        </TableCell>
        <TableCell>
          <time title={project.created_at}>{relative(project.created_at)}</time>
        </TableCell>
        <TableCell {...stylex.props(styles.projectTableAction)}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={editing}
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? "Close" : "Settings"}
          </Button>
        </TableCell>
      </TableRow>
      {editing && (
        <TableRow hoverable={false}>
          <TableCell colSpan={4} {...stylex.props(styles.projectSettingsCell)}>
            <SettingRow label="Name">
              <Input
                defaultValue={project.name}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (name && name !== project.name) onPatch({ name });
                }}
                style={{ width: 200 }}
              />
            </SettingRow>
            <SettingRow
              label="Icon"
              hint="An abstract shape from the palette, shown next to the project name in the inbox and in notifications."
            >
              <IconPicker
                value={project.icon || "circle:orange"}
                onChange={(icon) => onPatch({ icon })}
              />
            </SettingRow>
            <SettingRow
              label="Push notifications"
              hint="Turn off to store events without notifying your browsers."
            >
              <Switch
                checked={project.notify}
                onCheckedChange={(notify) => onPatch({ notify })}
                aria-label="Push notifications"
              />
            </SettingRow>
            <SettingRow
              label="Minimum level"
              hint="Only events at or above this level trigger a push."
            >
              <Select
                value={project.min_level}
                onChange={(event) =>
                  onPatch({
                    min_level: event.currentTarget
                      .value as Project["min_level"],
                  })
                }
                aria-label="Minimum level"
              >
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
            </SettingRow>
            <SettingRow
              label="API key"
              hint="Rotating immediately invalidates the current key."
            >
              <Button variant="outline" size="sm" onClick={onRotate}>
                Rotate key
              </Button>
            </SettingRow>
            <SettingRow
              label="Delete project"
              hint="Removes the project and every event it received."
            >
              {confirmDelete ? (
                <Actions>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    onClick={onDelete}
                  >
                    Confirm delete
                  </Button>
                </Actions>
              ) : (
                <Button
                  variant="destructive-outline"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              )}
            </SettingRow>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
