import * as stylex from "@stylexjs/stylex";
import { useState } from "preact/hooks";
import type { ReactNode } from "react";
import type { Level } from "./api";

const s = stylex.create({
  page: {
    width: "100%",
    maxWidth: 720,
    marginInline: "auto",
    paddingInline: 32,
    paddingBottom: 56,
    "@media (max-width: 600px)": { paddingInline: 16 },
  },
  stack: { display: "flex", flexDirection: "column", gap: 24 },
  input: {
    width: "100%",
    minHeight: 34,
    paddingInline: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#e4e6ee",
    borderRadius: 8,
    color: "#1a1b25",
    backgroundColor: "#fdfdfe",
    outline: "none",
    fontSize: 13,
    ":focus": { borderColor: "#8b92ec" },
  },
  actions: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  notice: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#dbdff8",
    borderRadius: 10,
    paddingBlock: 12,
    paddingInline: 14,
    backgroundColor: "#eef0fb",
    color: "#5a62d4",
    lineHeight: 1.5,
  },
  noticeBad: {
    borderColor: "#c8b8ef",
    backgroundColor: "#f5f0ff",
    color: "#6a45c4",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    whiteSpace: "nowrap",
    minWidth: 76,
    fontSize: 12,
    lineHeight: 1.4,
    fontWeight: 650,
    textTransform: "capitalize",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: "currentColor",
    flexShrink: 0,
  },
  info: { color: "#8b90bd" },
  success: { color: "#5fbf9f" },
  warning: { color: "#e0912f" },
  critical: { color: "#6a45c4" },
  muted: { color: "#9c9eab" },
  status: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    whiteSpace: "nowrap",
    fontSize: 12,
    fontWeight: 650,
  },
  metrics: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 16,
    "@media (max-width: 600px)": { gridTemplateColumns: "1fr 1fr" },
  },
  metric: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
  metricLabel: { color: "#9c9eab", fontSize: 11 },
  metricValue: {
    color: "#1a1b25",
    fontSize: 24,
    lineHeight: 1.2,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  loader: {
    minHeight: 220,
    display: "grid",
    placeItems: "center",
    color: "#9c9eab",
  },
  error: { color: "#8a63e0" },
  toast: {
    position: "fixed",
    left: "50%",
    bottom: 18,
    zIndex: 30,
    transform: "translateX(-50%)",
    maxWidth: "min(520px, calc(100% - 28px))",
    borderRadius: 10,
    paddingBlock: 12,
    paddingInline: 16,
    color: "#fdfdfe",
    backgroundColor: "#17181f",
    boxShadow: "0 12px 40px rgba(23,24,31,.3)",
  },
  settingRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: 12,
    paddingBlock: 10,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: "#f0f1f5",
    ":first-child": { borderTopWidth: 0 },
    "@media (max-width: 520px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
      alignItems: "stretch",
    },
  },
  settingText: { minWidth: 0, whiteSpace: "normal" },
  settingLabel: {
    color: "#1a1b25",
    fontSize: 14,
    lineHeight: 1.3,
    fontWeight: 650,
  },
  settingHint: {
    color: "#9c9eab",
    fontSize: 11,
    lineHeight: 1.5,
    marginTop: 3,
  },
  settingControl: {
    minWidth: 0,
    justifySelf: "end",
    "@media (max-width: 520px)": { justifySelf: "stretch" },
  },
  skeletonRows: { display: "flex", flexDirection: "column" },
  skeletonRow: {
    display: "grid",
    gridTemplateColumns: "120px 1fr auto 64px",
    gap: 16,
    alignItems: "center",
    paddingBlock: 14,
    paddingInline: 16,
    "@media (max-width: 600px)": { gridTemplateColumns: "1fr 64px" },
  },
  skeletonMobileHide: { "@media (max-width: 600px)": { display: "none" } },
  skeletonMain: { display: "flex", flexDirection: "column", gap: 7 },
  skeletonBar: {
    display: "block",
    borderRadius: 3,
    backgroundColor: "#f0f1f5",
    animationName: stylex.keyframes({
      "0%": { opacity: 0.55 },
      "50%": { opacity: 1 },
      "100%": { opacity: 0.55 },
    }),
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  codeBlock: {
    backgroundColor: "#17181f",
    borderRadius: 10,
    paddingBlock: 14,
    paddingInline: 16,
    display: "flex",
    alignItems: "flex-start",
    gap: 16,
    minWidth: 0,
  },
  codeText: {
    color: "#fdfdfe",
    flexGrow: 1,
    minWidth: 0,
    overflowX: "auto",
    whiteSpace: "pre",
    fontSize: 12,
    lineHeight: 1.6,
  },
  codeWrap: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  codeCopy: {
    color: "rgba(253,253,254,.55)",
    backgroundColor: "transparent",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(253,253,254,.12)",
    borderRadius: 8,
    paddingBlock: 5,
    paddingInline: 10,
    flexShrink: 0,
    fontSize: 12,
    ":hover": { color: "#fdfdfe" },
  },
  jsonNode: { fontSize: 12, lineHeight: 1.6 },
  jsonLine: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    paddingBlock: 2,
    backgroundColor: "transparent",
    borderWidth: 0,
    textAlign: "left",
    width: "100%",
    color: "#1a1b25",
    borderRadius: 3,
    font: "inherit",
    ":hover": { backgroundColor: "#fafafc" },
  },
  jsonLeaf: { cursor: "default", ":hover": { backgroundColor: "transparent" } },
  jsonChevron: {
    color: "#b4b6c2",
    width: 10,
    display: "inline-block",
    fontSize: 10,
    transitionProperty: "transform",
    transitionDuration: "120ms",
  },
  jsonChevronOpen: { transform: "rotate(90deg)" },
  jsonKey: { color: "#6b6d7c" },
  jsonColon: { color: "#c2c4ce" },
  jsonSummary: { color: "#9c9eab" },
  jsonValue: { overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
  jsonAccent: { color: "#5a62d4" },
  icon: { display: "inline-block", verticalAlign: -3, flexShrink: 0 },
  iconPicker: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    alignItems: "flex-end",
  },
  iconPickerRow: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  iconButton: {
    width: 32,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fdfdfe",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#e4e6ee",
    borderRadius: 8,
    padding: 0,
    ":hover": { backgroundColor: "#fafafc" },
  },
  iconButtonOn: { borderColor: "#7c83e8", backgroundColor: "#eef0fb" },
  swatch: {
    width: 24,
    height: 24,
    borderRadius: 999,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "transparent",
    boxShadow: "inset 0 0 0 1px rgba(23,24,31,.06)",
    padding: 0,
  },
  swatchOn: { borderColor: "#1a1b25" },
});

