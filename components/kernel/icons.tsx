import type { ReactNode, SVGProps } from "react";

/**
 * Hikmah's functional line icons. 24-unit grid, 1.65px rounded strokes.
 * Use at 18–24px. Decorative beside text by default; supply label when standalone.
 * Controls still need their own accessible names, e.g. <button aria-label="Attach file">.
 */
export type HikmahIconName =
  | "agent" | "terminal" | "browser" | "voice" | "search"
  | "orbit"
  | "conversation"
  | "compose"
  | "artifact"
  | "attachment"
  | "tools"
  | "send"
  | "preview"
  | "workspaceAdmin"
  | "ownerAdmin"
  | "compare"
  | "learning"
  | "menu"
  | "close";

const paths: Record<HikmahIconName, ReactNode> = {
  orbit: (<><path d="M5 5v14M19 5v14M5 12h14" strokeWidth="3"/><path d="m9 5 3-3 3 3m-6 14 3 3 3-3" strokeWidth="1.8"/></>),
  agent: (<><rect x="4" y="7" width="16" height="13" rx="5"/><path d="M12 3v4m-4 6h.01M16 13h.01M9 17h6"/><circle cx="12" cy="3" r="1"/></>),
  terminal: (<><rect x="3" y="4" width="18" height="16" rx="4"/><path d="m7 9 3 3-3 3m6 0h4"/></>),
  browser: (<><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01m0 7 5-2-2 5-1-2-2-1Z"/></>),
  voice: (<><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6"/></>),
  search: (<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M8 10.5h5m-2.5-2.5v5"/></>),
  conversation: (
    <path d="M7 4.5h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 3v-13a3 3 0 0 1 3-3Z" />
  ),
  compose: (
    <>
      <path d="M11 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4" />
      <path d="m11 13 1-4 6-6a2.12 2.12 0 0 1 3 3l-6 6-4 1Zm5-8 3 3" />
    </>
  ),
  artifact: (
    <>
      <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="3" />
      <path d="m8 9-3 3 3 3m8-6 3 3-3 3m-3-7-2 8" />
    </>
  ),
  attachment: (
    <path d="m8.8 12.9 6-6a2.2 2.2 0 0 1 3.1 3.1l-7.4 7.4a4.1 4.1 0 0 1-5.8-5.8l8.5-8.5a2.2 2.2 0 0 1 3.1 3.1l-8.5 8.5" />
  ),
  tools: (
    <>
      <path d="M3 7h4m4 0h10M3 17h10m4 0h4" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
  send: (
    <>
      <path d="m4 10.5 16-7-7 16-2.2-6.7L4 10.5Z" />
      <path d="m10.8 12.8 5.8-5.9" />
    </>
  ),
  preview: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M14.5 4v16M6.5 8h4M6.5 12h4" />
    </>
  ),
  workspaceAdmin: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M8 8v8m8-8v8M6 11h4m4 3h4" />
      <circle cx="8" cy="11" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  ownerAdmin: (
    <>
      <path d="m12 2.75 8 3v6.15c0 4.3-3.4 7.7-8 9.35-4.6-1.65-8-5.05-8-9.35V5.75l8-3Z" />
      <path d="m8 11 2.6 2.6L16 8.5" />
    </>
  ),
  compare: (
    <>
      <rect x="3" y="4" width="7" height="16" rx="2" />
      <rect x="14" y="4" width="7" height="16" rx="2" />
      <path d="M5.75 8h1.5m9.5 0h1.5M5.75 12h1.5m9.5 0h1.5" />
    </>
  ),
  learning: (
    <>
      <path d="M12 18.5v-7m0 1-6-5m6 5 6-5" />
      <circle cx="12" cy="20" r="1.75" />
      <circle cx="4.5" cy="6" r="2" />
      <circle cx="19.5" cy="6" r="2" />
      <circle cx="12" cy="9" r="2" />
    </>
  ),
  menu: <path d="M4 6.5h16M4 12h16M4 17.5h11" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
};

export interface HikmahIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  name: HikmahIconName;
  size?: number;
  label?: string;
}

export function HikmahIcon({ name, size = 20, label, ...props }: HikmahIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
