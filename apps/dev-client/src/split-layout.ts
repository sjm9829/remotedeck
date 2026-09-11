export const MIN_SFTP_HEIGHT = 160;
export const MAX_SFTP_HEIGHT = 440;
export const DEFAULT_SFTP_HEIGHT = 240;

export function clampSftpHeight(height: number): number {
  return Math.min(MAX_SFTP_HEIGHT, Math.max(MIN_SFTP_HEIGHT, Math.round(height)));
}

export function resizeSftpWithKey(height: number, key: string): number {
  if (key === 'ArrowUp') return clampSftpHeight(height + 24);
  if (key === 'ArrowDown') return clampSftpHeight(height - 24);
  if (key === 'Home') return MIN_SFTP_HEIGHT;
  if (key === 'End') return MAX_SFTP_HEIGHT;
  return height;
}