export const Page = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(s.page)}>{children}</div>
);
export const Stack = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(s.stack)}>{children}</div>
);

export const Actions = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(s.actions)}>{children}</div>
);
export const Loading = () => <div {...stylex.props(s.loader)}>Loading…</div>;
export const ErrorMessage = ({ error }: { error: unknown }) => (
  <div {...stylex.props(s.notice, s.noticeBad)}>
    {error instanceof Error ? error.message : "Something went wrong"}
  </div>
);

export function LevelBadge({ level }: { level: Level }) {
  return (
    <span {...stylex.props(s.badge, s[level])}>
      <span {...stylex.props(s.dot)} />
      {level}
    </span>
  );
}
export function StatusDot({
  children,
  tone = "success",
}: {
  children: ReactNode;
  tone?: Level | "muted";
}) {
  return (
    <span {...stylex.props(s.status, s[tone])}>
      <span {...stylex.props(s.dot)} />
      {children}
    </span>
  );
}
export const Metrics = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(s.metrics)}>{children}</div>
);
export const Metric = ({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) => (
  <div {...stylex.props(s.metric)}>
    <span {...stylex.props(s.metricLabel)}>{label}</span>
    <strong {...stylex.props(s.metricValue)}>{value}</strong>
  </div>
);

export const Toast = ({ children }: { children?: ReactNode }) =>
  children ? (
    <div role="status" aria-live="polite" {...stylex.props(s.toast)}>
      {children}
    </div>
  ) : null;

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(s.settingRow)}>
      <div {...stylex.props(s.settingText)}>
        <div {...stylex.props(s.settingLabel)}>{label}</div>
        {hint && <div {...stylex.props(s.settingHint)}>{hint}</div>}
      </div>
      <div {...stylex.props(s.settingControl)}>{children}</div>
    </div>
  );
}

