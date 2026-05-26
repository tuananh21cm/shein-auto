import { eventBus } from "./eventBus";

export interface JobInfo {
  file: string;
  profile: string;
  folder: string;
  startedAt: number;
}

export interface WorkerSnapshot {
  active: JobInfo[];
  lastFinishedAt: number | null;
  lastFolder: string | null;
}

const snapshot: WorkerSnapshot = {
  active: [],
  lastFinishedAt: null,
  lastFolder: null,
};

const emit = () => eventBus.emit("worker:state", { ...snapshot, active: [...snapshot.active] });

export const workerState = {
  get: (): WorkerSnapshot => ({ ...snapshot, active: [...snapshot.active] }),

  startJob: (job: JobInfo): void => {
    snapshot.active.push(job);
    emit();
  },

  finishJob: (file: string): void => {
    snapshot.active = snapshot.active.filter((j) => j.file !== file);
    snapshot.lastFinishedAt = Date.now();
    emit();
  },

  setLastFolder: (folder: string): void => {
    snapshot.lastFolder = folder;
    emit();
  },
};
