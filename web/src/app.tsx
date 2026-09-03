import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { provisionExistingPushCredential } from "./lib/web-push";
import { Button } from "./components/ui/button";
import { useQuery } from "./query";
import { Link, Outlet, useRouterState } from "./router";
import { styles } from "./styles";
import { UiContext } from "./ui-context";
import { Page, StatusDot, Toast } from "./ui";

interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

export function RootLayout() {
  const [toast, setToast] = useState("");
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent>();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: 60_000,
  });
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(
      () => setToast((current) => (current === message ? "" : current)),
      3_200,
    );
  };
  useEffect(() => {
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const pushMessage = (event: MessageEvent) => {
      if (event.data?.type === "push-renewal-failed")
        notify(
          "Push renewal failed. Open Devices and enable this browser again.",
        );
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then(() => navigator.serviceWorker.ready)
        .then(() => provisionExistingPushCredential())
        .catch((cause) =>
          notify(cause instanceof Error ? cause.message : "Push setup failed"),
        );
      navigator.serviceWorker.addEventListener("message", pushMessage);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      navigator.serviceWorker?.removeEventListener("message", pushMessage);
    };
  }, []);
  const tabs = [
    ["Inbox", "/"],
    ["Projects", "/projects"],
    ["Devices", "/devices"],
    ["Settings", "/settings"],
  ] as const;
  const active =
    pathname.startsWith("/events/") || pathname.startsWith("/groups/")
      ? "/"
      : pathname;
  return (
    <UiContext.Provider value={{ notify }}>
      <Page>
        <header {...stylex.props(styles.header)}>
          <Link to="/" {...stylex.props(styles.brand)}>
            <span {...stylex.props(styles.mark)}>
              <span {...stylex.props(styles.markInner)} />
            </span>
            <span {...stylex.props(styles.wordmark)}>Ops Context</span>
          </Link>
          <div {...stylex.props(styles.headerRight)}>
            <div {...stylex.props(styles.desktopOnly)}>
              {status.isError ? (
                <StatusDot tone="error">Server unavailable</StatusDot>
              ) : status.data?.web_push.configured ? (
                <StatusDot>Push ready</StatusDot>
              ) : (
                <StatusDot tone="warning">Push not configured</StatusDot>
              )}
            </div>
            {installPrompt && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await installPrompt.prompt();
                  await installPrompt.userChoice;
                  setInstallPrompt(undefined);
                }}
              >
                Install
              </Button>
            )}
          </div>
        </header>
        <nav aria-label="Primary navigation" {...stylex.props(styles.tabsNav)}>
          <div {...stylex.props(styles.navLinks)}>
            {tabs.map(([label, href]) => (
              <Link
                key={href}
                to={href}
                aria-current={active === href ? "page" : undefined}
                {...stylex.props(
                  styles.navLink,
                  active === href && styles.navLinkActive,
                )}
              >
                {label}
              </Link>
            ))}
          </div>
        </nav>
        <main>
          <Outlet />
        </main>
        <footer {...stylex.props(styles.footer)}>
          Ops Context · self-hosted ·{" "}
          <Link to="/settings" {...stylex.props(styles.link)}>
            status
          </Link>
        </footer>
        <Toast>{toast}</Toast>
      </Page>
    </UiContext.Provider>
  );
}
