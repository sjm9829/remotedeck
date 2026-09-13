// Multi-file upload flow for OS drag-and-drop / multi-selection (DOM-free).
//
// Uploads are destructive only on overwrite, so a drop is split into two
// groups: brand-new names upload immediately, and names that already exist are
// parked until an explicit `confirmAll()` (never uploaded automatically). This
// preserves the single-file `upload-flow.ts` guarantee that a destructive
// upload happens at most once and only after confirmation.

export interface BatchUploadFlow<F> {
  /** Upload non-conflicting files now; park any whose name already exists. */
  add(existingNames: readonly string[], files: readonly F[]): { uploaded: number; conflicts: string[] };
  /** Confirm every parked file: perform one upload each with `overwrite: true`. */
  confirmAll(): Promise<void>;
  /** Discard parked files without uploading. */
  cancel(): void;
  /** Names of currently parked (conflicting) files, in drop order. */
  pendingNames(): string[];
  nameOf(file: F): string;
}

export function createBatchUploadFlow<F>(
  nameOf: (file: F) => string,
  perform: (file: F, overwrite: boolean) => Promise<void>,
): BatchUploadFlow<F> {
  let pending: F[] = [];
  return {
    nameOf,
    add(existingNames, files) {
      const existing = new Set(existingNames);
      const conflicts: string[] = [];
      let uploaded = 0;
      for (const file of files) {
        if (existing.has(nameOf(file))) {
          pending.push(file);
          conflicts.push(nameOf(file));
        } else {
          void perform(file, false);
          uploaded += 1;
        }
      }
      return { uploaded, conflicts };
    },
    async confirmAll() {
      const files = pending;
      pending = [];
      for (const file of files) await perform(file, true);
    },
    cancel() {
      pending = [];
    },
    pendingNames() {
      return pending.map(nameOf);
    },
  };
}
