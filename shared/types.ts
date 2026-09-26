export type TimerState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "paused"
  | "uncertain";
export type Timer = {
  state: TimerState;
  subject: string | null;
  startedAt: number | null;
  revision: number;
  updatedAt: number;
  origin: "web" | "app" | null;
};
export type Subject = { title: string; studyMs: number | null; color?: string };
export type Day = {
  date: string;
  totalMs: number;
  subjects: Subject[];
  subjectTimesAvailable: boolean;
  longestSegmentMs: number | null;
};
export type Group = {
  id: number;
  title: string;
  capacity: number | null;
  category?: string;
  owner?: string;
  slogan?: string;
};
export type Member = {
  id: number;
  nickname: string;
  studying: boolean | null;
  studyMs: number | null;
  startedAt: number | null;
};
export type Capabilities = {
  crossControl: boolean;
  history: boolean;
  groups: boolean;
};
export type Snapshot = {
  timer: Timer;
  today: Day;
  subjects: Subject[];
  capabilities: Capabilities;
  serverNow: number;
  upstreamClockOffsetMs: number | null;
  remoteStatus: "idle" | "running" | "unverified";
  remoteStartedAt: number | null;
  remoteSubject: string | null;
};
