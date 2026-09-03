import * as stylex from "@stylexjs/stylex";
import { useState } from "preact/hooks";
import type { FormEvent } from "react";
import { api, type Silence } from "../api";
import { Fact } from "../components/fact";
import { relative } from "../lib/events";
import { useMutation, useQuery, useQueryClient } from "../query";
import { styles } from "../styles";
import {
  Alert,
  AlertDescription,
  Button,
  ErrorMessage,
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
  Group,
  GroupSeparator,
  Input,
  Loading,
  Metric,
  Metrics,
  Select,
  SettingRow,
  Skeleton,
  Stack,
  StatusDot,
  Switch,
} from "../components/ui";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const silences = useQuery({ queryKey: ["silences"], queryFn: api.silences });
  const [testResult, setTestResult] = useState("");
  const [newKey, setNewKey] = useState("");
  const refreshSettings = () =>
    queryClient.invalidateQueries({ queryKey: ["settings"] });
  const refreshSilences = () =>
    queryClient.invalidateQueries({ queryKey: ["silences"] });
  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: refreshSettings,
  });
  const test = useMutation({
    mutationFn: api.test,
    onSuccess: async () => {
      setTestResult("Test event queued.");
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
  const createSilence = useMutation({
    mutationFn: api.createSilence,
    onSuccess: refreshSilences,
  });
  const removeSilence = useMutation({
    mutationFn: api.deleteSilence,
    onSuccess: refreshSilences,
  });
  if (settings.isLoading || status.isLoading)
    return (
      <Frame>
        <FramePanel>
          <Skeleton rows={6} />
        </FramePanel>
      </Frame>
    );
  if (settings.isError) return <ErrorMessage error={settings.error} />;
  if (status.isError) return <ErrorMessage error={status.error} />;
  if (!settings.data || !status.data) return <Loading />;
  const addSilence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const projectId = String(data.get("project_id") ?? "");
    createSilence.mutate({
      field: String(data.get("field")) as Silence["field"],
      value: String(data.get("value") ?? "").trim(),
      ...(projectId ? { project_id: projectId } : {}),
      note: String(data.get("note") ?? "").trim(),
    });
    form.reset();
  };
  const addKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = newKey.trim();
    if (key) save.mutate({ redact_keys: [...settings.data!.redact_keys, key] });
    setNewKey("");
  };
  return (
    <Stack>
      <Frame>
        <FrameHeader>
          <FrameTitle>Overview</FrameTitle>
        </FrameHeader>
        <FramePanel>
          <Metrics>
            <Metric
              label="Events"
              value={new Intl.NumberFormat(undefined, {
                notation: "compact",
              }).format(status.data.events)}
            />
            <Metric label="Projects" value={status.data.projects} />
            <Metric label="Devices" value={status.data.subscriptions} />
            <Metric
              label="Enabled devices"
              value={status.data.enabled_subscriptions}
            />
          </Metrics>
          <div
            {...stylex.props(styles.statusGrid, styles.settingsOverviewDetails)}
          >
            <Fact label="Server" value={<StatusDot>Healthy</StatusDot>} />
            <Fact label="Database" value={<StatusDot>Healthy</StatusDot>} />
            <Fact
              label="Web Push"
              value={
                status.data.web_push.configured ? (
                  <StatusDot>Configured</StatusDot>
                ) : (
                  <StatusDot tone="warning">Not configured</StatusDot>
                )
              }
            />
            <Fact
              label="Push subject"
              value={status.data.web_push.subject || "—"}
            />
            <Fact
              label="Last push"
              value={
                status.data.last_push ? (
                  <StatusDot
                    tone={
                      status.data.last_push.status === "failed"
                        ? "error"
                        : "success"
                    }
                  >
                    {status.data.last_push.status} ·{" "}
                    {relative(status.data.last_push.attempted_at)}
                  </StatusDot>
                ) : (
                  "None yet"
                )
              }
            />
            <Fact label="Version" value={status.data.version} />
            <Fact label="Base URL" value={status.data.base_url} />
            <Fact
              label="Retention"
              value={
                settings.data.retention_days
                  ? `${settings.data.retention_days} days`
                  : "Unlimited"
              }
            />
            <Fact
              label="Admin login"
              value={<StatusDot>Cloudflare Access</StatusDot>}
            />
          </div>
          {!status.data.web_push.configured && (
            <Alert variant="warning">
              <AlertDescription>
                Pushes are stored but not sent. Configure the Web Push VAPID
                environment variables and redeploy Ops Context.
              </AlertDescription>
            </Alert>
          )}
        </FramePanel>
      </Frame>
      <Frame>
        <FrameHeader>
          <FrameTitle>Settings</FrameTitle>
        </FrameHeader>
        <FramePanel>
          <SettingRow
            label="Keep events for"
            hint="Older events are deleted automatically. Unlimited keeps everything."
          >
            <Select
              value={String(settings.data.retention_days)}
              onChange={(event) =>
                save.mutate({
                  retention_days: Number(event.currentTarget.value),
                })
              }
              aria-label="Retention"
            >
              {[7, 14, 30, 90].map((days) => (
                <option key={days} value={String(days)}>
                  {days} days
                </option>
              ))}
              <option value="0">Unlimited</option>
            </Select>
          </SettingRow>
          <SettingRow
            label="MCP endpoint"
            hint={
              settings.data.mcp_access_configured
                ? `Protected by Cloudflare Access · ${status.data.base_url}/mcp`
                : "Configure the dedicated MCP hostname and Access audience."
            }
          >
            <Switch
              checked={settings.data.mcp_enabled}
              onCheckedChange={(mcp_enabled) => save.mutate({ mcp_enabled })}
              aria-label="MCP endpoint"
            />
          </SettingRow>
        </FramePanel>
      </Frame>
      <Frame>
        <FrameHeader>
          <FrameTitle>Silences</FrameTitle>
          <FrameDescription>
            Events matching a rule are still stored and shown, but never pushed.
            Fingerprint and source match exactly; title ignores case.
          </FrameDescription>
        </FrameHeader>
        <FramePanel>
          <p>
            <a href="/?silenced=true" {...stylex.props(styles.link)}>
              {silences.data?.silenced_events ?? 0} silenced event
              {silences.data?.silenced_events === 1 ? "" : "s"}
            </a>{" "}
            · open one to unsilence it or push it now.
          </p>
          {silences.data?.silences.length ? (
            silences.data.silences.map((silence) => (
              <div key={silence.id} {...stylex.props(styles.silenceRow)}>
                <div {...stylex.props(styles.row)}>
                  <span {...stylex.props(styles.pill, styles.pillAccent)}>
                    {silence.field}
                  </span>
                  <span {...stylex.props(styles.mono)}>{silence.value}</span>
                  <span {...stylex.props(styles.muted)}>
                    · {silence.project_name || "every project"}
                    {silence.note ? ` · ${silence.note}` : ""} ·{" "}
                    {relative(silence.created_at)}
                  </span>
                </div>
                <Button
                  variant="destructive-outline"
                  size="sm"
                  onClick={() => removeSilence.mutate(silence.id)}
                >
                  Remove
                </Button>
              </div>
            ))
          ) : (
            <p {...stylex.props(styles.muted)}>No silences.</p>
          )}
          <form onSubmit={addSilence} {...stylex.props(styles.silenceForm)}>
            <Select
              name="field"
              aria-label="Field"
              defaultValue="title"
            >
              <option value="title">Title</option>
              <option value="fingerprint">Fingerprint</option>
              <option value="source">Source</option>
            </Select>
            <div {...stylex.props(styles.grow)}>
              <Input
                name="value"
                placeholder="Value to match"
                aria-label="Value"
                required
              />
            </div>
            <Select
              name="project_id"
              aria-label="Project"
              defaultValue=""
            >
              <option value="">Every project</option>
              {projects.data?.projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
            <Input
              name="note"
              placeholder="Note (optional)"
              aria-label="Note"
            />
            <Button variant="outline" type="submit">
              Add
            </Button>
          </form>
        </FramePanel>
      </Frame>
      <Frame>
        <FrameHeader>
          <FrameTitle>Redaction</FrameTitle>
          <FrameDescription>
            Values under these keys are replaced with [REDACTED] anywhere in
            event data before it is stored. Matching ignores case and treats -
            and _ the same.
          </FrameDescription>
        </FrameHeader>
        <FramePanel {...stylex.props(styles.settingsPanel)}>
          <div {...stylex.props(styles.pillList, styles.settingsPillList)}>
            {settings.data.default_redact_keys.map((key) => (
              <span key={key} {...stylex.props(styles.pill)}>
                {key}
              </span>
            ))}
            {settings.data.redact_keys.map((key) => (
              <span key={key} {...stylex.props(styles.pill, styles.pillAccent)}>
                {key}
                <button
                  type="button"
                  aria-label={`Remove ${key}`}
                  onClick={() =>
                    save.mutate({
                      redact_keys: settings.data!.redact_keys.filter(
                        (item) => item !== key,
                      ),
                    })
                  }
                  {...stylex.props(styles.pillButton)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <form onSubmit={addKey}>
            <Group aria-label="Add redaction key">
              <Input
                value={newKey}
                onChange={(event) => setNewKey(event.currentTarget.value)}
                placeholder="Add a key, e.g. ssn"
                aria-label="Redaction key"
              />
              <GroupSeparator />
              <Button
                variant="outline"
                type="submit"
                disabled={!newKey.trim()}
              >
                Add
              </Button>
            </Group>
          </form>
        </FramePanel>
      </Frame>
      <Frame>
        <FrameHeader>
          <FrameTitle>Test notification</FrameTitle>
          <FrameDescription>
            Creates a sample event with an action and structured data, then
            pushes it to every enabled browser.
          </FrameDescription>
        </FrameHeader>
        <FramePanel {...stylex.props(styles.settingsPanel)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const projectId = String(
                new FormData(event.currentTarget).get("project_id") ?? "",
              );
              test.mutate(projectId || undefined);
            }}
          >
            <Group aria-label="Send test notification">
              <Select
                name="project_id"
                aria-label="Project"
                size="sm"
              >
                {projects.data?.projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
              <GroupSeparator />
              <Button
                size="sm"
                type="submit"
                disabled={test.isPending || !projects.data?.projects.length}
              >
                {test.isPending ? "Sending" : "Send test"}
              </Button>
            </Group>
          </form>
          {testResult && (
            <Alert variant="success">
              <AlertDescription>{testResult}</AlertDescription>
            </Alert>
          )}
        </FramePanel>
      </Frame>
    </Stack>
  );
}
