import * as stylex from "@stylexjs/stylex";
import { api } from "../api";
import { useMutation, useQuery, useQueryClient } from "../query";
import {
  enablePush,
  isStandalone,
  provisionExistingPushCredential,
} from "../lib/web-push";
import {
  readPushRenewalCredential,
  revokePushRenewalCredential,
} from "../push-renewal";
import { relative } from "../lib/events";
import { styles } from "../styles";
import { useUi } from "../ui-context";
import {
  Alert,
  AlertDescription,
  Button,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  ErrorMessage,
  Frame,
  FramePanel,
  Skeleton,
  Stack,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui";

export function DevicesPage() {
  const queryClient = useQueryClient();
  const { notify } = useUi();
  const devices = useQuery({
    queryKey: ["push-devices"],
    queryFn: api.pushDevices,
  });
  const currentPush = useQuery({
    queryKey: ["current-push-device"],
    queryFn: async () => {
      const supported =
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window;
      if (!supported)
        return {
          supported,
          subscribed: false,
          permission: "default" as NotificationPermission,
        };
      await provisionExistingPushCredential();
      const registration = await navigator.serviceWorker.ready;
      const [subscription, credential] = await Promise.all([
        registration.pushManager.getSubscription(),
        readPushRenewalCredential(),
      ]);
      return {
        supported,
        subscribed: Boolean(subscription),
        permission: Notification.permission,
        installationId: credential?.installation_id,
        revoked: credential?.revoked,
      };
    },
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["push-devices"] }),
      queryClient.invalidateQueries({ queryKey: ["current-push-device"] }),
    ]);
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const local = await readPushRenewalCredential();
      await api.deletePush(id);
      await revokePushRenewalCredential(id, local?.credential);
    },
    onSuccess: refresh,
  });
  const enroll = useMutation({
    mutationFn: enablePush,
    onSuccess: async () => {
      notify("Push notifications enabled");
      await refresh();
    },
    onError: (cause) =>
      notify(cause instanceof Error ? cause.message : "Push setup failed"),
  });
  const iphoneNeedsInstall =
    /iPhone|iPad|iPod/u.test(navigator.userAgent) && !isStandalone();
  const currentDevice = devices.data?.subscriptions.find(
    (device) => device.id === currentPush.data?.installationId,
  );
  const pushEnabled = Boolean(
    currentPush.data?.subscribed &&
      currentPush.data.permission === "granted" &&
      !currentPush.data.revoked &&
      currentDevice?.enabled,
  );
  const pushStatusLoading = devices.isLoading || currentPush.isLoading;
  const pushBlocked = currentPush.data?.permission === "denied";
  const pushUnavailable = currentPush.data?.supported === false;
  return (
    <Stack>
      {devices.isError && <ErrorMessage error={devices.error} />}
      <div {...stylex.props(styles.pageToolbar)}>
        <CardTitle>Push devices</CardTitle>
        <div {...stylex.props(styles.deviceEnable)}>
          <span {...stylex.props(styles.secondary)}>Enable this browser</span>
          <Button
            size="sm"
            variant={pushEnabled ? "outline" : "default"}
            loading={enroll.isPending}
            disabled={
              pushStatusLoading ||
              pushEnabled ||
              pushBlocked ||
              pushUnavailable ||
              iphoneNeedsInstall
            }
            onClick={() => enroll.mutate()}
          >
            {pushStatusLoading
              ? "Checking push"
              : pushEnabled
                ? "Push enabled"
                : pushBlocked
                  ? "Push blocked"
                  : pushUnavailable
                    ? "Push unavailable"
                    : iphoneNeedsInstall
                      ? "Install app first"
                      : "Enable push"}
          </Button>
        </div>
      </div>
      {iphoneNeedsInstall && (
        <Alert variant="warning">
          <AlertDescription>
            On iOS, open Share → Add to Home Screen, launch Flarebox from the
            icon, then enable push.
          </AlertDescription>
        </Alert>
      )}
      <Frame>
        {devices.isLoading ? (
          <FramePanel>
            <Skeleton rows={2} />
          </FramePanel>
        ) : devices.data?.subscriptions.length ? (
          <Table variant="card" {...stylex.props(styles.deviceTable)}>
            <colgroup>
              <col />
              <col {...stylex.props(styles.devicePushColumn)} />
              <col {...stylex.props(styles.deviceLastSeenColumn)} />
              <col {...stylex.props(styles.deviceActionsColumn)} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Push</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead aria-label="Actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.data.subscriptions.map((device) => (
                <TableRow key={device.id}>
                  <TableCell {...stylex.props(styles.deviceNameCell)}>
                    <div {...stylex.props(styles.truncate)}>{device.name}</div>
                    <div
                      title={`${device.endpoint_host} · paired ${relative(device.created_at)}`}
                      {...stylex.props(styles.muted, styles.truncate)}
                    >
                      {device.endpoint_host} · paired{" "}
                      {relative(device.created_at)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusDot tone={device.enabled ? "success" : "muted"}>
                      {device.enabled ? "Registered" : "Disabled"}
                    </StatusDot>
                  </TableCell>
                  <TableCell>
                    {device.last_seen_at
                      ? relative(device.last_seen_at)
                      : "Never"}
                  </TableCell>
                  <TableCell {...stylex.props(styles.deviceTableAction)}>
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      onClick={() => remove.mutate(device.id)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <FramePanel>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No devices paired</EmptyTitle>
                <EmptyDescription>
                  Enable push for this browser above to start receiving
                  notifications.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </FramePanel>
        )}
      </Frame>
    </Stack>
  );
}
