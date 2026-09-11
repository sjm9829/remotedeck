export type RemoteDeckLayout = 'desktop' | 'drawer' | 'mobile';

export function layoutForWidth(width: number): RemoteDeckLayout {
  if (width < 600) return 'mobile';
  if (width < 900) return 'drawer';
  return 'desktop';
}
