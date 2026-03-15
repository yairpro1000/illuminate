export const COLOR_PALETTE: string[] = [
  "#ff3b30",
  "#ff9500",
  "#ffcc00",
  "#a8e600",
  "#34c759",
  "#00c853",
  "#00c7be",
  "#32ade6",
  "#007aff",
  "#0057ff",
  "#5856d6",
  "#af52de",
  "#ff2d55",
  "#ff375f",
  "#ff00ff",
];

export const STATUS_OPTIONS = ["todo", "in_progress", "on_hold", "done"] as const;
export type StatusValue = (typeof STATUS_OPTIONS)[number];

export const STATUS_STYLE: Record<StatusValue, { label: string; bg: string; fg: string; border: string }> =
  {
    todo: {
      label: "Todo",
      bg: "var(--color-bg-alt)",
      fg: "var(--color-text)",
      border: "var(--color-border)",
    },
    in_progress: {
      label: "In progress",
      bg: "var(--color-accent-bg)",
      fg: "var(--color-text)",
      border: "var(--color-accent-border)",
    },
    on_hold: {
      label: "On hold",
      bg: "var(--color-warning-bg)",
      fg: "var(--color-text)",
      border: "var(--color-warning-border)",
    },
    done: {
      label: "Done",
      bg: "var(--color-ok-bg)",
      fg: "var(--color-text)",
      border: "var(--color-ok-border)",
    },
  };
