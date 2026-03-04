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
      bg: "rgba(170, 179, 214, 0.16)",
      fg: "var(--text)",
      border: "rgba(170, 179, 214, 0.28)",
    },
    in_progress: {
      label: "In progress",
      bg: "rgba(122, 162, 255, 0.18)",
      fg: "var(--text)",
      border: "rgba(122, 162, 255, 0.35)",
    },
    on_hold: {
      label: "On hold",
      bg: "rgba(255, 204, 0, 0.18)",
      fg: "var(--text)",
      border: "rgba(255, 204, 0, 0.32)",
    },
    done: {
      label: "Done",
      bg: "rgba(73, 210, 140, 0.18)",
      fg: "var(--text)",
      border: "rgba(73, 210, 140, 0.35)",
    },
  };