export function Skeleton({
  rows = 0,
  lines = 0,
}: {
  rows?: number;
  lines?: number;
}) {
  if (rows > 0)
    return (
      <div aria-hidden="true" {...stylex.props(s.skeletonRows)}>
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} {...stylex.props(s.skeletonRow)}>
            <span
              style={{ width: 90, height: 12 }}
              {...stylex.props(s.skeletonBar, s.skeletonMobileHide)}
            />
            <span {...stylex.props(s.skeletonMain)}>
              <span
                style={{ width: `${55 + ((index * 17) % 30)}%`, height: 14 }}
                {...stylex.props(s.skeletonBar)}
              />
              <span
                style={{ width: `${35 + ((index * 23) % 40)}%`, height: 11 }}
                {...stylex.props(s.skeletonBar)}
              />
            </span>
            <span
              style={{ width: 56, height: 11 }}
              {...stylex.props(s.skeletonBar, s.skeletonMobileHide)}
            />
            <span
              style={{ width: 44, height: 10 }}
              {...stylex.props(s.skeletonBar)}
            />
          </div>
        ))}
      </div>
    );
  return (
    <div aria-hidden="true" {...stylex.props(s.skeletonMain)}>
      {Array.from({ length: lines || 1 }, (_, index) => (
        <span
          key={index}
          style={{
            width: index === lines - 1 && lines > 1 ? "60%" : "100%",
            height: 12,
          }}
          {...stylex.props(s.skeletonBar)}
        />
      ))}
    </div>
  );
}

