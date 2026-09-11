// Upload overwrite decision flow (extracted from <App/> for testability).
//
// Overwriting an existing file is destructive, so an upload whose name already
// exists must NOT call `perform` immediately. Instead it parks the pending file
// and asks the UI for confirmation; only `confirm()` performs the upload with
// `overwrite: true`. A brand-new name uploads once immediately with
// `overwrite: false`. A single selection therefore performs *at most one*
// upload — it can never upload twice.
//
// `perform(file, overwrite)` is injected so the flow is DOM-free and testable;
// it must do nothing else observable (no state mutation) beyond the upload.

export interface PendingUpload {
  name: string;
}

export interface UploadFlow {
  /**
   * Handle one selected `file`. If its name already exists in `existingNames`,
   * park it and return `{ overwrite: true }` (awaiting confirmation, no upload
   * yet). Otherwise upload it once with `overwrite: false` and return
   * `{ overwrite: false }`.
   */
  select(existingNames: string[], file: File): Promise<{ overwrite: boolean }>;
  /** Confirm the parked file: perform one upload with `overwrite: true`. */
  confirm(): Promise<void>;
  /** Discard the parked file without uploading. */
  cancel(): void;
  /** Currently parked file name, or null. */
  pendingName(): string | null;
}

export function createUploadFlow(perform: (file: File, overwrite: boolean) => Promise<void>): UploadFlow {
  let pending: { name: string; file: File } | null = null;
  return {
    async select(existingNames, file) {
      if (existingNames.includes(file.name)) {
        pending = { name: file.name, file };
        return { overwrite: true };
      }
      await perform(file, false);
      return { overwrite: false };
    },
    async confirm() {
      if (!pending) return;
      const { file } = pending;
      pending = null;
      await perform(file, true);
    },
    cancel() {
      pending = null;
    },
    pendingName() {
      return pending ? pending.name : null;
    },
  };
}
