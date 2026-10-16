const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const MicIcon = () => (
  <svg viewBox="0 0 24 24" {...s} aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
export const StopIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>
);
export const ChartIcon = () => (
  <svg viewBox="0 0 24 24" {...s} aria-hidden><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
);
export const GearIcon = () => (
  <svg viewBox="0 0 24 24" {...s} aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const HeadphonesIcon = () => (
  <svg viewBox="0 0 24 24" {...s} aria-hidden><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" /></svg>
);
export const SkipIcon = () => (
  <svg viewBox="0 0 24 24" {...s} aria-hidden><path d="M5 4l10 8-10 8zM19 5v14" /></svg>
);
export const SpeakerIcon = () => (
  <svg viewBox="0 0 24 24" {...s} aria-hidden><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></svg>
);
export const BackIcon = () => (
  <svg viewBox="0 0 24 24" {...s} aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
);
export const CloseIcon = () => (
  <svg viewBox="0 0 24 24" {...s} aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
);