export function CodeBlock({
  code,
  copyable = true,
  wrap = false,
}: {
  code: string;
  copyable?: boolean;
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };
  return (
    <div {...stylex.props(s.codeBlock)}>
      <code {...stylex.props(s.codeText, wrap && s.codeWrap)}>{code}</code>
      {copyable && (
        <button
          type="button"
          onClick={() => void copy()}
          {...stylex.props(s.codeCopy)}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

export function JsonTree({
  value,
  name,
  depth = 0,
  initiallyOpen = depth < 1,
}: {
  value: unknown;
  name?: string;
  depth?: number;
  initiallyOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const isObject = value !== null && typeof value === "object";
  const entries: ReadonlyArray<readonly [string, unknown]> = isObject
    ? Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value as Record<string, unknown>)
    : [];
  const summary = Array.isArray(value)
    ? `[${value.length}]`
    : `{${entries.length}}`;
  const indent = { paddingLeft: depth * 16 };

  if (isObject)
    return (
      <div {...stylex.props(s.jsonNode)}>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          style={indent}
          {...stylex.props(s.jsonLine)}
        >
          <span {...stylex.props(s.jsonChevron, expanded && s.jsonChevronOpen)}>
            ▸
          </span>
          {name !== undefined && (
            <>
              <span {...stylex.props(s.jsonKey)}>{name}</span>
              <span {...stylex.props(s.jsonColon)}>:</span>
            </>
          )}
          <span {...stylex.props(s.jsonSummary)}>{summary}</span>
        </button>
        {expanded &&
          entries.map(([key, item]) => (
            <JsonTree key={key} value={item} name={key} depth={depth + 1} />
          ))}
      </div>
    );
  const rendered =
    value === null
      ? "null"
      : typeof value === "string"
        ? JSON.stringify(value)
        : String(value);
  return (
    <div style={indent} {...stylex.props(s.jsonLine, s.jsonLeaf)}>
      {name !== undefined && (
        <>
          <span aria-hidden="true" {...stylex.props(s.jsonChevron)} />
          <span {...stylex.props(s.jsonKey)}>{name}</span>
          <span {...stylex.props(s.jsonColon)}>:</span>
        </>
      )}
      <span
        {...stylex.props(
          s.jsonValue,
          (typeof value === "number" || typeof value === "boolean") &&
            s.jsonAccent,
        )}
      >
        {rendered}
      </span>
    </div>
  );
}

const ICON_SHAPES = [
  "circle",
  "ring",
  "square",
  "diamond",
  "triangle",
  "hexagon",
  "pill",
  "blob",
] as const;
const ICON_COLORS = {
  periwinkle: "#7c83e8",
  mint: "#5fbf9f",
  blush: "#e88cb0",
  amber: "#e8b34c",
  violet: "#9b7bea",
  slate: "#9c9eab",
} as const;
type IconShape = (typeof ICON_SHAPES)[number];
type IconColor = keyof typeof ICON_COLORS;

const parseIcon = (
  icon: string,
): { shape: IconShape; color: IconColor } | undefined => {
  const [shape, color] = icon.split(":");
  return ICON_SHAPES.includes(shape as IconShape) &&
    typeof color === "string" &&
    color in ICON_COLORS
    ? { shape: shape as IconShape, color: color as IconColor }
    : undefined;
};

export function ProjectIcon({
  icon,
  size = 16,
}: {
  icon: string;
  size?: number;
}) {
  const parsed = parseIcon(icon) ?? {
    shape: "circle" as const,
    color: "periwinkle" as const,
  };
  const fill = ICON_COLORS[parsed.color];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      {...stylex.props(s.icon)}
    >
      {parsed.shape === "circle" && (
        <circle cx="10" cy="10" r="8" fill={fill} />
      )}
      {parsed.shape === "ring" && (
        <circle
          cx="10"
          cy="10"
          r="6.5"
          fill="none"
          stroke={fill}
          strokeWidth="3.5"
        />
      )}
      {parsed.shape === "square" && (
        <rect x="2.5" y="2.5" width="15" height="15" rx="3" fill={fill} />
      )}
      {parsed.shape === "diamond" && (
        <rect
          x="4.5"
          y="4.5"
          width="11"
          height="11"
          rx="2"
          transform="rotate(45 10 10)"
          fill={fill}
        />
      )}
      {parsed.shape === "triangle" && (
        <path
          d="M10 2.5 L18 16.5 Q18.6 17.6 17.4 17.6 L2.6 17.6 Q1.4 17.6 2 16.5 Z"
          fill={fill}
          stroke={fill}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      )}
      {parsed.shape === "hexagon" && (
        <path
          d="M10 1.8 L17.2 6 L17.2 14 L10 18.2 L2.8 14 L2.8 6 Z"
          fill={fill}
          stroke={fill}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      )}
      {parsed.shape === "pill" && (
        <rect x="1.5" y="5.5" width="17" height="9" rx="4.5" fill={fill} />
      )}
      {parsed.shape === "blob" && (
        <path
          d="M10.5 2 C15 2 18.5 5 18 9.5 C17.6 13.5 15 18 10 18 C5.5 18 2 15 2 10.5 C2 6 6 2 10.5 2 Z"
          fill={fill}
        />
      )}
    </svg>
  );
}

export function IconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const current = parseIcon(value) ?? {
    shape: "circle" as const,
    color: "periwinkle" as const,
  };
  return (
    <div {...stylex.props(s.iconPicker)}>
      <div {...stylex.props(s.iconPickerRow)}>
        {ICON_SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            aria-label={shape}
            title={shape}
            onClick={() => onChange(`${shape}:${current.color}`)}
            {...stylex.props(
              s.iconButton,
              current.shape === shape && s.iconButtonOn,
            )}
          >
            <ProjectIcon icon={`${shape}:${current.color}`} size={18} />
          </button>
        ))}
      </div>
      <div {...stylex.props(s.iconPickerRow)}>
        {Object.entries(ICON_COLORS).map(([name, color]) => (
          <button
            key={name}
            type="button"
            aria-label={name}
            title={name}
            style={{ backgroundColor: color }}
            onClick={() => onChange(`${current.shape}:${name}`)}
            {...stylex.props(s.swatch, current.color === name && s.swatchOn)}
          />
        ))}
      </div>
    </div>
  );
}
