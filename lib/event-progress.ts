export type ProgressEvent = {
  progress: number;
  setProgress?: (progress: number) => unknown;
};

export function setEventProgress(event: ProgressEvent, progress: number): void {
  const normalizedProgress = Math.max(0, Math.min(progress, 100));
  if (event.setProgress) {
    event.setProgress(normalizedProgress);
    return;
  }

  event.progress = normalizedProgress;
}
