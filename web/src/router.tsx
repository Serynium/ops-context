import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "preact/hooks";
import { createContext } from "./context";
import { Loading } from "./ui";

type Params = Record<string, string>;
type RouteState = { pathname: string; search: string; params: Params };

function lazyPage(load: () => Promise<ComponentType>) {
  let Component: ComponentType | undefined;
  let error: unknown;
  let promise: Promise<void> | undefined;
  return function LazyPage() {
    const [, render] = useState(0);
    useEffect(() => {
      let active = true;
      promise ??= load().then(
        (component) => {
          Component = component;
        },
        (cause) => {
          error = cause;
        },
      );
      void promise.then(() => active && render(1));
      return () => {
        active = false;
      };
    }, []);
    if (error) throw error;
    return Component ? <Component /> : <Loading />;
  };
}

const InboxPage = lazyPage(() =>
  import("./pages/inbox").then(({ InboxPage }) => InboxPage),
);
const EventDetailPage = lazyPage(() =>
  import("./pages/event-detail").then(({ EventDetailPage }) => EventDetailPage),
);
const GroupPage = lazyPage(() =>
  import("./pages/group").then(({ GroupPage }) => GroupPage),
);
const ProjectsPage = lazyPage(() =>
  import("./pages/projects").then(({ ProjectsPage }) => ProjectsPage),
);
const DevicesPage = lazyPage(() =>
  import("./pages/devices").then(({ DevicesPage }) => DevicesPage),
);
const SettingsPage = lazyPage(() =>
  import("./pages/settings").then(({ SettingsPage }) => SettingsPage),
);

const RouterContext = createContext<RouteState | null>(null);

const decode = (value: string | undefined) => {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    return value ?? "";
  }
};

export function matchRoute(pathname: string) {
  const event = pathname.match(/^\/events\/([^/]+)$/);
  if (event)
    return { component: EventDetailPage, params: { eventId: decode(event[1]) } };
  const group = pathname.match(/^\/groups\/([^/]+)\/([^/]+)$/);
  if (group)
    return {
      component: GroupPage,
      params: {
        projectId: decode(group[1]),
        fingerprint: decode(group[2]),
      },
    };
  if (pathname === "/projects") return { component: ProjectsPage, params: {} };
  if (pathname === "/devices") return { component: DevicesPage, params: {} };
  if (pathname === "/settings") return { component: SettingsPage, params: {} };
  if (pathname === "/") return { component: InboxPage, params: {} };
  return null;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }));
  useEffect(() => {
    const update = () =>
      setLocation({
        pathname: window.location.pathname,
        search: window.location.search,
      });
    window.addEventListener("popstate", update);
    if (window.location.pathname === "/push")
      history.replaceState(null, "", "/devices");
    if (window.location.pathname === "/silences")
      history.replaceState(null, "", "/settings");
    update();
    return () => window.removeEventListener("popstate", update);
  }, []);
  const matched = matchRoute(location.pathname);
  return (
    <RouterContext.Provider
      value={{ ...location, params: matched?.params ?? {} }}
    >
      {children}
    </RouterContext.Provider>
  );
}

const useRouter = () => {
  const value = useContext(RouterContext);
  if (!value) throw new Error("RouterProvider is missing");
  return value;
};

export function Outlet() {
  const { pathname } = useRouter();
  const matched = matchRoute(pathname);
  if (!matched) return <p>Page not found.</p>;
  const Component = matched.component;
  return <Component />;
}

export const hrefFor = (
  to: string,
  params: Record<string, string | undefined> = {},
) =>
  to.replace(/\$([A-Za-z0-9_]+)/g, (_, key: string) =>
    encodeURIComponent(params[key] ?? ""),
  );

export function Link({
  to,
  params,
  onClick,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to: string;
  params?: Record<string, string | undefined>;
}) {
  const href = hrefFor(to, params);
  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        history.pushState(null, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    />
  );
}

export const useParams = (_options?: unknown) => useRouter().params;

export const useSearch = (_options?: unknown) => {
  const { search } = useRouter();
  return useMemo(
    () => Object.fromEntries(new URLSearchParams(search)),
    [search],
  );
};

export const useNavigate = () => {
  useRouter();
  return useCallback(
    ({
      to,
      search,
    }: {
      to: string;
      search?: Record<string, unknown>;
    }) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(search ?? {}))
        if (value !== undefined) query.set(key, String(value));
      const href = `${to}${query.size ? `?${query}` : ""}`;
      history.pushState(null, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [],
  );
};

export const useRouterState = <T,>({
  select,
}: {
  select: (state: { location: RouteState }) => T;
}) => select({ location: useRouter() });
