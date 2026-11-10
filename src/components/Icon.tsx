/** Icon set from docs/HANDOFF.md §4: 24 grid, 1.75 stroke, currentColor (class `ic`). */
const PATHS = {
  create: "M12 3l1.8 4.9L19 9.7l-5.2 1.9L12 16.5l-1.8-4.9L5 9.7l5.2-1.8z M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z",
  jobs: "M12 3 3 7.5 12 12l9-4.5L12 3z M3 12l9 4.5 9-4.5 M3 16.5 12 21l9-4.5",
  editor: "M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6 M4 16l4-4 4 4 M17 3l4 4-7 7h-4v-4z",
  automate: "M13 3 5 13h6l-1 8 8-10h-6z",
  characters: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1 M16 3.5a4 4 0 0 1 0 7 M22 21v-1a6 6 0 0 0-4-5.6",
  lock: "M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z M8 11V8a4 4 0 1 1 8 0v3",
  gpu: "M7 7h10v10H7z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4",
  gpuOffline: "M9 2v4 M15 2v4 M7 6h10v4a5 5 0 0 1-10 0z M12 15v7",
  schedule: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 20a7 7 0 0 1 14 0",
  upload: "M12 20V9 M7 14l5-5 5 5 M5 4h14",
  plus: "M12 5v14 M5 12h14",
  close: "M6 6l12 12 M18 6 6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  back: "M15 5l-7 7 7 7",
  list: "M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01",
  text: "M5 7h14 M5 12h14 M5 17h9",
  play: "M7 4v16l13-8z",
  download: "M12 4v11 M7 10l5 5 5-5 M5 20h14",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  bookmark: "M6 4h12v17l-6-4-6 4z",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
  blur: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 3v18 M16 5v14 M20 9v6",
  vault: "M4 5h16v14H4z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 9v-1 M4 9h2 M4 15h2",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  expand: "M4 9V4h5 M4 4l6 6 M20 15v5h-5 M20 20l-6-6 M15 4h5v5 M9 20H4v-5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size }: { name: IconName; size?: 16 }) {
  return (
    <svg className={size === 16 ? "ic ic-16" : "ic"} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The Locke mark (keyhole), filled. */
export function LockeMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5a3.5 3.5 0 0 0-1.6 6.6L9.5 18h5l-.9-6.4A3.5 3.5 0 0 0 12 5z" fill="currentColor" />
    </svg>
  );
}
