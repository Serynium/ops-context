import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "preact/hooks";
import type { ReactNode } from "react";
import { createContext } from "./context";

type QueryKey = readonly unknown[];
type QueryOptions<T> = {
  queryKey: QueryKey;
  queryFn: () => Promise<T>;
  refetchInterval?: number;
};
type Entry<T = unknown> = {
  key: QueryKey;
  data?: T;
  error?: unknown;
  fetching: boolean;
  updatedAt: number;
  version: number;
  promise: Promise<void> | undefined;
  queryFn?: () => Promise<T>;
  listeners: Set<() => void>;
};

const hash = (key: QueryKey) => JSON.stringify(key);
export const matchesKey = (key: QueryKey, prefix: QueryKey) =>
  prefix.every((part, index) => Object.is(key[index], part));

export async function withRetry<T>(fn: () => Promise<T>, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries) throw error;
    }
  }
}

export class QueryClient {
  // ponytail: session cache has no eviction; add an LRU if key cardinality grows.
  private entries = new Map<string, Entry>();
  readonly staleTime: number;
  readonly retries: number;

  constructor(options?: {
    defaultOptions?: { queries?: { staleTime?: number; retry?: number } };
  }) {
    this.staleTime = options?.defaultOptions?.queries?.staleTime ?? 0;
    this.retries = options?.defaultOptions?.queries?.retry ?? 0;
  }

  entry<T>(key: QueryKey) {
    const id = hash(key);
    let entry = this.entries.get(id) as Entry<T> | undefined;
    if (!entry) {
      entry = {
        key,
        fetching: true,
        updatedAt: 0,
        version: 0,
        promise: undefined,
        listeners: new Set(),
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  notify(entry: Entry) {
    entry.version++;
    entry.listeners.forEach((listener) => listener());
  }

  fetch<T>(entry: Entry<T>, force = false) {
    if (entry.promise) return entry.promise;
    if (
      !force &&
      entry.data !== undefined &&
      Date.now() - entry.updatedAt < this.staleTime
    )
      return Promise.resolve();
    entry.fetching = true;
    this.notify(entry);
    entry.promise = withRetry(entry.queryFn!, this.retries)
      .then((data) => {
        entry.data = data;
        entry.error = undefined;
        entry.updatedAt = Date.now();
      })
      .catch((error) => {
        entry.error = error;
      })
      .finally(() => {
        entry.fetching = false;
        entry.promise = undefined;
        this.notify(entry);
      });
    return entry.promise;
  }

  async invalidateQueries({ queryKey }: { queryKey: QueryKey }) {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => matchesKey(entry.key, queryKey))
        .map((entry) => {
          entry.updatedAt = 0;
          return entry.queryFn ? this.fetch(entry, true) : Promise.resolve();
        }),
    );
  }
}

const QueryContext = createContext<QueryClient | null>(null);

export function QueryClientProvider({
  client,
  children,
}: {
  client: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryContext.Provider value={client}>{children}</QueryContext.Provider>
  );
}

export function useQueryClient() {
  const client = useContext(QueryContext);
  if (!client) throw new Error("QueryClientProvider is missing");
  return client;
}

export function useQuery<T>({
  queryKey,
  queryFn,
  refetchInterval,
}: QueryOptions<T>) {
  const client = useQueryClient();
  const id = hash(queryKey);
  const entry = client.entry<T>(queryKey);
  const [, render] = useState(entry.version);
  useEffect(() => {
    const listener = () => render(entry.version);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }, [entry]);
  entry.queryFn = queryFn;
  useEffect(() => {
    void client.fetch(entry);
    if (!refetchInterval) return;
    const timer = window.setInterval(
      () => void client.fetch(entry, true),
      refetchInterval,
    );
    return () => window.clearInterval(timer);
  }, [client, entry, id, refetchInterval]);
  return {
    data: entry.data,
    error: entry.error,
    isLoading: entry.data === undefined && entry.fetching,
    isError: entry.error !== undefined,
    isFetching: entry.fetching,
    refetch: () => client.fetch(entry, true),
  };
}

export function useMutation<TData, TVariables = void>({
  mutationFn,
  onSuccess,
  onError,
}: {
  mutationFn: (variables: TVariables) => Promise<TData>;
  onSuccess?: (data: TData) => void | Promise<unknown>;
  onError?: (error: unknown) => void;
}) {
  const [pending, setPending] = useState(0);
  return {
    isPending: pending > 0,
    mutate: (variables: TVariables) => {
      setPending((count) => count + 1);
      void mutationFn(variables)
        .then(onSuccess)
        .catch(onError)
        .finally(() => setPending((count) => count - 1));
    },
  };
}

export function useInfiniteQuery<TPage, TPageParam>({
  queryKey,
  queryFn,
  initialPageParam,
  getNextPageParam,
  refetchInterval,
}: {
  queryKey: QueryKey;
  queryFn: (context: { pageParam: TPageParam }) => Promise<TPage>;
  initialPageParam: TPageParam;
  getNextPageParam: (lastPage: TPage) => TPageParam | undefined;
  refetchInterval?: number;
}) {
  const client = useQueryClient();
  const id = hash(queryKey);
  const cache = client.entry<{ pages: TPage[] }>(["infinite", ...queryKey]);
  const generation = useRef(0);
  const activeId = useRef(id);
  const pages = useRef<TPage[]>(cache.data?.pages ?? []);
  const [state, setState] = useState({
    pages: pages.current,
    error: undefined as unknown,
    loading: cache.data === undefined,
    fetching: true,
    fetchingNext: false,
  });
  const load = useCallback(
    async (pageParam: TPageParam, append: boolean) => {
      const current = generation.current;
      setState((value) => ({
        ...value,
        fetching: true,
        fetchingNext: append,
        ...(!append
          ? { loading: cache.data === undefined, error: undefined }
          : {}),
      }));
      try {
        const page = await withRetry(() => queryFn({ pageParam }));
        if (current !== generation.current) return;
        pages.current = append ? [...pages.current, page] : [page];
        cache.data = { pages: pages.current };
        cache.updatedAt = Date.now();
        setState({
          pages: pages.current,
          error: undefined,
          loading: false,
          fetching: false,
          fetchingNext: false,
        });
      } catch (error) {
        if (current !== generation.current) return;
        setState((value) => ({
          ...value,
          error,
          loading: false,
          fetching: false,
          fetchingNext: false,
        }));
      }
    },
    [cache, queryFn],
  );
  const refetch = useCallback(() => {
    generation.current++;
    return load(initialPageParam, false);
  }, [initialPageParam, load]);
  useEffect(() => {
    if (activeId.current !== id) {
      activeId.current = id;
      pages.current = cache.data?.pages ?? [];
      setState({
        pages: pages.current,
        error: undefined,
        loading: cache.data === undefined,
        fetching: true,
        fetchingNext: false,
      });
    }
    void refetch();
    if (!refetchInterval) return;
    const timer = window.setInterval(() => void refetch(), refetchInterval);
    return () => window.clearInterval(timer);
  }, [id, refetchInterval]);
  const nextPage = state.pages.length
    ? getNextPageParam(state.pages.at(-1)!)
    : undefined;
  return {
    data: state.pages.length ? { pages: state.pages } : undefined,
    error: state.error,
    isLoading: state.loading,
    isError: state.error !== undefined,
    isFetching: state.fetching,
    isFetchingNextPage: state.fetchingNext,
    hasNextPage: nextPage !== undefined,
    refetch,
    fetchNextPage: () =>
      nextPage === undefined ? Promise.resolve() : load(nextPage, true),
  };
}
