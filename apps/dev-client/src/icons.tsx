// Small stroke icons for the file browser (inline SVG, inherit currentColor).
import type { ReactNode } from 'react';

function Svg({ children, size = 16, className }: { children: ReactNode; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
}

export const IconRefresh = () => <Svg><path d="M20 6v5h-5" /><path d="M19 11a8 8 0 1 0 1.2 5" /></Svg>;
export const IconFolderPlus = () => <Svg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5h5" /></Svg>;
export const IconUpload = () => <Svg><path d="M12 16V5" /><path d="M7.5 9.5 12 5l4.5 4.5" /><path d="M4 19h16" /></Svg>;
export const IconUp = () => <Svg><path d="M12 19V6" /><path d="M6.5 11.5 12 6l5.5 5.5" /></Svg>;
export const IconColumns = () => <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></Svg>;
export const IconDockRight = () => <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></Svg>;
export const IconDockBottom = () => <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14h18" /></Svg>;
export const IconChevronDown = () => <Svg><path d="m6 9 6 6 6-6" /></Svg>;
export const IconMore = () => <Svg><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></Svg>;
export const IconFolder = ({ size = 18 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#d9a441" /></svg>;
export const IconFile = ({ size = 18 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="#3a4a60" /><path d="M14 3v5h5" fill="#52667f" /></svg>;
