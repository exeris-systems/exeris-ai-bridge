// The exit registry is process-wide and not specific to previews; it lives in
// src/process/. Re-exported so the preview modules keep one local import.
export {
  cleanupNow,
  killGroupSync,
  trackCloser,
  trackDirectory,
  trackGroup,
  untrackCloser,
  untrackDirectory,
  untrackGroup,
} from "../../../process/exit-hooks.js";
