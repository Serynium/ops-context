import * as stylex from "@stylexjs/stylex";
import { useState } from "preact/hooks";
import type { FormEvent } from "react";
import { api, type Project, type ProjectCreated } from "../api";
import { ProjectCard } from "../components/project-card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { useMutation, useQuery, useQueryClient } from "../query";
import { styles } from "../styles";
import {
  Button,
  CardTitle,
  CodeBlock,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  ErrorMessage,
  Frame,
  FramePanel,
  Group,
  GroupSeparator,
  Input,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui";

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<ProjectCreated>();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["projects"] });
  const create = useMutation({
    mutationFn: api.createProject,
    onSuccess: async (project) => {
      setRevealed(project);
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Pick<Project, "name" | "icon" | "notify" | "min_level">>;
    }) => api.updateProject(id, patch),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: api.rotateProjectKey,
    onSuccess: setRevealed,
  });
  const remove = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (name) create.mutate({ name });
    form.reset();
  };
  return (
    <Stack>
      {projects.isError && <ErrorMessage error={projects.error} />}
      {revealed && (
        <Dialog
          open
          onOpenChange={(open) => !open && setRevealed(undefined)}
          aria-labelledby="api-key-dialog-title"
        >
          <DialogPopup onClose={() => setRevealed(undefined)}>
            <DialogHeader>
              <DialogTitle id="api-key-dialog-title">
                API key for {revealed.name}
              </DialogTitle>
              <DialogDescription>
                Copy this key now. It is shown once and only a hash is stored.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <CodeBlock code={revealed.api_key} />
              <p {...stylex.props(styles.muted)}>Send your first event:</p>
              <CodeBlock
                code={[
                  `curl ${location.origin}/api/v1/events \\`,
                  `  -H "Authorization: Bearer ${revealed.api_key}" \\`,
                  '  -H "Content-Type: application/json" \\',
                  `  -d '{"title": "Hello from ${revealed.name}", "level": "success"}'`,
                ].join("\n")}
              />
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={() => setRevealed(undefined)}>
                Done
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
      <div {...stylex.props(styles.pageToolbar)}>
        <CardTitle>Projects</CardTitle>
        <form onSubmit={submit}>
          <Group aria-label="Create project">
            <Input
              aria-label="Project name"
              name="name"
              placeholder="Project name"
              size="sm"
              maxLength={80}
              required
            />
            <GroupSeparator />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              loading={create.isPending}
            >
              Create
            </Button>
          </Group>
        </form>
      </div>
      <Frame>
        {projects.isLoading ? (
          <FramePanel>
            <Skeleton rows={4} />
          </FramePanel>
        ) : projects.data?.projects.length ? (
          <Table variant="card" {...stylex.props(styles.projectTable)}>
            <colgroup>
              <col />
              <col {...stylex.props(styles.projectNotificationsColumn)} />
              <col {...stylex.props(styles.projectCreatedColumn)} />
              <col {...stylex.props(styles.projectActionsColumn)} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Notifications</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.data.projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onPatch={(patch) =>
                    update.mutate({ id: project.id, patch })
                  }
                  onRotate={() => rotate.mutate(project.id)}
                  onDelete={() => remove.mutate(project.id)}
                />
              ))}
            </TableBody>
          </Table>
        ) : (
          <FramePanel>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  Create one above to get an API key.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </FramePanel>
        )}
      </Frame>
    </Stack>
  );
}
