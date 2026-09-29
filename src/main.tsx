import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Day, Group, Member, Snapshot } from "../shared/types.ts";
import { PENDING_RECOVERY_MS } from "../shared/constants.ts";
import { duration, formatDaySummary, formatDayCsv, formatTrendCsv, formatTrendSubjectsCsv, formatTrendReview, longestVerifiedStreak, compareVerifiedWeeks, summarizeTrendSubjects, verifiedGoalStreak } from "../shared/format.ts";
import type { TrendDay } from "../shared/format.ts";
import { RequestGate } from "../shared/request-gate.ts";
import { tabFromSearch, tabUrl } from "../shared/navigation.ts";
import type { Tab } from "../shared/navigation.ts";
import { clearPersonalTools, StudyTools } from "./study-tools.tsx";
import { freshPomodoro, nextPomodoro, parsePomodoro, pausePomodoro, pomodoroRemaining, pomodoroStatusLabel, runPomodoro, shouldAdvancePomodoro } from "../shared/pomodoro.ts";
import type { Pomodoro } from "../shared/pomodoro.ts";
import { parseTimerContinuity, pauseTimerContinuity, resumeTimerContinuity, startTimerContinuity, timerContinuityElapsed } from "../shared/timer-continuity.ts";
import type { TimerContinuity } from "../shared/timer-continuity.ts";
import { parseIntervalSettings } from "../shared/study-tools.ts";
import { groupListRefreshMs, statusStaleAfterMs } from "../shared/sync.ts";
import "./style.css";

function NavIcon({ tab }: { tab: Tab }) {
  const paths = {
    study: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.7 1.8" /></>,
    today: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h5" /></>,
    plan: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5h6M8 11h8M8 15l2 2 5-5" /></>,
    history: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h6" /></>,
    insights: <><path d="M4 20V12h4v8M10 20V8h4v12M16 20V4h4v16M3 20.5h18" /></>,
    groups: <><circle cx="9" cy="9" r="2.5" /><path d="M3.5 19v-1.2a5.5 5.5 0 0 1 11 0V19zM16 7a2.5 2.5 0 0 1 0 5M17 14a4 4 0 0 1 3.5 4V19h-3" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[tab]}</svg>;
}
function BrandMark() {
  return <img className="brand-mark" src="/ypt-mark.svg" alt="" aria-hidden="true" />;
}
type MemberSort = "time" | "name" | "status";
type MemberFilter = "all" | "studying" | "resting" | "unknown";
type TrendRange = 7 | 14;
type Session = { authenticated: boolean; csrf?: string };
type ApiError = Error & { code?: string; status?: number };
type GoogleTokenResponse = { access_token?: string; error?: string };
type GoogleTokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };
type GoogleIdentity = {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: GoogleTokenResponse) => void;
        error_callback?: (error: { type?: string }) => void;
      }) => GoogleTokenClient;
    };
  };
};
const SYNC_SECONDS = [10, 15, 30, 60, 120] as const;
const GOAL_MINUTES = [0, 30, 60, 90, 120, 180, 240, 360, 480, 600, 720] as const;
const PAGE_INFO: Record<Tab, { eyebrow: string; title: string; subtitle: string }> = {
  study: { eyebrow: "FOCUS", title: "타이머", subtitle: "과목을 고르고 공부 시간을 기록하세요." },
  today: { eyebrow: "TODAY", title: "오늘", subtitle: "오늘 공부한 시간과 과목을 확인하세요." },
  plan: { eyebrow: "PLAN", title: "계획", subtitle: "오늘 할 공부를 정리하세요." },
  history: { eyebrow: "RECORDS", title: "기록", subtitle: "날짜를 골라 상세 기록을 확인하세요." },
  insights: { eyebrow: "INSIGHTS", title: "통계", subtitle: "최근 공부 흐름을 살펴보세요." },
  groups: { eyebrow: "TOGETHER", title: "그룹", subtitle: "함께 공부하는 사람들의 현황을 확인하세요." },
};
const SIDEBAR_SECTIONS: { title: string; items: { tab: Tab; label: string }[] }[] = [
  { title: "집중", items: [{ tab: "study", label: "타이머" }] },
  { title: "오늘", items: [{ tab: "today", label: "오늘 요약" }, { tab: "plan", label: "계획" }] },
  { title: "기록", items: [{ tab: "history", label: "날짜별 기록" }, { tab: "insights", label: "통계" }] },
  { title: "함께", items: [{ tab: "groups", label: "그룹" }] },
];
const MOBILE_TABS: { tab: Tab; label: string }[] = [
  { tab: "study", label: "타이머" },
  { tab: "today", label: "오늘" },
  { tab: "plan", label: "계획" },
  { tab: "history", label: "기록" },
  { tab: "groups", label: "그룹" },
];
const HISTORY_CACHE_MS = 5 * 60_000;
const SYNC_STORAGE_KEY = "ypt-web-sync-seconds";
const GOAL_STORAGE_KEY = "ypt-web-daily-goal-minutes";
const THEME_STORAGE_KEY = "ypt-web-theme";
const POMODORO_MODE_KEY = "ypt-web-pomodoro-mode";
const POMODORO_KEY = "ypt-web-personal-tools-pomodoro";
const POMODORO_SETTINGS_KEY = "ypt-web-personal-tools-settings";
const REMEMBERED_EMAIL_KEY = "ypt-web-remembered-email";
const ACCOUNT_LABEL_KEY = "ypt-web-account-label";
const TIMER_CONTINUITY_KEY = "ypt-web-timer-continuity";
const LAST_SUBJECT_KEY = "ypt-web-personal-tools-last-subject";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const CROSS_ORIGIN_API = API_BASE_URL !== "" &&
  new URL(API_BASE_URL).origin !== window.location.origin;
const SESSION_STORAGE_KEY = "ypt-web-session-token";
let googleIdentityScript: Promise<void> | null = null;
let csrf = "";
let sessionToken = "";
if (CROSS_ORIGIN_API) {
  try {
    sessionToken = sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "";
  } catch {
    // Private browsing can disable storage.
  }
}

function rememberSessionToken(token: string) {
  sessionToken = token;
  try {
    if (token) sessionStorage.setItem(SESSION_STORAGE_KEY, token);
    else sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // The current tab can still use an in-memory session.
  }
}

function savedSyncSeconds(): number {
  try {
    const saved = Number(localStorage.getItem(SYNC_STORAGE_KEY));
    return SYNC_SECONDS.find((value) => value === saved) ?? 15;
  } catch {
    return 15;
  }
}

function savedGoalMinutes(): number {
  try {
    const saved = Number(localStorage.getItem(GOAL_STORAGE_KEY));
    return validGoalMinutes(saved) ? saved : 0;
  } catch {
    return 0;
  }
}

function validGoalMinutes(minutes: number) {
  return minutes === 0 || Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440;
}

function savedEmail(): string {
  try {
    return localStorage.getItem(REMEMBERED_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberEmail(email: string) {
  try {
    if (email) localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
    else localStorage.removeItem(REMEMBERED_EMAIL_KEY);
  } catch {
    // Login still works when browser storage is unavailable.
  }
}

function savedAccountLabel(): string {
  try {
    return sessionStorage.getItem(ACCOUNT_LABEL_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberAccountLabel(label: string) {
  try {
    if (label) sessionStorage.setItem(ACCOUNT_LABEL_KEY, label);
    else sessionStorage.removeItem(ACCOUNT_LABEL_KEY);
  } catch {
    // Account details are optional and must not block sign-in.
  }
}

function loadGoogleIdentityScript(): Promise<void> {
  if ((window as Window & { google?: GoogleIdentity }).google?.accounts?.oauth2)
    return Promise.resolve();
  if (googleIdentityScript) return googleIdentityScript;
  googleIdentityScript = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    const script = existing ?? document.createElement("script");
    script.async = true;
    script.defer = true;
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google 로그인 기능을 불러오지 못했습니다."));
    if (!existing) document.head.appendChild(script);
  }).catch((error: unknown) => {
    googleIdentityScript = null;
    throw error;
  });
  return googleIdentityScript;
}

async function api<T>(path: string, method = "GET", data?: object): Promise<T> {
  const isLoginRequest = path === "/login" || path === "/login/google";
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api${path}`, {
      method,
      credentials: CROSS_ORIGIN_API ? "include" : "same-origin",
      headers: {
        ...(CROSS_ORIGIN_API && sessionToken && !isLoginRequest
          ? { Authorization: `Bearer ${sessionToken}` }
          : {}),
        ...(method !== "GET"
          ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
          : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  } catch {
    throw new Error("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      response.ok
        ? "서버 응답을 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요."
        : "요청을 처리하지 못했습니다.",
    );
  const result = parsed as {
    error?: string;
    code?: string;
    sessionToken?: unknown;
    authenticated?: unknown;
    [key: string]: unknown;
  };
  if (CROSS_ORIGIN_API && path === "/session" && result.authenticated === false) {
    if (sessionToken) {
      rememberSessionToken("");
      return api<T>(path, method, data);
    }
    rememberSessionToken("");
  }
  if (!response.ok) {
    if (CROSS_ORIGIN_API && response.status === 401 && !isLoginRequest)
      rememberSessionToken("");
    const error = new Error(
      result.error || "요청을 처리하지 못했습니다.",
    ) as ApiError;
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  if (CROSS_ORIGIN_API && isLoginRequest) {
    if (typeof result.sessionToken !== "string" ||
        !/^[0-9a-f]{64}$/.test(result.sessionToken))
      throw new Error("로그인 세션을 확인할 수 없습니다.");
    rememberSessionToken(result.sessionToken);
  }
  if (CROSS_ORIGIN_API && path === "/logout") rememberSessionToken("");
  return result as T;
}
function goalLabel(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours && rest ? `${hours}시간 ${rest}분` : hours ? `${hours}시간` : `${rest}분`;
}
function countdown(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function DailyGoal({ minutes, onChange, recordedMs, liveMs }: {
  minutes: number;
  onChange: (minutes: number) => void;
  recordedMs: number;
  liveMs: number;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState(String(minutes || 45));
  const [customError, setCustomError] = useState("");
  const goalMs = minutes * 60_000;
  const customSelected = customMode || minutes > 0 && !GOAL_MINUTES.some((value) => value === minutes);
  const progress = goalMs ? Math.min(100, Math.floor(recordedMs / goalMs * 100)) : 0;
  const previewProgress = goalMs ? Math.min(100, Math.floor((recordedMs + liveMs) / goalMs * 100)) : 0;
  const milestone = progress >= 100 ? "오늘의 목표 달성!"
    : progress >= 75 ? "거의 다 왔어요"
    : progress >= 50 ? "절반을 넘었어요"
    : progress >= 25 ? "좋은 출발이에요"
    : "첫 25%를 향해 시작해 볼까요?";
  return (
    <div className="daily-goal">
      <div className="daily-goal-head">
        <label htmlFor="daily-goal-minutes">하루 목표</label>
        <select id="daily-goal-minutes" value={customSelected ? "custom" : minutes}
          onChange={(event) => {
            if (event.target.value === "custom") {
              setCustomDraft(String(minutes || 45));
              setCustomMode(true);
            } else {
              setCustomMode(false);
              setCustomError("");
              onChange(Number(event.target.value));
            }
          }}>
          {GOAL_MINUTES.map((value) => (
            <option key={value} value={value}>
              {value ? goalLabel(value) : minutes ? "목표 지우기" : "목표 정하기"}
            </option>
          ))}
          <option value="custom">직접 입력</option>
        </select>
      </div>
      {customSelected && <form className="custom-goal" noValidate onSubmit={(event) => {
        event.preventDefault();
        const value = Number(customDraft);
        if (!validGoalMinutes(value) || value === 0) {
          setCustomError("15분부터 24시간까지 분 단위로 입력해 주세요.");
          return;
        }
        setCustomError("");
        onChange(value);
      }}>
        <label htmlFor="custom-goal-minutes">직접 목표 (분)</label>
        <div>
          <input id="custom-goal-minutes" type="number" inputMode="numeric"
            min={15} max={1440} step={1} value={customDraft}
            onChange={(event) => setCustomDraft(event.target.value)} />
          <button className="secondary" type="submit">적용</button>
        </div>
        {customError && <small role="alert">{customError}</small>}
      </form>}
      {goalMs ? (
        <>
          <div className="daily-goal-numbers">
            <strong>{progress}%</strong>
            <span>기록된 {duration(recordedMs)} / 목표 {goalLabel(minutes)}</span>
          </div>
          <div className="daily-goal-track" role="progressbar"
            aria-label="오늘 기록된 공부시간 목표 달성률"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            {liveMs > 0 && <span className="daily-goal-preview" aria-hidden="true"
              style={{ left: `${progress}%`, width: `${previewProgress - progress}%` }} />}
            <span className="daily-goal-recorded" style={{ width: `${progress}%` }} />
          </div>
          {liveMs > 0 && <p className="daily-goal-preview-text">
            진행 중인 {duration(liveMs)}까지 포함하면 약 {previewProgress}% · 임시 합계 {duration(recordedMs + liveMs)}
          </p>}
          <p className="daily-goal-message">{milestone}</p>
          {progress < 100 && (
            <p className="daily-goal-detail">기록 기준 남은 시간 {duration(goalMs - recordedMs)}</p>
          )}
          {recordedMs > goalMs && (
            <p className="daily-goal-detail">목표보다 {duration(recordedMs - goalMs)} 더 공부했어요.</p>
          )}
        </>
      ) : (
        <p className="daily-goal-detail">목표 시간을 고르면 오늘의 진행률을 볼 수 있어요. 이 브라우저에만 저장됩니다.</p>
      )}
    </div>
  );
}
function SubjectBreakdown({ day, empty }: { day: Day; empty: string }) {
  const [sort, setSort] = useState<"time" | "name">("time");
  const subjects = [...day.subjects].sort((a, b) => sort === "name"
    ? a.title.localeCompare(b.title, "ko-KR")
    : (b.studyMs ?? -1) - (a.studyMs ?? -1) ||
      a.title.localeCompare(b.title, "ko-KR"));
  const maxMs = Math.max(0, ...subjects.map((subject) => subject.studyMs ?? 0));
  const shareAvailable = day.subjectTimesAvailable && subjects.length > 0 &&
    subjects.every((subject) => subject.studyMs !== null);
  const subjectTotal = shareAvailable
    ? subjects.reduce((sum, subject) => sum + (subject.studyMs ?? 0), 0) : 0;
  return (
    <div className="subject-list">
      <div className="subject-list-head">
        <span>과목별 완료 시간</span>
        {subjects.length > 1 && <label>정렬
          <select value={sort} onChange={(event) =>
            setSort(event.target.value === "name" ? "name" : "time")}>
            <option value="time">시간순</option>
            <option value="name">이름순</option>
          </select>
        </label>}
      </div>
      {shareAvailable && subjectTotal > 0 &&
        <p className="subject-share-note">비중은 확인된 과목별 완료 시간 합계 기준입니다.</p>}
      {subjects.map((subject) => (
        <div className="subject-row" key={subject.title}>
          <div className="subject-row-top">
            <span className="subject-name">
              {subject.color && (
                <span className="subject-color" aria-hidden="true"
                  style={{ backgroundColor: subject.color }} />
              )}
              {subject.title}
            </span>
            <span className="subject-row-values">
              <strong>{subject.studyMs === null ? "미확인" : duration(subject.studyMs)}</strong>
              {shareAvailable && subjectTotal > 0 && subject.studyMs !== null &&
                <small>{Math.round(subject.studyMs / subjectTotal * 100)}%</small>}
            </span>
          </div>
          {subject.studyMs !== null && maxMs > 0 && (
            <div className="subject-track" aria-hidden="true">
              <span style={{
                width: `${Math.min(100, subject.studyMs / maxMs * 100)}%`,
                backgroundColor: subject.color || "#28784a",
              }} />
            </div>
          )}
        </div>
      ))}
      {!subjects.length && <p className="empty">{empty}</p>}
    </div>
  );
}
function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function shortDayLabel(date: string) {
  const weekday = "일월화수목금토"[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${date.slice(5).replace("-", ".")} · ${weekday}`;
}
function CopyDayButton({ day }: { day: Day }) {
  const [notice, setNotice] = useState("");
  const [copying, setCopying] = useState(false);
  async function copy() {
    if (copying) return;
    setCopying(true);
    setNotice("");
    if (!navigator.clipboard?.writeText) {
      setNotice("이 브라우저에서 복사를 지원하지 않습니다.");
      setCopying(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(formatDaySummary(day));
      setNotice("복사했어요");
    } catch {
      setNotice("복사하지 못했습니다. 브라우저 권한을 확인해 주세요.");
    } finally {
      setCopying(false);
    }
  }
  return (
    <div className="copy-day-action">
      <button className="text-button" disabled={copying} onClick={() => void copy()}>
        {copying ? "복사 중…" : "요약 복사"}
      </button>
      {notice && <span role="status">{notice}</span>}
    </div>
  );
}
function CsvButton({ filename, csv, label }: { filename: string; csv: string; label: string }) {
  const [notice, setNotice] = useState("");
  function download() {
    setNotice("");
    try {
      const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice("CSV 저장을 시작했어요");
    } catch {
      setNotice("CSV를 저장하지 못했습니다. 브라우저 설정을 확인해 주세요.");
    }
  }
  return <span className="csv-action">
    <button className="text-button" type="button" onClick={download}>{label}</button>
    {notice && <small role="status">{notice}</small>}
  </span>;
}
function HistoryTrend({ today, rangeDays, goalMinutes, onRangeChange, previous, onLoaded, onSelect, loadDay }: {
  today: Day;
  rangeDays: TrendRange;
  goalMinutes: number;
  onRangeChange: (range: TrendRange) => void;
  previous: TrendDay[] | null;
  onLoaded: (days: TrendDay[]) => void;
  onSelect: (date: string) => void;
  loadDay: (date: string, force?: boolean) => Promise<Day>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"bars" | "calendar">("bars");
  const [copyNotice, setCopyNotice] = useState("");
  const [copying, setCopying] = useState(false);
  const requestId = useRef(0);
  const loadingRef = useRef(false);
  useEffect(() => () => { requestId.current++; }, []);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError("");
    setCopyNotice("");
    try {
      const rows: TrendDay[] = [];
      for (let offset = 1; offset < rangeDays; offset += 2) {
        const dates = [offset, offset + 1]
          .filter((days) => days < rangeDays)
          .map((days) => shiftDate(today.date, -days));
        const results = await Promise.allSettled(dates.map((date) => loadDay(date, previous !== null)));
        if (currentRequest !== requestId.current) return;
        results.forEach((result, index) => {
          const verified = result.status === "fulfilled" && result.value.date === dates[index]
            ? result.value : null;
          rows.push({ date: dates[index], totalMs: verified?.totalMs ?? null,
            subjectTimesAvailable: verified?.subjectTimesAvailable,
            subjects: verified?.subjects });
        });
      }
      if (currentRequest !== requestId.current) return;
      onLoaded(rows);
      if (rows.some((row) => row.totalMs === null))
        setError("일부 날짜를 확인하지 못했습니다. 다시 불러오면 전체 기간을 확인합니다.");
    } catch {
      if (currentRequest === requestId.current)
        setError(`${rangeDays}일 기록을 확인하지 못했습니다. 다시 시도해 주세요.`);
    } finally {
      loadingRef.current = false;
      if (currentRequest === requestId.current) setLoading(false);
    }
  }

  const days = previous && [...previous, { date: today.date, totalMs: today.totalMs,
    subjectTimesAvailable: today.subjectTimesAvailable, subjects: today.subjects }]
    .sort((a, b) => a.date.localeCompare(b.date));
  const known = days?.filter((row) => row.totalMs !== null) ?? [];
  const maxMs = Math.max(1, ...known.map((row) => row.totalMs ?? 0));
  const knownTotal = known.reduce((sum, row) => sum + (row.totalMs ?? 0), 0);
  const studyDays = known.filter((row) => (row.totalMs ?? 0) > 0).length;
  const bestDay = known.reduce<TrendDay | null>((best, row) =>
    !best || (row.totalMs ?? 0) > (best.totalMs ?? 0) ? row : best, null);
  const streak = days ? longestVerifiedStreak(days) : 0;
  const weekComparison = rangeDays === 14 && days ? compareVerifiedWeeks(days) : null;
  const subjectSummary = days ? summarizeTrendSubjects(days, rangeDays) : null;
  const subjectCsv = days ? formatTrendSubjectsCsv(days, rangeDays) : null;
  const goalDays = goalMinutes > 0 ? known.filter((row) =>
    (row.totalMs ?? 0) >= goalMinutes * 60_000).length : 0;
  const goalStreak = days && goalMinutes > 0 ? verifiedGoalStreak(days, goalMinutes) : null;
  const review = days ? formatTrendReview(days, rangeDays, goalMinutes) : null;
  const calendarLead = days
    ? (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;

  async function copyReview() {
    if (!review || copying) return;
    setCopying(true);
    setCopyNotice("");
    try {
      await navigator.clipboard.writeText(review);
      setCopyNotice("기간 요약을 복사했어요.");
    } catch {
      setCopyNotice("복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.");
    } finally {
      setCopying(false);
    }
  }
  return (
    <div className="history-trend">
      <div className="card-head">
        <span>기간별 공부 분석</span>
        <div className="history-trend-actions">
          <label className="trend-range" htmlFor="trend-range">기간
            <select id="trend-range" value={rangeDays} disabled={loading}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (value === 7 || value === 14) onRangeChange(value);
              }}>
              <option value={7}>7일</option>
              <option value={14}>14일</option>
            </select>
          </label>
          <button className="text-button" disabled={loading} onClick={() => void load()}>
            {loading ? "확인 중…" : previous ? "다시 불러오기" : `${rangeDays}일 기록 불러오기`}
          </button>
        </div>
      </div>
      <p className="card-note">누르면 오늘을 포함한 {rangeDays}일의 완료 기록을 확인합니다. 과거 날짜는 한 번에 최대 두 건씩 조회합니다.</p>
      {days && (
        <>
          {days.some((row) => row.totalMs === null) && !error &&
            <p className="card-note">확인할 수 없는 날짜는 합계·평균에서 제외합니다.{rangeDays === 14 && " 앞뒤 7일 비교도 보류합니다."}</p>}
          <p className="week-total">확인된 {known.length}일 합계 <strong>{duration(knownTotal)}</strong></p>
          <div className="week-insights">
            <span>공부한 날 <strong>{studyDays}/{known.length}일</strong></span>
            <span>확인된 날 평균 <strong>{duration(knownTotal / Math.max(1, known.length))}</strong></span>
            <span>확인된 최장 연속 <strong>{streak}일</strong></span>
            {studyDays > 0 && bestDay && (
              <span>가장 많이 한 날 <strong>{bestDay.date.slice(5).replace("-", ".")} · {duration(bestDay.totalMs)}</strong></span>
            )}
            {goalMinutes > 0 && <span>현재 하루 목표 달성 <strong>{goalDays}/{known.length}일</strong></span>}
            {goalStreak !== null && goalStreak > 0 && <span>현재 목표 연속 <strong>{goalStreak}일</strong></span>}
          </div>
          {goalMinutes > 0 && <p className="card-note">현재 설정한 하루 목표를 이 기간에 적용한 값입니다. 과거에 설정했던 목표는 알 수 없습니다.</p>}
          {rangeDays === 14 && (
            <p className="week-comparison">
              {weekComparison
                ? <>이전 7일 {duration(weekComparison.earlier)} · 최근 7일 {duration(weekComparison.recent)}
                    <strong>{weekComparison.difference > 0
                      ? ` ${duration(weekComparison.difference)} 증가`
                      : weekComparison.difference < 0
                        ? ` ${duration(-weekComparison.difference)} 감소`
                        : " 같은 시간"}</strong>
                    <small>오늘 진행 중인 시간은 제외한 완료 기록입니다.</small></>
                : "7일씩 비교하려면 14일 모두의 기록을 확인해야 합니다."}
            </p>
          )}
          <CsvButton filename={`ypt-${rangeDays}days-${today.date}.csv`}
            csv={formatTrendCsv(days)} label={`${rangeDays}일 기록 CSV 저장`} />
          <div className="trend-review-action">
            <button className="text-button" type="button" disabled={!review || copying}
              onClick={() => void copyReview()}>{copying ? "복사 중…" : "기간 요약 복사"}</button>
            {copyNotice && <small role="status">{copyNotice}</small>}
          </div>
          <div className="trend-subjects">
            <div className="card-head"><span>기간 과목별 공부</span>
              {subjectCsv && <CsvButton filename={`ypt-${rangeDays}days-subjects-${today.date}.csv`}
                csv={subjectCsv} label="과목별 CSV 저장" />}
            </div>
            {subjectSummary === null ? <p className="card-note">모든 날짜의 과목 시간이 확인되면 과목별 누적 시간을 보여줍니다.</p>
              : subjectSummary.length === 0 ? <p className="card-note">이 기간에 완료된 과목 공부가 없습니다.</p>
              : <div className="trend-subject-list">{subjectSummary.map((subject) => <div className="trend-subject-row" key={subject.title}>
                  <div className="trend-subject-label">
                    <span className="subject-color" style={{ backgroundColor: subject.color || "#8aa494" }} aria-hidden="true" />
                    <span>{subject.title}</span>
                    <strong>{duration(subject.totalMs)}</strong>
                  </div>
                  <div className="trend-subject-track" aria-hidden="true"><span style={{ width: `${subject.totalMs / subjectSummary[0].totalMs * 100}%`, backgroundColor: subject.color || "#5b9a72" }} /></div>
                  {rangeDays === 14 && <small>이전 7일 {duration(subject.earlierMs)} → 최근 7일 {duration(subject.recentMs)}</small>}
                </div>)}</div>}
            <p className="card-note">과목 이름이 바뀌었다면 기간 내에서는 서로 다른 과목명으로 집계합니다. 진행 중인 세션은 제외합니다.</p>
          </div>
          <div className="trend-view-controls" role="group" aria-label="최근 기록 표시 방식">
            <button type="button" aria-pressed={view === "bars"} onClick={() => setView("bars")}>막대</button>
            <button type="button" aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>달력</button>
          </div>
          {view === "bars" ? <div className="week-list">
            {days.map((row) => <button className="week-row" key={row.date} onClick={() => onSelect(row.date)}
              aria-label={`${row.date} 기록 보기, ${row.totalMs === null ? "시간 확인 불가" : duration(row.totalMs)}`}>
              <span>{shortDayLabel(row.date)}</span>
              <span className="week-track" aria-hidden="true">
                {row.totalMs !== null && <span style={{ width: `${row.totalMs / maxMs * 100}%` }} />}
              </span>
              <strong>{row.totalMs === null ? "확인 불가" : duration(row.totalMs)}</strong>
            </button>)}
          </div> : <>
            <div className="week-calendar" aria-label={`${rangeDays}일 공부 달력`}>
              {["월", "화", "수", "목", "금", "토", "일"].map((name) =>
                <span className="week-calendar-head" key={name}>{name}</span>)}
              {Array.from({ length: calendarLead }, (_, index) =>
                <span className="week-calendar-blank" key={`blank-${index}`} aria-hidden="true" />)}
              {days.map((row) => {
                const level = row.totalMs === null ? "unknown" : row.totalMs === 0
                  ? "level-0" : `level-${Math.max(1, Math.ceil(row.totalMs / maxMs * 4))}`;
                return <button type="button" className={`week-calendar-day ${level}`} key={row.date}
                  onClick={() => onSelect(row.date)}
                  aria-label={`${row.date} 기록 보기, ${row.totalMs === null ? "시간 확인 불가" : duration(row.totalMs)}`}>
                  <strong>{Number(row.date.slice(-2))}</strong>
                  <small>{row.totalMs === null ? "?" : row.totalMs === 0 ? "—" : "●"}</small>
                </button>;
              })}
            </div>
            <p className="card-note">진한 칸일수록 완료 공부시간이 깁니다. ?는 확인 불가, —는 0시간입니다. 날짜를 누르면 상세 기록으로 이동합니다.</p>
          </>}
        </>
      )}
      {error && <p className="card-note" role="status">{error}</p>}
    </div>
  );
}
function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return <button className="theme-toggle" type="button" onClick={onToggle}
    aria-label={dark ? "라이트 모드로 변경" : "다크 모드로 변경"}
    aria-pressed={dark}>{dark ? "밝게" : "어둡게"}</button>;
}
function SettingsMenu({ open, onOpenChange, accountLabel, syncSeconds, onSyncSecondsChange, className = "" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountLabel: string;
  syncSeconds: number;
  onSyncSecondsChange: (seconds: number) => void;
  className?: string;
}) {
  return <details className={`settings-menu ${className}`.trim()} open={open}
    onToggle={(event) => onOpenChange(event.currentTarget.open)}>
    <summary>설정</summary>
    <div className="settings-popover">
      <section className="settings-account" aria-label="계정">
        <div>
          <span>로그인 정보</span>
          <strong>{accountLabel || "현재 세션에서 계정 정보를 확인할 수 없음"}</strong>
          {!accountLabel && <small>다시 로그인하면 이 탭에 로그인 정보가 표시됩니다.</small>}
        </div>
      </section>
      <hr />
      <label className="sync-control" htmlFor={className === "sidebar-settings" ? "sidebar-sync-seconds" : "mobile-sync-seconds"}>
        <span>자동 동기화 간격</span>
        <select
          id={className === "sidebar-settings" ? "sidebar-sync-seconds" : "mobile-sync-seconds"}
          value={syncSeconds}
          onChange={(event) => onSyncSecondsChange(Number(event.target.value))}
        >
          {SYNC_SECONDS.map((seconds) => (
            <option key={seconds} value={seconds}>{seconds}초</option>
          ))}
        </select>
      </label>
      <p>타이머와 선택한 그룹 현황의 서버 확인 간격입니다. 그룹 목록은 최소 60초 간격으로 확인합니다.</p>
    </div>
  </details>;
}
function Login({
  onLogin,
  notice,
  darkMode,
  onToggleTheme,
}: {
  onLogin: (rememberWarning: string, accountLabel: string) => Promise<void>;
  notice: string;
  darkMode: boolean;
  onToggleTheme: () => void;
}) {
  const [initialEmail] = useState(savedEmail);
  const [keepEmail, setKeepEmail] = useState(Boolean(initialEmail));
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const [googleLoadFailed, setGoogleLoadFailed] = useState(false);
  const googleClient = useRef<GoogleTokenClient | null>(null);
  const onLoginRef = useRef(onLogin);
  const keepSignedInRef = useRef(keepSignedIn);
  onLoginRef.current = onLogin;
  keepSignedInRef.current = keepSignedIn;

  useEffect(() => {
    let active = true;
    api<{ googleClientId?: unknown }>("/auth/providers")
      .then((providers) => {
        if (!active) return;
        const clientId = typeof providers.googleClientId === "string"
          ? providers.googleClientId.trim()
          : "";
        setGoogleClientId(clientId || null);
        setGoogleConfigured(Boolean(clientId));
      })
      .catch(() => {
        if (active) {
          setGoogleClientId(null);
          setGoogleConfigured(false);
        }
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!googleClientId) return;
    let active = true;
    void loadGoogleIdentityScript()
      .then(() => {
        if (!active) return;
        const identity = (window as Window & { google?: GoogleIdentity }).google;
        const initTokenClient = identity?.accounts?.oauth2?.initTokenClient;
        if (!initTokenClient) throw new Error("Google 로그인 기능을 사용할 수 없습니다.");
        googleClient.current = initTokenClient({
          client_id: googleClientId,
          scope: "openid email profile",
          callback: (response) => {
            const accessToken = response.access_token;
            if (response.error || !accessToken) {
              setError("Google 로그인이 취소되었거나 완료되지 않았습니다.");
              setBusy(false);
              return;
            }
            void (async () => {
              setBusy(true);
              setError("");
              try {
                const result = await api<Session>("/login/google", "POST", {
                  accessToken,
                  rememberDevice: CROSS_ORIGIN_API && keepSignedInRef.current,
                });
                csrf = result.csrf ?? "";
                let rememberWarning = "";
                if (CROSS_ORIGIN_API && keepSignedInRef.current) {
                  try {
                    const check = await fetch(`${API_BASE_URL}/api/session`, {
                      credentials: "include",
                      cache: "no-store",
                    });
                    const state: unknown = await check.json();
                    if (!check.ok || !state || typeof state !== "object" ||
                        !("authenticated" in state) || state.authenticated !== true ||
                        !("csrf" in state) || state.csrf !== csrf)
                      rememberWarning = "로그인 유지 쿠키를 확인하지 못했습니다. 현재 탭에서는 계속 사용할 수 있습니다.";
                  } catch {
                    rememberWarning = "로그인 유지 쿠키를 확인하지 못했습니다. 현재 탭에서는 계속 사용할 수 있습니다.";
                  }
                }
                await onLoginRef.current(rememberWarning, "Google로 로그인됨");
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Google 로그인에 실패했습니다.");
              } finally {
                setBusy(false);
              }
            })();
          },
          error_callback: () => {
            setError("Google 로그인 창을 열지 못했습니다. 팝업 차단을 확인해 주세요.");
            setBusy(false);
          },
        });
        setGoogleReady(true);
      })
      .catch(() => {
        if (!active) return;
        setGoogleLoadFailed(true);
      });
    return () => {
      active = false;
      googleClient.current = null;
    };
  }, [googleClientId]);

  function startGoogleLogin() {
    if (busy || !googleReady || !googleClient.current) return;
    setBusy(true);
    setError("");
    try {
      googleClient.current.requestAccessToken({ prompt: "select_account" });
    } catch {
      setBusy(false);
      setError("Google 로그인 창을 열지 못했습니다. 다시 시도해 주세요.");
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget as HTMLFormElement);
    const email = String(fields.get("email") ?? "").trim();
    const password = String(fields.get("password") ?? "");
    setBusy(true);
    setError("");
    try {
      const response = await api<Session>("/login", "POST", {
        email,
        password,
        rememberDevice: CROSS_ORIGIN_API && keepSignedIn,
      });
      csrf = response.csrf ?? "";
      rememberEmail(keepEmail ? email : "");
      let rememberWarning = "";
      if (CROSS_ORIGIN_API && keepSignedIn) {
        try {
          const check = await fetch(`${API_BASE_URL}/api/session`, {
            credentials: "include",
            cache: "no-store",
          });
          const state: unknown = await check.json();
          if (!check.ok || !state || typeof state !== "object" ||
              !("authenticated" in state) || state.authenticated !== true ||
              !("csrf" in state) || state.csrf !== csrf)
            rememberWarning = "이 브라우저에서 로그인 유지 쿠키를 확인하지 못했습니다. 현재 탭에서는 계속 사용할 수 있습니다.";
        } catch {
          rememberWarning = "이 브라우저에서 로그인 유지 쿠키를 확인하지 못했습니다. 현재 탭에서는 계속 사용할 수 있습니다.";
        }
      }
      const PasswordCredentialType = (window as Window & {
        PasswordCredential?: new (data: { id: string; password: string }) => Credential;
      }).PasswordCredential;
      if (window.isSecureContext && PasswordCredentialType && navigator.credentials?.store) {
        try {
          void navigator.credentials.store(
            new PasswordCredentialType({ id: email, password }),
          ).catch(() => {});
        } catch {
          // Browser password storage is optional and must not block login.
        }
      }
      await onLogin(rememberWarning, email);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "로그인하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-theme"><ThemeToggle dark={darkMode} onToggle={onToggleTheme} /></div>
        <BrandMark />
        <div className="eyebrow">YPT WEB</div>
        <h1>공부를 이어가세요</h1>
        <p className="intro">열품타 이메일 계정으로 로그인합니다.</p>
        {notice && <p className="login-notice" role="status">{notice}</p>}
        <form onSubmit={submit} autoComplete="on">
          <label htmlFor="email">이메일</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            defaultValue={initialEmail}
          />
          <label htmlFor="password">비밀번호</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <label className="remember-email" htmlFor="remember-email">
            <input
              id="remember-email"
              type="checkbox"
              checked={keepEmail}
              onChange={(event) => {
                setKeepEmail(event.target.checked);
                if (!event.target.checked) rememberEmail("");
              }}
            />
            이메일 기억하기
          </label>
          {CROSS_ORIGIN_API && (
            <>
              <label className="remember-email" htmlFor="keep-signed-in">
                <input
                  id="keep-signed-in"
                  type="checkbox"
                  checked={keepSignedIn}
                  onChange={(event) => setKeepSignedIn(event.target.checked)}
                />
                이 기기에서 로그인 유지
              </label>
              <p className="password-manager-note">
                선택하면 최대 30일간 유지됩니다. 브라우저의 쿠키 차단 설정에 따라 동작하지 않을 수 있습니다.
              </p>
            </>
          )}
          <p className="password-manager-note">
            비밀번호는 브라우저의 비밀번호 관리자에서 저장할 수 있습니다.
          </p>
          <button className="primary" disabled={busy} type="submit">
            {busy ? "확인 중…" : "로그인"}
          </button>
        </form>
        {googleConfigured && (
          <>
            <div className="login-divider" aria-hidden="true"><span>또는</span></div>
            <button
              className="google-login-button"
              type="button"
              disabled={busy || !googleReady}
              onClick={startGoogleLogin}
            >
              <span className="google-mark" aria-hidden="true">G</span>
              {busy ? "Google 로그인 중…" : googleReady ? "Google로 로그인" : "Google 로그인 준비 중…"}
            </button>
            <p className="password-manager-note">
              열품타 앱에서 쓰는 Google 계정을 선택하세요. 처음 쓰는 Google 계정은 열품타 계정이 새로 만들어질 수 있습니다.
            </p>
            {googleLoadFailed && (
              <p className="password-manager-note" role="status">
                Google 로그인 기능을 불러오지 못했습니다. 네트워크를 확인하고 페이지를 새로고침해 주세요.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="small-note">비밀번호는 로그인 확인에만 사용합니다.</p>
      </div>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [accountLabel, setAccountLabel] = useState(savedAccountLabel);
  const [sessionLoadError, setSessionLoadError] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [loginNotice, setLoginNotice] = useState("");
  const [rememberWarning, setRememberWarning] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [timerContinuity, setTimerContinuity] = useState<TimerContinuity | null>(() => {
    try { return parseTimerContinuity(localStorage.getItem(TIMER_CONTINUITY_KEY)); }
    catch { return null; }
  });
  const [snapshotCheckedAt, setSnapshotCheckedAt] = useState<number | null>(null);
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(() => tabFromSearch(window.location.search));
  const navigateTab = useCallback((next: Tab, replace = false) => {
    setSettingsOpen(false);
    if (tabFromSearch(window.location.search) !== next) {
      const href = tabUrl(window.location.href, next);
      if (replace) window.history.replaceState({ yptTab: next }, "", href);
      else window.history.pushState({ yptTab: next }, "", href);
    }
    setTab(next);
  }, []);
  useEffect(() => {
    const restoreTab = () => setTab(tabFromSearch(window.location.search));
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);
  const [syncSeconds, setSyncSeconds] = useState(savedSyncSeconds);
  const [goalMinutes, setGoalMinutes] = useState(savedGoalMinutes);
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem(THEME_STORAGE_KEY) === "dark"; }
    catch { return false; }
  });
  const [pomodoroMode, setPomodoroMode] = useState(() => {
    try { return localStorage.getItem(POMODORO_MODE_KEY) === "pomodoro"; }
    catch { return false; }
  });
  const [pomodoroSettings, setPomodoroSettings] = useState(() => {
    try { return parseIntervalSettings(sessionStorage.getItem(POMODORO_SETTINGS_KEY)); }
    catch { return parseIntervalSettings(null); }
  });
  const [pomodoroDraft, setPomodoroDraft] = useState(() => ({
    focus: String(pomodoroSettings.focus), short: String(pomodoroSettings.short),
  }));
  const [pomodoro, setPomodoro] = useState<Pomodoro>(() => {
    try { return parsePomodoro(sessionStorage.getItem(POMODORO_KEY)); }
    catch { return freshPomodoro(); }
  });
  const [pomodoroError, setPomodoroError] = useState("");
  const [focusTask, setFocusTask] = useState<{ date: string; text: string } | null>(null);
  const [keepScreenOn, setKeepScreenOn] = useState(false);
  const [screenAwake, setScreenAwake] = useState(false);
  const [wakeError, setWakeError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState(() => {
    try { return sessionStorage.getItem(LAST_SUBJECT_KEY) ?? ""; }
    catch { return ""; }
  });
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  const [date, setDate] = useState("");
  const [day, setDay] = useState<Day | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [trendRange, setTrendRange] = useState<TrendRange>(7);
  const [trends, setTrends] = useState<Partial<Record<TrendRange, { todayDate: string; days: TrendDay[] }>>>({});
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [memberSnapshots, setMemberSnapshots] = useState<Record<number, { members: Member[]; checkedAt: number }>>({});
  const [groupMemberCounts, setGroupMemberCounts] = useState<Record<number, number>>({});
  const [memberErrors, setMemberErrors] = useState<Record<number, string>>({});
  const [loadingMemberIds, setLoadingMemberIds] = useState<Set<number>>(() => new Set());
  const [loadingGroup, setLoadingGroup] = useState(false);
  const [groupError, setGroupError] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberSort, setMemberSort] = useState<MemberSort>("time");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");
  const reportFocusTask = useCallback((text: string) => {
    const todayDate = snapshot?.today.date;
    setFocusTask(todayDate ? { date: todayDate, text } : null);
  }, [snapshot?.today.date]);
  const inFlight = useRef(false);
  const pomodoroAction = useRef(false);
  const lastVisibleAt = useRef(0);
  const authEpoch = useRef(0);
  const snapshotGate = useRef(new RequestGate());
  const groupGate = useRef(new RequestGate());
  const memberRequests = useRef(new Map<number, number>());
  const memberRequestSequence = useRef(0);
  const lastMemberGroup = useRef<number | null>(null);
  const previousTimerKey = useRef<string | null>(null);
  const previousTab = useRef<Tab>("study");
  const historyCache = useRef(new Map<string, { day: Day; checkedAt: number }>());
  const historyRequests = useRef(new Map<string, Promise<Day>>());
  const forceHistoryDate = useRef<string | null>(null);
  const wakeRunning = (snapshot?.timer.state === "running" && snapshot.timer.startedAt !== null) ||
    (snapshot?.timer.state === "idle" && snapshot.remoteStatus === "running" && snapshot.remoteStartedAt !== null);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === TIMER_CONTINUITY_KEY)
        setTimerContinuity(parseTimerContinuity(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    if (session === null) return;
    try {
      if (timerContinuity) localStorage.setItem(TIMER_CONTINUITY_KEY, JSON.stringify(timerContinuity));
      else localStorage.removeItem(TIMER_CONTINUITY_KEY);
    } catch { /* Keep the timer usable when storage is unavailable. */ }
  }, [session, timerContinuity]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", darkMode ? "#000000" : "#ffffff");
    try { localStorage.setItem(THEME_STORAGE_KEY, darkMode ? "dark" : "light"); }
    catch { /* Keep the choice in this page. */ }
  }, [darkMode]);
  useEffect(() => {
    if (!selectedSubject || !snapshot?.subjects.some((subject) => subject.title === selectedSubject))
      return;
    try { sessionStorage.setItem(LAST_SUBJECT_KEY, selectedSubject); }
    catch { /* Keep subject selection available in this page. */ }
  }, [selectedSubject, snapshot?.subjects]);
  useEffect(() => {
    try { localStorage.setItem(POMODORO_MODE_KEY, pomodoroMode ? "pomodoro" : "normal"); }
    catch { /* Keep the choice in this page. */ }
  }, [pomodoroMode]);
  useEffect(() => {
    if (["running", "paused", "transition"].includes(pomodoro.status) && !pomodoroMode)
      setPomodoroMode(true);
  }, [pomodoro.status, pomodoroMode]);
  useEffect(() => {
    if (!session?.authenticated) return;
    try { sessionStorage.setItem(POMODORO_KEY, JSON.stringify(pomodoro)); }
    catch { /* Keep the cycle in this page. */ }
  }, [pomodoro, session?.authenticated]);
  useEffect(() => {
    if (!session?.authenticated) return;
    try { sessionStorage.setItem(POMODORO_SETTINGS_KEY, JSON.stringify(pomodoroSettings)); }
    catch { /* Keep the setting in this page. */ }
  }, [pomodoroSettings, session?.authenticated]);

  useEffect(() => {
    if (snapshot && !wakeRunning) setKeepScreenOn(false);
  }, [snapshot, wakeRunning]);
  useEffect(() => {
    if (!keepScreenOn || !wakeRunning || !session?.authenticated) {
      setScreenAwake(false);
      return;
    }
    if (!window.isSecureContext || !("wakeLock" in navigator)) {
      setWakeError("이 브라우저에서는 화면 켜두기를 사용할 수 없습니다.");
      setKeepScreenOn(false);
      return;
    }
    let cancelled = false;
    let lock: WakeLockSentinel | null = null;
    async function acquire() {
      if (document.visibilityState !== "visible" || lock || cancelled) return;
      try {
        const requested = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await requested.release();
          return;
        }
        lock = requested;
        setScreenAwake(true);
        setWakeError("");
        requested.addEventListener("release", () => {
          if (lock !== requested || cancelled) return;
          lock = null;
          setScreenAwake(false);
          setWakeError("화면 켜두기가 해제되었습니다. 필요하면 다시 켜 주세요.");
          setKeepScreenOn(false);
        });
      } catch {
        if (!cancelled) {
          setWakeError("화면 켜두기를 시작하지 못했습니다. 브라우저나 절전 설정을 확인해 주세요.");
          setKeepScreenOn(false);
        }
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        setScreenAwake(false);
        setWakeError("다른 화면으로 이동해 화면 켜두기를 해제했습니다. 웹 타이머는 계속됩니다.");
        setKeepScreenOn(false);
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (lock) void lock.release();
    };
  }, [keepScreenOn, wakeRunning, session?.authenticated]);

  const getHistoryDay = useCallback((requestedDate: string, force = false) => {
    const pending = historyRequests.current.get(requestedDate);
    if (pending) return pending;
    const cached = historyCache.current.get(requestedDate);
    if (!force && cached && Date.now() - cached.checkedAt < HISTORY_CACHE_MS)
      return Promise.resolve(cached.day);
    const epoch = authEpoch.current;
    const request = api<Day>(`/history?date=${encodeURIComponent(requestedDate)}`)
      .then((result) => {
        if (result.date !== requestedDate)
          throw new Error("요청한 날짜의 기록을 확인할 수 없습니다.");
        if (epoch === authEpoch.current) {
          if (historyCache.current.size >= 50) {
            const oldest = historyCache.current.keys().next().value;
            if (oldest) historyCache.current.delete(oldest);
          }
          historyCache.current.set(requestedDate, { day: result, checkedAt: Date.now() });
        }
        return result;
      })
      .finally(() => {
        if (historyRequests.current.get(requestedDate) === request)
          historyRequests.current.delete(requestedDate);
      });
    historyRequests.current.set(requestedDate, request);
    return request;
  }, []);

  useEffect(() => {
    if (previousTab.current === tab) return;
    previousTab.current = tab;
    window.scrollTo(0, 0);
  }, [tab]);

  const loadSnapshot = useCallback(async (force = false) => {
    const requestId = snapshotGate.current.start(force);
    if (requestId === null) return;
    const epoch = authEpoch.current;
    setRefreshingSnapshot(true);
    try {
      const result = await api<Snapshot>("/snapshot");
      if (!snapshotGate.current.isCurrent(requestId) || epoch !== authEpoch.current)
        return;
      setSnapshot(result);
      setClockOffset(
        result.serverNow - Date.now() + (result.upstreamClockOffsetMs ?? 0),
      );
      setDate((old) => old || result.today.date);
      setSelectedSubject((old) =>
        result.subjects.some((subject) => subject.title === old)
          ? old
          : result.subjects[0]?.title || "",
      );
      setNow(Date.now());
      setSnapshotCheckedAt(Date.now());
      setError("");
      return result;
    } catch (cause) {
      if (!snapshotGate.current.isCurrent(requestId) || epoch !== authEpoch.current)
        return;
      if ((cause as ApiError).status === 401) {
        clearPersonalTools();
        setTimerContinuity(null);
        rememberAccountLabel("");
        setAccountLabel("");
        setPomodoro(freshPomodoro());
        setPomodoroSettings(parseIntervalSettings(null));
        setPomodoroDraft({ focus: "25", short: "5" });
        setPomodoroError("");
        setFocusTask(null);
        authEpoch.current++;
        snapshotGate.current.invalidate();
        groupGate.current.invalidate();
        historyCache.current.clear();
        historyRequests.current.clear();
        forceHistoryDate.current = null;
        setTrends({});
        setRefreshingSnapshot(false);
        setSnapshot(null);
        setKeepScreenOn(false);
        setWakeError("");
        setSnapshotCheckedAt(null);
        setGroups(null);
        setMemberSnapshots({});
        setGroupMemberCounts({});
        setMemberErrors({});
        setLoadingMemberIds(new Set());
        setSelectedGroup(null);
        setLoadingGroup(false);
        setLoadingDay(false);
        memberRequests.current.clear();
        lastMemberGroup.current = null;
        setDay(null);
        setDate("");
        setSelectedSubject("");
        setError("");
        setHistoryError("");
        setGroupError("");
        setMemberQuery("");
        setMemberSort("time");
        setMemberFilter("all");
        navigateTab("study", true);
        setLoginNotice(
          cause instanceof Error ? cause.message : "다시 로그인해 주세요.",
        );
        setSession({ authenticated: false });
        csrf = "";
      } else
        setError(
          cause instanceof Error
            ? cause.message
            : "상태를 확인하지 못했습니다.",
        );
    } finally {
      if (snapshotGate.current.finish(requestId) && epoch === authEpoch.current)
        setRefreshingSnapshot(false);
    }
    return null;
  }, [navigateTab]);
  useEffect(() => {
    let active = true;
    api<Session>("/session")
      .then((result) => {
        if (!active) return;
        csrf = result.csrf ?? "";
        if (!result.authenticated) {
          clearPersonalTools();
          setTimerContinuity(null);
          rememberAccountLabel("");
          setAccountLabel("");
          setPomodoro(freshPomodoro());
          setPomodoroSettings(parseIntervalSettings(null));
          setPomodoroDraft({ focus: "25", short: "5" });
        }
        setSessionLoadError(false);
        setSession(result);
        if (result.authenticated) void loadSnapshot();
      })
      .catch(() => {
        if (active) setSessionLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [loadSnapshot, sessionAttempt]);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!session?.authenticated) {
      document.title = "YPT Web · 로그인";
      return;
    }
    const startedAt = snapshot?.timer.state === "running" && snapshot.timer.startedAt !== null
      ? snapshot.timer.startedAt
      : snapshot?.remoteStatus === "running" ? snapshot.remoteStartedAt : null;
    const subject = snapshot?.timer.subject ?? snapshot?.remoteSubject;
    const elapsed = startedAt !== null && startedAt !== undefined
      ? (subject ? timerContinuityElapsed(timerContinuity, subject, startedAt, now + clockOffset) : null)
        ?? Math.max(0, now + clockOffset - startedAt)
      : null;
    document.title = elapsed !== null
      ? `${duration(elapsed)} · YPT Web`
      : "YPT Web · 공부";
  }, [session?.authenticated, snapshot, timerContinuity, now, clockOffset]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        lastVisibleAt.current = Date.now();
        void loadSnapshot();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(onVisible, syncSeconds * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [session?.authenticated, loadSnapshot, syncSeconds]);
  useEffect(() => {
    if (tab !== "history" || !date || !session?.authenticated) return;
    if (snapshot?.today.date === date) {
      setDay(null);
      setLoadingDay(false);
      setHistoryError("");
      return;
    }
    const force = forceHistoryDate.current === date;
    if (force) forceHistoryDate.current = null;
    const cached = historyCache.current.get(date);
    if (!force && cached && Date.now() - cached.checkedAt < HISTORY_CACHE_MS) {
      setDay(cached.day);
      setLoadingDay(false);
      setHistoryError("");
      return;
    }
    let active = true;
    setLoadingDay(true);
    setHistoryError("");
    getHistoryDay(date, force)
      .then((result) => {
        if (active) {
          setDay(result);
          setHistoryError("");
        }
      })
      .catch((cause) => {
        if (active)
          setHistoryError(
            cause instanceof Error
              ? cause.message
              : "기록을 가져오지 못했습니다.",
          );
      })
      .finally(() => {
        if (active) setLoadingDay(false);
      });
    return () => {
      active = false;
    };
  }, [tab, date, session?.authenticated, snapshot?.today.date, historyRefresh, getHistoryDay]);
  const loadGroups = useCallback(async (includeCounts = false) => {
    const requestId = groupGate.current.start();
    if (requestId === null) return;
    const epoch = authEpoch.current;
    setLoadingGroup(true);
    try {
      if (includeCounts) {
        type GroupOverview = {
          groups: Group[];
          counts: Record<string, number>;
          selected: { groupId: number; members: Member[]; checkedAt: number } | null;
        };
        let result: GroupOverview;
        try {
          result = await api<GroupOverview>("/groups/overview");
        } catch (cause) {
          if ((cause as ApiError).status !== 404) throw cause;
          // Keep Pages compatible while an older Worker is still deployed.
          const fallback = await api<{ groups: Group[] }>("/groups");
          const counts: Record<string, number> = {};
          let selected: GroupOverview["selected"] = null;
          for (let index = 0; index < fallback.groups.length; index += 2) {
            const batch = fallback.groups.slice(index, index + 2);
            const rows = await Promise.allSettled(batch.map(async (group) => ({
              group,
              snapshot: await api<{ members: Member[]; checkedAt: number }>(
                `/groups/${group.id}/members`,
              ),
            })));
            rows.forEach((row) => {
              if (row.status !== "fulfilled") return;
              counts[String(row.value.group.id)] = row.value.snapshot.members.length;
              if (row.value.group.id === fallback.groups[0]?.id)
                selected = {
                  groupId: row.value.group.id,
                  members: row.value.snapshot.members,
                  checkedAt: row.value.snapshot.checkedAt,
                };
            });
          }
          result = { groups: fallback.groups, counts, selected };
        }
        if (!groupGate.current.isCurrent(requestId) || epoch !== authEpoch.current)
          return;
        setGroups(result.groups);
        setGroupMemberCounts(Object.fromEntries(
          Object.entries(result.counts)
            .map(([id, count]) => [Number(id), count])
            .filter(([id, count]) =>
              Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(count) && count >= 0),
        ));
        if (result.selected) {
          const selected = result.selected;
          setMemberSnapshots((current) => ({
            ...current,
            [selected.groupId]: { members: selected.members, checkedAt: selected.checkedAt },
          }));
        }
        setSelectedGroup((old) =>
          old && result.groups.some((g) => g.id === old)
            ? old
            : (result.groups[0]?.id ?? null),
        );
      } else {
        const result = await api<{ groups: Group[] }>("/groups");
        if (!groupGate.current.isCurrent(requestId) || epoch !== authEpoch.current)
          return;
        setGroups(result.groups);
        setSelectedGroup((old) =>
          old && result.groups.some((g) => g.id === old)
            ? old
            : (result.groups[0]?.id ?? null),
        );
      }
      setGroupError("");
    } catch (cause) {
      if (!groupGate.current.isCurrent(requestId) || epoch !== authEpoch.current)
        return;
      setGroupError(
        cause instanceof Error ? cause.message : "그룹을 가져오지 못했습니다.",
      );
    } finally {
      if (groupGate.current.finish(requestId) && epoch === authEpoch.current)
        setLoadingGroup(false);
    }
  }, []);
  const loadMembers = useCallback(async (id: number) => {
    if (memberRequests.current.has(id)) return;
    const requestId = ++memberRequestSequence.current;
    memberRequests.current.set(id, requestId);
    const epoch = authEpoch.current;
    setLoadingMemberIds((current) => new Set(current).add(id));
    setMemberErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const result = await api<{ members: Member[]; checkedAt: number }>(
        `/groups/${id}/members`,
      );
      if (memberRequests.current.get(id) !== requestId || epoch !== authEpoch.current)
        return;
      setMemberSnapshots((current) => ({
        ...current,
        [id]: { members: result.members, checkedAt: result.checkedAt },
      }));
      setGroupMemberCounts((current) => ({ ...current, [id]: result.members.length }));
      setMemberErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch (cause) {
      if (memberRequests.current.get(id) !== requestId || epoch !== authEpoch.current)
        return;
      setMemberErrors((current) => ({
        ...current,
        [id]: cause instanceof Error
          ? cause.message
          : "멤버 상태를 가져오지 못했습니다.",
      }));
    } finally {
      if (memberRequests.current.get(id) === requestId) {
        memberRequests.current.delete(id);
        if (epoch === authEpoch.current)
          setLoadingMemberIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
      }
    }
  }, []);
  useEffect(() => {
    if (tab === "groups" && session?.authenticated)
      void loadGroups(true);
  }, [tab, session?.authenticated, loadGroups]);
  useEffect(() => {
    if (tab !== "groups" || !session?.authenticated) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadGroups(false);
    };
    document.addEventListener("visibilitychange", refresh);
    const interval = setInterval(refresh, groupListRefreshMs(syncSeconds));
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(interval);
    };
  }, [tab, session?.authenticated, loadGroups, syncSeconds]);
  useEffect(() => {
    if (tab !== "groups" || !session?.authenticated) return;
    if (lastMemberGroup.current !== selectedGroup) {
      lastMemberGroup.current = selectedGroup;
      setMemberQuery("");
      setMemberFilter("all");
    }
    if (selectedGroup === null) return;
    void loadMembers(selectedGroup);
  }, [tab, selectedGroup, session?.authenticated, loadMembers]);
  useEffect(() => {
    if (tab !== "groups" || selectedGroup === null || !session?.authenticated)
      return;
    const refresh = () => {
      if (document.visibilityState === "visible")
        void loadMembers(selectedGroup);
    };
    document.addEventListener("visibilitychange", refresh);
    const interval = setInterval(refresh, syncSeconds * 1000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(interval);
    };
  }, [tab, selectedGroup, session?.authenticated, loadMembers, syncSeconds]);
  useEffect(() => {
    const key = snapshot?.timer
      ? `${snapshot.timer.state}:${snapshot.timer.startedAt ?? ""}`
      : null;
    if (
      previousTimerKey.current !== null && key !== null &&
      previousTimerKey.current !== key && tab === "groups" &&
      selectedGroup !== null && session?.authenticated
    )
      void loadMembers(selectedGroup);
    previousTimerKey.current = key;
  }, [snapshot?.timer.state, snapshot?.timer.startedAt, tab, selectedGroup, session?.authenticated, loadMembers]);
  async function change(
    action: "start" | "pause" | "resume" | "stop" | "resolve",
  ): Promise<Snapshot | null> {
    if (!snapshot || inFlight.current) return null;
    const activeStartedAt = snapshot.timer.state === "running" && snapshot.timer.startedAt !== null
      ? snapshot.timer.startedAt
      : snapshot.remoteStatus === "running" ? snapshot.remoteStartedAt : null;
    const activeSubject = snapshot.timer.subject ?? snapshot.remoteSubject ?? selectedSubject;
    const actionRequestedAt = Date.now();
    const pauseElapsedAt = actionRequestedAt + clockOffset;
    const epoch = authEpoch.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api(
        `/timer/${action}`,
        "POST",
        action === "resolve"
          ? { confirmedStopped: true }
          : {
              revision: snapshot.timer.revision,
              operationId: crypto.randomUUID(),
              subject: selectedSubject,
            },
      );
      if (epoch !== authEpoch.current) return null;
      const updated = await loadSnapshot(true) ?? null;
      if (!updated) return null;
      const updatedStartedAt = updated.timer.state === "running" && updated.timer.startedAt !== null
        ? updated.timer.startedAt
        : updated.remoteStatus === "running" ? updated.remoteStartedAt : null;
      const updatedSubject = updated.timer.subject ?? updated.remoteSubject ?? selectedSubject;
      const isRunning = updatedStartedAt !== null && updatedStartedAt !== undefined &&
        (updated.timer.state === "running" || updated.remoteStatus === "running");
      if (action === "start" && isRunning && updatedSubject)
        setTimerContinuity(startTimerContinuity(updatedSubject, updatedStartedAt));
      else if (action === "pause" && updated.timer.state === "paused" &&
        activeStartedAt !== null && activeStartedAt !== undefined && activeSubject)
        setTimerContinuity((current) => pauseTimerContinuity(
          current, activeSubject, activeStartedAt, pauseElapsedAt, actionRequestedAt,
        ));
      else if (action === "resume" && isRunning && updatedSubject)
        setTimerContinuity((current) => resumeTimerContinuity(
          current, updatedSubject, updatedStartedAt, actionRequestedAt,
        ));
      else if ((action === "stop" || action === "resolve") &&
        updated.timer.state === "idle" && updated.remoteStatus === "idle")
        setTimerContinuity(null);
      return updated;
    } catch (cause) {
      if (epoch !== authEpoch.current) return null;
      await loadSnapshot(true);
      setError(
        cause instanceof Error
          ? cause.message
          : "타이머 결과를 확인하지 못했습니다.",
      );
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function pomodoroMutation(action: "start" | "pause" | "resume" | "stop", next: (timer: Pomodoro, now: number) => Pomodoro) {
    if (pomodoroAction.current || busy) return;
    pomodoroAction.current = true;
    const current = pomodoro;
    setPomodoro({ ...current, remainingMs: pomodoroRemaining(current, Date.now() + clockOffset), endsAt: null, status: "transition" });
    const result = await change(action);
    const expected = action === "start" || action === "resume" ? "running" : action === "pause" ? "paused" : "idle";
    const anchorAt = result === null ? null
      : action === "start" || action === "resume"
        ? result.timer.startedAt ?? result.remoteStartedAt
        : action === "pause"
          ? result.timer.updatedAt + (result.upstreamClockOffsetMs ?? 0)
          : Date.now() + clockOffset;
    const confirmed = result?.timer.state === expected && result.remoteStatus !== "unverified";
    if (result && confirmed && anchorAt !== null) {
      setPomodoro(next(current, anchorAt));
      setPomodoroError("");
    } else {
      setPomodoro((old) => ({ ...old, status: "halted" }));
      setPomodoroError("열품타 상태를 확실히 확인하지 못해 자동 전환을 멈췄습니다. 앱과 웹 상태를 확인한 뒤 뽀모도로를 초기화해 주세요.");
    }
    pomodoroAction.current = false;
  }
  function adjustPomodoroDraft(field: "focus" | "short", amount: -1 | 1) {
    const [minimum, maximum] = field === "focus" ? [5, 180] : [1, 60];
    setPomodoroDraft((old) => {
      const current = Number(old[field]);
      const value = Number.isFinite(current) ? Math.trunc(current) : minimum;
      return { ...old, [field]: String(Math.max(minimum, Math.min(maximum, value + amount))) };
    });
  }
  useEffect(() => {
    if (!session?.authenticated || !pomodoroMode || pomodoro.status !== "running" || pomodoro.endsAt === null)
      return;
    const delay = Math.max(0, pomodoro.endsAt - (Date.now() + clockOffset) + 50);
    const boundary = window.setTimeout(() => {
      if (document.visibilityState === "visible") void loadSnapshot(true);
    }, delay);
    return () => window.clearTimeout(boundary);
  }, [session?.authenticated, pomodoroMode, pomodoro.status, pomodoro.endsAt, clockOffset, loadSnapshot]);
  useEffect(() => {
    if (!session?.authenticated || !pomodoroMode || !snapshot || pomodoro.status === "idle" ||
      pomodoro.status === "transition" || pomodoro.status === "halted" || pomodoroAction.current) return;
    const expected = pomodoro.phase === "focus" && pomodoro.status === "running" ? "running" : "paused";
    if (snapshot.timer.state !== expected || snapshot.remoteStatus === "unverified") {
      setPomodoro((old) => ({ ...old, status: "halted", remainingMs: pomodoroRemaining(old, now + clockOffset), endsAt: null }));
      setPomodoroError("열품타 타이머 상태가 바뀌어 뽀모도로 자동 전환을 멈췄습니다. 상태를 확인하고 초기화해 주세요.");
      return;
    }
    if (!shouldAdvancePomodoro(pomodoro, now + clockOffset, document.visibilityState === "visible",
      snapshotCheckedAt, lastVisibleAt.current) || busy) return;
    const action = pomodoro.phase === "focus" ? "pause" : "resume";
    void pomodoroMutation(action, (current, finishedAt) =>
      nextPomodoro(current, finishedAt, pomodoroSettings.focus, pomodoroSettings.short));
  }, [now, clockOffset, pomodoro, snapshot, snapshotCheckedAt, busy, session?.authenticated, pomodoroMode, pomodoroSettings]);
  async function logout() {
    if (loggingOut || busy) return;
    setLoggingOut(true);
    let clearLocalSession = false;
    try {
      await api("/logout", "POST", {});
      clearLocalSession = true;
    } catch (cause) {
      if ((cause as ApiError).status === 401) clearLocalSession = true;
      else setError(
        cause instanceof Error ? cause.message : "로그아웃하지 못했습니다.",
      );
    } finally {
      if (clearLocalSession) {
        setSettingsOpen(false);
        clearPersonalTools();
        setTimerContinuity(null);
        rememberAccountLabel("");
        setAccountLabel("");
        authEpoch.current++;
        historyCache.current.clear();
        historyRequests.current.clear();
        forceHistoryDate.current = null;
        setTrends({});
        snapshotGate.current.invalidate();
        groupGate.current.invalidate();
        memberRequests.current.clear();
        lastMemberGroup.current = null;
        csrf = "";
        setSession({ authenticated: false });
        setSnapshot(null);
        setKeepScreenOn(false);
        setWakeError("");
        setSnapshotCheckedAt(null);
        setRefreshingSnapshot(false);
        setGroups(null);
        setMemberSnapshots({});
        setGroupMemberCounts({});
        setMemberErrors({});
        setLoadingMemberIds(new Set());
        setLoadingGroup(false);
        setLoadingDay(false);
        setSelectedGroup(null);
        setError("");
        setGroupError("");
        setMemberQuery("");
        setMemberSort("time");
        setMemberFilter("all");
        setHistoryError("");
        setDay(null);
        setSelectedSubject("");
        setPomodoro(freshPomodoro());
        setPomodoroSettings(parseIntervalSettings(null));
        setPomodoroDraft({ focus: "25", short: "5" });
        setPomodoroError("");
        setFocusTask(null);
        setDate("");
        navigateTab("study", true);
        setLoginNotice("");
        setRememberWarning("");
      }
      setLoggingOut(false);
    }
  }
  if (session === null)
    return (
      <div className="loading-screen">
        {sessionLoadError ? (
          <div className="connection-error">
            <p>서버에 연결하지 못했습니다.</p>
            <button
              className="secondary"
              onClick={() => {
                setSessionLoadError(false);
                setSessionAttempt((old) => old + 1);
              }}
            >
              다시 연결
            </button>
          </div>
        ) : (
          "연결 확인 중…"
        )}
      </div>
    );
  if (!session.authenticated)
    return (
      <Login
        notice={loginNotice}
        darkMode={darkMode}
        onToggleTheme={() => setDarkMode((old) => !old)}
        onLogin={async (warning, identity) => {
          clearPersonalTools();
          setSelectedSubject("");
          setTimerContinuity(null);
          rememberAccountLabel(identity);
          setAccountLabel(identity);
          setPomodoro(freshPomodoro(pomodoroSettings.focus));
          setPomodoroError("");
          authEpoch.current++;
          snapshotGate.current.invalidate();
          groupGate.current.invalidate();
          historyCache.current.clear();
          historyRequests.current.clear();
          forceHistoryDate.current = null;
          setTrends({});
          setWakeError("");
          setSession({ authenticated: true, csrf });
          setError("");
          setLoginNotice("");
          await loadSnapshot();
          setRememberWarning(warning);
        }}
      />
    );
  const timer = snapshot?.timer;
  const selectedSubjectColor = snapshot?.subjects.find(
    (subject) => subject.title === selectedSubject,
  )?.color;
  const remoteActive = snapshot?.remoteStatus === "running";
  const remoteUnverified = snapshot?.remoteStatus === "unverified";
  const appOnly = timer?.state === "idle" && remoteActive;
  const running =
    (timer?.state === "running" && timer.startedAt !== null) || appOnly;
  const pomodoroActive = pomodoroMode && ["running", "paused", "transition"].includes(pomodoro.status);
  const timerCaptionSubject = timer?.subject || snapshot?.remoteSubject;
  const liveStartedAt = timer?.state === "running" && timer.startedAt !== null
    ? timer.startedAt : snapshot?.remoteStatus === "running" ? snapshot.remoteStartedAt : null;
  const liveMs = running && liveStartedAt !== null && liveStartedAt !== undefined
    ? (timerCaptionSubject
      ? timerContinuityElapsed(timerContinuity, timerCaptionSubject, liveStartedAt, now + clockOffset)
      : null) ?? Math.max(0, now + clockOffset - liveStartedAt)
    : 0;
  let status = "상태 확인 중";
  if (timer) {
    if (remoteUnverified || (timer.state === "running" && timer.startedAt === null))
      status = "상태 확인 필요";
    else if (appOnly) status = "앱에서 공부 중";
    else if (timer.state === "running") status = "공부 중";
    else if (timer.state === "paused") status = "일시정지";
    else if (timer.state === "idle") status = "대기 중";
    else if (timer.state === "starting" || timer.state === "stopping")
      status = "요청 처리 중";
    else status = "상태 확인 필요";
  }
  const displayedDay = date === snapshot?.today.date
    ? snapshot.today
    : day?.date === date ? day : null;
  const selectedGroupDetails = groups?.find((group) => group.id === selectedGroup);
  const selectedMemberSnapshot = selectedGroup === null
    ? null
    : memberSnapshots[selectedGroup] ?? null;
  const shownMembers = selectedMemberSnapshot?.members ?? null;
  const groupCheckedAt = selectedMemberSnapshot?.checkedAt ?? null;
  const loadingMembers = selectedGroup !== null && loadingMemberIds.has(selectedGroup);
  const memberError = selectedGroup === null ? "" : memberErrors[selectedGroup] ?? "";
  const memberCounts = shownMembers ? {
    studying: shownMembers.filter((member) => member.studying === true).length,
    resting: shownMembers.filter((member) => member.studying === false).length,
    unknown: shownMembers.filter((member) => member.studying === null).length,
  } : null;
  const pendingRecoveryWait =
    timer !== undefined &&
    (timer.state === "starting" || timer.state === "stopping") &&
    now - timer.updatedAt < PENDING_RECOVERY_MS;
  const statusStale =
    snapshotCheckedAt !== null &&
    now - snapshotCheckedAt > statusStaleAfterMs(syncSeconds);
  const visibleMembers = shownMembers
    ?.filter((member) => {
      const matchesName = member.nickname
        .toLocaleLowerCase("ko-KR")
        .includes(memberQuery.trim().toLocaleLowerCase("ko-KR"));
      const matchesStatus = memberFilter === "all" ||
        (memberFilter === "studying" && member.studying === true) ||
        (memberFilter === "resting" && member.studying === false) ||
        (memberFilter === "unknown" && member.studying === null);
      return matchesName && matchesStatus;
    })
    .sort((a, b) => {
      const nameOrder = a.nickname.localeCompare(b.nickname, "ko-KR");
      if (memberSort === "name") return nameOrder;
      if (memberSort === "status") {
        const rank = (value: boolean | null) => value === true ? 0 : value === false ? 1 : 2;
        const statusOrder = rank(a.studying) - rank(b.studying);
        if (statusOrder) return statusOrder;
      }
      const timeOrder = (b.studyMs ?? -1) - (a.studyMs ?? -1);
      return timeOrder || nameOrder;
    });
  const pageInfo = PAGE_INFO[tab];
  const mobileActiveTab = tab === "insights" ? "history" : tab;
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">본문으로 이동</a>
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <span>YPT WEB</span>
        </div>
        <nav aria-label="메뉴">
          {SIDEBAR_SECTIONS.map((section) => (
            <div className="sidebar-nav-group" key={section.title}>
              <span className="sidebar-nav-label">{section.title}</span>
              {section.items.map((item) => (
                <button
                  key={item.tab}
                  className={tab === item.tab ? "active" : ""}
                  aria-current={tab === item.tab ? "page" : undefined}
                  onClick={() => navigateTab(item.tab)}
                >
                  <NavIcon tab={item.tab} />{item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <SettingsMenu
            className="sidebar-settings"
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            accountLabel={accountLabel}
            syncSeconds={syncSeconds}
            onSyncSecondsChange={(seconds) => {
              if (!SYNC_SECONDS.some((value) => value === seconds)) return;
              setSyncSeconds(seconds);
              try { localStorage.setItem(SYNC_STORAGE_KEY, String(seconds)); }
              catch { /* Storage can be unavailable in private browsing. */ }
            }}
          />
          <button className="sidebar-logout" type="button" disabled={loggingOut || busy}
            onClick={() => void logout()}>
            {loggingOut ? "로그아웃 중…" : "로그아웃"}
          </button>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="mobile-brand">
            <BrandMark />
            <span>YPT WEB</span>
          </div>
          <div className="topbar-status-row">
            <div
              className={`top-status ${statusStale ? "stale" : ""}`}
              title={statusStale ? "최근 상태 확인이 지연되고 있습니다." : undefined}
            >
              <span
                className={`status-dot ${running && !remoteUnverified && !statusStale ? "live" : ""}`}
              />
              {statusStale ? `${status} · 갱신 지연` : status}
              {(timer?.subject || snapshot?.remoteSubject) && (
                <span className="status-subject">
                  {" · "}
                  {timer?.subject || snapshot?.remoteSubject}
                </span>
              )}
              {pomodoroActive ? <strong>{pomodoro.phase === "focus" ? "집중" : "휴식"} {countdown(pomodoroRemaining(pomodoro, now + clockOffset))}</strong>
                : running && <strong>{duration(liveMs)}</strong>}
            </div>
            <ThemeToggle dark={darkMode} onToggle={() => setDarkMode((old) => !old)} />
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {rememberWarning && (
            <div className="remember-warning" role="status">
              {rememberWarning}
              <button onClick={() => setRememberWarning("")} aria-label="안내 닫기">×</button>
            </div>
          )}
          {tab !== "study" && (running || pomodoroActive) && (
            <div className="active-strip">
              <div>
                <span className="active-strip-label">
                  {pomodoroActive ? pomodoro.phase === "focus" ? "뽀모도로 집중" : "뽀모도로 휴식" : status}
                  {timer?.subject || snapshot?.remoteSubject
                    ? ` · ${timer?.subject || snapshot?.remoteSubject}`
                    : ""}
                </span>
                <strong>{pomodoroActive ? countdown(pomodoroRemaining(pomodoro, now + clockOffset)) : duration(liveMs)}</strong>
              </div>
              <button className="secondary" onClick={() => navigateTab("study")}
              >
                타이머 보기
              </button>
            </div>
          )}
          <div className="page-title">
            <div>
              <p className="eyebrow">{pageInfo.eyebrow}</p>
              <h1>{pageInfo.title}</h1>
              <p className="page-subtitle">{pageInfo.subtitle}</p>
            </div>
            <div className="page-controls">
              <SettingsMenu
                className="mobile-settings-menu"
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                accountLabel={accountLabel}
                syncSeconds={syncSeconds}
                onSyncSecondsChange={(seconds) => {
                  if (!SYNC_SECONDS.some((value) => value === seconds)) return;
                  setSyncSeconds(seconds);
                  try { localStorage.setItem(SYNC_STORAGE_KEY, String(seconds)); }
                  catch { /* Storage can be unavailable in private browsing. */ }
                }}
              />
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="알림 닫기">
                ×
              </button>
            </div>
          )}
          {(tab === "history" || tab === "insights") && (
            <nav className="mobile-page-switcher" aria-label="기록 메뉴">
              <button className={tab === "history" ? "active" : ""}
                aria-current={tab === "history" ? "page" : undefined}
                onClick={() => navigateTab("history")}>날짜별 기록</button>
              <button className={tab === "insights" ? "active" : ""}
                aria-current={tab === "insights" ? "page" : undefined}
                onClick={() => navigateTab("insights")}>기간 분석</button>
            </nav>
          )}
          {tab === "study" && (
            <>
            <div className="study-grid timer-home-grid">
              <section className={`timer-card ${pomodoroMode ? "is-pomodoro-mode" : "is-normal-mode"}`}>
                <div className="card-head">
                  <span>현재 타이머</span>
                  <button
                    className="text-button"
                    disabled={refreshingSnapshot}
                    onClick={() => void loadSnapshot()}
                  >
                    {refreshingSnapshot ? "확인 중…" : "상태 새로고침"}
                  </button>
                </div>
                <div className="timer-mode" role="group" aria-label="타이머 방식">
                  <button type="button" aria-pressed={!pomodoroMode} disabled={pomodoroActive}
                    onClick={() => setPomodoroMode(false)}>일반 타이머</button>
                  <button type="button" aria-pressed={pomodoroMode} disabled={pomodoroActive}
                    onClick={() => setPomodoroMode(true)}>뽀모도로</button>
                </div>
                <p className="timer-mode-description">
                  {pomodoroMode ? "뽀모도로 · 집중과 휴식을 자동으로 전환합니다." : "일반 타이머 · 시작, 일시정지, 종료를 직접 조작합니다."}
                </p>
                <div className={`timer-face ${running ? "is-running" : ""}`}>
                  <div className="timer-face-inner">
                    <span className="timer-face-kicker">{pomodoroActive
                      ? pomodoro.phase === "focus" ? `집중 ${pomodoro.rounds + 1}회차` : `휴식 ${pomodoro.rounds}회차`
                      : "나의 집중 시간"}</span>
                    <div className="timer-display" aria-live="off">
                      {pomodoroActive
                        ? countdown(pomodoroRemaining(pomodoro, now + clockOffset))
                        : running
                        ? duration(liveMs)
                        : timer?.state === "paused"
                          ? "--:--:--"
                          : "00:00:00"}
                    </div>
                    <div className="timer-caption">
                      {(pomodoroActive ? pomodoroStatusLabel(pomodoro) : status) &&
                        <span className="timer-caption-label">
                          {pomodoroActive ? pomodoroStatusLabel(pomodoro) : status}
                        </span>}
                      {timerCaptionSubject && <span className="timer-caption-subject">과목 · {timerCaptionSubject}</span>}
                    </div>
                    {pomodoroActive && pomodoro.phase === "focus" && focusTask && focusTask.date === snapshot?.today.date && focusTask.text &&
                      <span className="pomodoro-task">{focusTask.text}</span>}
                  </div>
                </div>
                {timer?.state === "idle" && !appOnly && !pomodoroActive && (
                  <div className="form-area">
                    <label htmlFor="subject">과목</label>
                    <div className="subject-select">
                      {selectedSubjectColor && (
                        <span
                          className="subject-color"
                          aria-hidden="true"
                          style={{ backgroundColor: selectedSubjectColor }}
                        />
                      )}
                      <select
                        id="subject"
                        value={selectedSubject}
                        onChange={(event) =>
                          setSelectedSubject(event.target.value)
                        }
                      >
                        {snapshot?.subjects.map((subject) => (
                          <option key={subject.title} value={subject.title}>
                            {subject.title}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                <div className="timer-actions">
                  {timer?.state === "idle" && !appOnly && !pomodoroActive && (
                    <button
                      className="primary"
                      disabled={busy || !selectedSubject || remoteUnverified}
                      onClick={() => pomodoroMode
                        ? void pomodoroMutation("start", (_old, at) => runPomodoro(freshPomodoro(pomodoroSettings.focus), at))
                        : void change("start")}
                    >
                      {pomodoroMode ? "뽀모도로 시작" : "공부 시작"}
                    </button>
                  )}
                  {pomodoroActive && pomodoro.status !== "transition" && <>
                    <button className="primary" type="button" disabled={busy || remoteUnverified}
                      onClick={() => {
                        if (pomodoro.phase === "break") {
                          setPomodoro((old) => old.status === "running"
                            ? pausePomodoro(old, Date.now() + clockOffset) : runPomodoro(old, Date.now() + clockOffset));
                        } else {
                          void pomodoroMutation(pomodoro.status === "running" ? "pause" : "resume",
                            (old, at) => old.status === "running" ? pausePomodoro(old, at) : runPomodoro(old, at));
                        }
                      }}>
                      {pomodoro.status === "running" ? "잠시 멈춤" : "계속"}
                    </button>
                    <button className="secondary" type="button" disabled={busy}
                      onClick={() => void pomodoroMutation("stop", () => freshPomodoro(pomodoroSettings.focus))}>
                      공부 끝내기
                    </button>
                  </>}
                  {!pomodoroActive && timer?.state === "running" && (
                    <>
                      <button
                        className="primary"
                        disabled={busy || remoteUnverified}
                        onClick={() => void change("pause")}
                      >
                        일시정지
                      </button>
                      <button
                        className="secondary"
                        disabled={busy || remoteUnverified}
                        onClick={() => void change("stop")}
                      >
                        공부 끝내기
                      </button>
                    </>
                  )}
                  {!pomodoroActive && timer?.state === "paused" && (
                    <>
                      <button
                        className="primary"
                        disabled={busy || remoteUnverified}
                        onClick={() => void change("resume")}
                      >
                        재개
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void change("stop")}
                      >
                        공부 끝내기
                      </button>
                    </>
                  )}
                  {timer &&
                    ["starting", "stopping", "uncertain"].includes(
                      timer.state,
                    ) && (
                      <button
                        className="secondary"
                        disabled={busy || pendingRecoveryWait}
                        onClick={() => void change("resolve")}
                      >
                        {pendingRecoveryWait
                          ? "요청 처리 중…"
                          : "앱에서 정지 확인 후 복구"}
                      </button>
                    )}
                </div>
                {pomodoroMode && <>
                  <p className="pomodoro-note" role="status">{pomodoroError || (pomodoro.status === "halted"
                    ? "이전 전환 결과를 확인할 수 없어 자동화를 멈췄습니다. 앱과 웹 상태를 확인한 뒤 초기화해 주세요."
                    : pomodoroActive
                      ? pomodoro.phase === "focus" ? "집중 종료 시 열품타를 일시정지합니다." : "휴식 종료 시 열품타를 재개합니다."
                      : "집중과 휴식이 열품타 공부 타이머에 연결됩니다.")}</p>
                  {pomodoro.status === "halted" && <button className="secondary pomodoro-reset" type="button"
                    onClick={() => { setPomodoro(freshPomodoro(pomodoroSettings.focus)); setPomodoroError(""); }}>
                    뽀모도로 초기화
                  </button>}
                  <details className="pomodoro-settings">
                    <summary>집중·휴식 길이</summary>
                    <form onSubmit={(event) => {
                      event.preventDefault();
                      const focus = Number(pomodoroDraft.focus);
                      const short = Number(pomodoroDraft.short);
                      if (!Number.isInteger(focus) || focus < 5 || focus > 180 ||
                        !Number.isInteger(short) || short < 1 || short > 60) {
                        setPomodoroError("집중은 5~180분, 휴식은 1~60분으로 입력해 주세요.");
                        return;
                      }
                      setPomodoroSettings((old) => ({ ...old, focus, short }));
                      if (pomodoro.status === "idle") setPomodoro(freshPomodoro(focus));
                      setPomodoroError("");
                    }}>
                      <div className="pomodoro-length-control">
                        <label htmlFor="pomodoro-focus-minutes">집중</label>
                        <div className="pomodoro-stepper">
                          <button className="secondary" type="button" aria-label="집중 시간 1분 줄이기"
                            disabled={Number(pomodoroDraft.focus) <= 5}
                            onClick={() => adjustPomodoroDraft("focus", -1)}>−</button>
                          <input id="pomodoro-focus-minutes" type="number" inputMode="numeric" min="5" max="180" value={pomodoroDraft.focus}
                            onChange={(event) => setPomodoroDraft((old) => ({ ...old, focus: event.target.value }))} />
                          <button className="secondary" type="button" aria-label="집중 시간 1분 늘리기"
                            disabled={Number(pomodoroDraft.focus) >= 180}
                            onClick={() => adjustPomodoroDraft("focus", 1)}>+</button>
                        </div>
                        <span>분</span>
                      </div>
                      <div className="pomodoro-length-control">
                        <label htmlFor="pomodoro-break-minutes">휴식</label>
                        <div className="pomodoro-stepper">
                          <button className="secondary" type="button" aria-label="휴식 시간 1분 줄이기"
                            disabled={Number(pomodoroDraft.short) <= 1}
                            onClick={() => adjustPomodoroDraft("short", -1)}>−</button>
                          <input id="pomodoro-break-minutes" type="number" inputMode="numeric" min="1" max="60" value={pomodoroDraft.short}
                            onChange={(event) => setPomodoroDraft((old) => ({ ...old, short: event.target.value }))} />
                          <button className="secondary" type="button" aria-label="휴식 시간 1분 늘리기"
                            disabled={Number(pomodoroDraft.short) >= 60}
                            onClick={() => adjustPomodoroDraft("short", 1)}>+</button>
                        </div>
                        <span>분</span>
                      </div>
                      <button className="secondary" type="submit">적용</button>
                    </form>
                    <p>진행 중 변경한 길이는 다음 구간부터 적용됩니다. 자동 전환은 웹 화면이 보일 때만 실행됩니다. 화면을 닫아도 열품타 타이머는 자동 종료되지 않습니다.</p>
                  </details>
                </>}
                {wakeRunning && <div className="screen-awake-control">
                  <button className="secondary" type="button"
                    disabled={!window.isSecureContext || !("wakeLock" in navigator)}
                    aria-pressed={keepScreenOn}
                    onClick={() => {
                      setWakeError("");
                      setKeepScreenOn((old) => !old);
                    }}>
                    {keepScreenOn ? "화면 켜두기 끄기" : "화면 켜두기"}
                  </button>
                  <span role="status">{wakeError || (screenAwake
                    ? "이 화면이 보이는 동안 켜져 있습니다."
                    : keepScreenOn ? "화면 켜두기 요청 중…"
                    : !window.isSecureContext || !("wakeLock" in navigator)
                      ? "이 브라우저에서 지원하지 않습니다."
                      : "선택하면 공부 중 화면이 꺼지지 않도록 요청합니다.")}</span>
                </div>}
                <details className="timer-help">
                  <summary>타이머 이용 안내</summary>
                  <p>일시정지는 과목을 기억해 재개할 수 있습니다. 공부 끝내기는 구간을 마무리하고 다음 시작 때 과목을 다시 고릅니다.</p>
                  <p>시작·재개 전에 서버가 앱 타이머 상태를 다시 확인합니다. 화면을 닫아도 타이머는 계속되며, 앱에서 시작한 공부도 여기서 제어할 수 있습니다.</p>
                  {pomodoroMode && <p>집중·휴식 길이는 설정의 − / + 버튼으로 1분씩 조절하거나 숫자를 입력한 뒤 적용할 수 있습니다.</p>}
                </details>
                {pendingRecoveryWait ? (
                  <p className="caution">
                    요청을 처리 중입니다. 같은 요청은 다시 보내지 않습니다. 처리
                    결과를 기다린 뒤 상태를 확인해 주세요.
                  </p>
                ) : timer &&
                  ["starting", "stopping", "uncertain"].includes(
                    timer.state,
                  ) && (
                    <p className="caution">
                      요청 결과가 불확실합니다. 열품타 앱에서 타이머를 정지한 뒤
                      복구하세요. 복구할 때 서버도 앱 상태를 다시 확인합니다.
                    </p>
                  )}
                {remoteUnverified && (
                  <p className="caution">
                    앱 타이머 상태를 확인할 수 없습니다. 상태를 새로고침한 뒤
                    조작해 주세요.
                  </p>
                )}
                {statusStale && (
                  <p className="caution">
                    최근 상태 확인이 지연되고 있습니다. 앱에서 상태를 확인하거나
                    새로고침해 주세요.
                  </p>
                )}
                {snapshotCheckedAt && (
                  <p className="checked-time">
                    마지막 상태 확인 {new Date(snapshotCheckedAt).toLocaleTimeString("ko-KR")}
                  </p>
                )}
              </section>
            </div>
            </>
          )}
          {tab === "today" && (
            <section className="summary-card today-summary">
              <div className="card-head">
                <span>오늘의 공부</span>
                {snapshot?.today && <CopyDayButton
                  key={`${snapshot.today.date}:${snapshot.today.totalMs}`}
                  day={snapshot.today} />}
              </div>
              <div className="summary-date">{snapshot?.today.date ?? "—"}</div>
              <div className="summary-time">{duration(snapshot?.today.totalMs)}</div>
              <p className="summary-label">기록된 총 공부시간</p>
              {snapshot?.today && (
                <DailyGoal minutes={goalMinutes} recordedMs={snapshot.today.totalMs}
                  liveMs={running && !statusStale && !remoteUnverified ? liveMs : 0}
                  onChange={(minutes) => {
                    if (!validGoalMinutes(minutes)) return;
                    setGoalMinutes(minutes);
                    try {
                      localStorage.setItem(GOAL_STORAGE_KEY, String(minutes));
                    } catch {
                      // The setting remains available in this tab.
                    }
                  }} />
              )}
              {running && (
                <div className="live-session">
                  <span>진행 중인 시간 · {timer?.subject || snapshot?.remoteSubject || "과목 미확인"}</span>
                  <strong>{duration(liveMs)}</strong>
                  <small>완료된 기록과 별도로 표시합니다.</small>
                </div>
              )}
              {snapshot?.today && <SubjectBreakdown day={snapshot.today}
                empty={snapshot.today.subjectTimesAvailable
                  ? "오늘 기록된 과목 시간이 없습니다."
                  : "오늘 과목별 시간을 확인할 수 없습니다."} />}
              {snapshot?.today && !snapshot.today.subjectTimesAvailable &&
                snapshot.today.subjects.length > 0 && (
                <p className="card-note">오늘의 과목별 시간은 확인되지 않았습니다.</p>
              )}
            </section>
          )}
          {tab === "plan" && (snapshot?.today
            ? <StudyTools key={snapshot.today.date} date={snapshot.today.date}
                today={snapshot.today} subjects={snapshot.subjects} onFocusTaskChange={reportFocusTask} />
            : <section className="tool-card"><p className="empty">오늘 정보를 불러오는 중입니다.</p></section>)}
          {tab === "history" && (
            <section className="history-card" id="history-top">
              <div className="history-picker">
                <label htmlFor="date">날짜</label>
                <input
                  id="date"
                  type="date"
                  value={date}
                  max={snapshot?.today.date}
                  disabled={!snapshot?.capabilities.history}
                  onChange={(event) => setDate(event.target.value)}
                />
                <div className="date-actions">
                  <button
                    className="secondary"
                    disabled={!date}
                    onClick={() => setDate(shiftDate(date, -1))}
                    aria-label="이전 날짜"
                  >
                    ← 이전
                  </button>
                  <button className="secondary"
                    disabled={!snapshot?.capabilities.history || date === shiftDate(snapshot.today.date, -1)}
                    onClick={() => setDate(shiftDate(snapshot!.today.date, -1))}>
                    어제
                  </button>
                  <button
                    className="secondary"
                    disabled={!snapshot || date === snapshot.today.date}
                    onClick={() => setDate(snapshot!.today.date)}
                  >
                    오늘
                  </button>
                  <button
                    className="secondary"
                    disabled={!date || !snapshot || date >= snapshot.today.date}
                    onClick={() => setDate(shiftDate(date, 1))}
                    aria-label="다음 날짜"
                  >
                    다음 →
                  </button>
                </div>
              </div>
              <div className="history-toolbar">
                <span>열품타의 공부 날짜 기준 기록</span>
                <div className="history-toolbar-actions">
                  {displayedDay && <CsvButton key={displayedDay.date}
                    filename={`ypt-day-${displayedDay.date}.csv`}
                    csv={formatDayCsv(displayedDay)} label="CSV 저장" />}
                  <button
                    className="text-button"
                    disabled={loadingDay || !date}
                    onClick={() => {
                      if (date === snapshot?.today.date) void loadSnapshot();
                      else {
                        forceHistoryDate.current = date;
                        setHistoryRefresh((old) => old + 1);
                      }
                    }}
                  >
                    새로고침
                  </button>
                </div>
              </div>
              {!snapshot?.capabilities.history && (
                <p className="card-note">
                  과거 날짜 조회는 실제 API 확인 후 제공됩니다.
                </p>
              )}
              {historyError && (
                <p className="error" role="alert">
                  {historyError}{displayedDay && " 이전 기록이 표시될 수 있습니다."}
                </p>
              )}
              {loadingDay && (
                <p className="card-note" role="status">
                  {displayedDay ? "새 기록을 확인하는 중…" : "기록을 가져오는 중…"}
                </p>
              )}
              {displayedDay ? (
                <>
                  <div className="history-total">
                    <span>{displayedDay.date} 총 공부시간</span>
                    <strong>{duration(displayedDay.totalMs)}</strong>
                  </div>
                  <div className="history-facts">
                    {displayedDay.subjectTimesAvailable && (
                      <div>
                        <span>기록된 과목</span>
                        <strong>{displayedDay.subjects.filter((subject) =>
                          subject.studyMs !== null && subject.studyMs > 0).length}개</strong>
                      </div>
                    )}
                    {displayedDay.longestSegmentMs !== null && (
                      <div>
                        <span>가장 긴 기록 구간</span>
                        <strong>{duration(displayedDay.longestSegmentMs)}</strong>
                      </div>
                    )}
                  </div>
                  <SubjectBreakdown day={displayedDay}
                    empty="이 날짜에 기록된 과목 시간이 없습니다." />
                  {!displayedDay.subjectTimesAvailable && (
                    <p className="card-note">
                      이 날짜의 과목별 시간은 확인되지 않았습니다.
                    </p>
                  )}
                </>
              ) : !loadingDay && (
                <p className="empty">해당 날짜의 기록을 확인할 수 없습니다.</p>
              )}
            </section>
          )}
          {tab === "insights" && (
            <section className="history-card insights-card">
              {snapshot?.capabilities.history && snapshot.today ? (
                <HistoryTrend key={`${snapshot.today.date}:${trendRange}`} today={snapshot.today}
                  rangeDays={trendRange} goalMinutes={goalMinutes} onRangeChange={setTrendRange}
                  previous={trends[trendRange]?.todayDate === snapshot.today.date
                    ? trends[trendRange]?.days ?? null : null}
                  onLoaded={(days) => setTrends((old) => ({
                    ...old, [trendRange]: { todayDate: snapshot.today.date, days },
                  }))}
                  loadDay={getHistoryDay}
                  onSelect={(selectedDate) => {
                    setDate(selectedDate);
                    navigateTab("history");
                  }} />
              ) : (
                <p className="card-note">
                  {snapshot ? "기록 통계 조회를 사용할 수 없습니다." : "오늘 정보를 불러오는 중입니다."}
                </p>
              )}
            </section>
          )}
          {tab === "groups" && (
            <div className="group-grid">
              <section className="group-card">
                <div className="card-head">
                  <span>가입한 그룹</span>
                  <button
                    className="text-button"
                    disabled={loadingGroup}
                    onClick={() => void loadGroups()}
                  >
                    {loadingGroup ? "확인 중…" : "새로고침"}
                  </button>
                </div>
                {groupError && (
                  <p className="error" role="alert">
                    {groupError}{groups && " 이전 목록이 표시될 수 있습니다."}
                  </p>
                )}
                {groups?.length ? (
                  <div className="group-list">
                    {groups.map((group) => {
                      const currentCount = memberSnapshots[group.id]?.members.length ?? groupMemberCounts[group.id];
                      return <button
                        key={group.id}
                        className={selectedGroup === group.id ? "selected" : ""}
                        aria-pressed={selectedGroup === group.id}
                        onClick={() => {
                          if (selectedGroup === group.id) {
                            void loadMembers(group.id);
                            return;
                          }
                          setSelectedGroup(group.id);
                        }}
                      >
                        {group.title}
                        <span>
                          {currentCount !== undefined
                            ? `현재 ${currentCount}명${group.capacity === null ? "" : ` / 정원 ${group.capacity}명`}`
                            : group.capacity === null
                              ? ""
                              : `정원 ${group.capacity}명`}
                        </span>
                      </button>;
                    })}
                  </div>
                ) : (
                  <p className="empty">
                    {groupError
                      ? "그룹 목록을 확인할 수 없습니다. 새로고침해 주세요."
                      : loadingGroup || groups === null
                      ? "그룹을 가져오는 중…"
                      : "가입한 그룹이 없습니다."}
                  </p>
                )}
              </section>
              <section className="group-card">
                <div className="card-head">
                  <span>멤버 현황</span>
                  {selectedGroup && (
                    <button
                      className="text-button"
                      disabled={loadingMembers}
                      onClick={() => void loadMembers(selectedGroup)}
                    >
                      {loadingMembers ? "확인 중…" : "새로고침"}
                    </button>
                  )}
                </div>
                {selectedGroupDetails && (
                  <div className="group-detail">
                    <strong>{selectedGroupDetails.title}</strong>
                    {selectedGroupDetails.slogan && (
                      <p>{selectedGroupDetails.slogan}</p>
                    )}
                    {(selectedGroupDetails.category || selectedGroupDetails.owner) && (
                      <div className="group-detail-meta">
                        {selectedGroupDetails.category && (
                          <span>분류 {selectedGroupDetails.category}</span>
                        )}
                        {selectedGroupDetails.owner && (
                          <span>방장 {selectedGroupDetails.owner}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {shownMembers && (
                  <p className="member-summary">
                    공부 중 {memberCounts?.studying}명
                    {" · "}조회된 멤버 {shownMembers.length}명
                    {Boolean(memberCounts?.unknown) &&
                      ` · 상태 미확인 ${memberCounts?.unknown}명`}
                    {(memberQuery.trim() || memberFilter !== "all") &&
                      ` · 표시 ${visibleMembers?.length ?? 0}명`}
                  </p>
                )}
                {shownMembers && shownMembers.length > 0 && (
                  <div className="member-tools">
                    <div className="member-status-track" role="img"
                      aria-label={`공부 중 ${memberCounts?.studying}명, 쉬는 중 ${memberCounts?.resting}명, 상태 미확인 ${memberCounts?.unknown}명`}>
                      <span className="studying" style={{ width: `${(memberCounts?.studying ?? 0) / shownMembers.length * 100}%` }} />
                      <span className="resting" style={{ width: `${(memberCounts?.resting ?? 0) / shownMembers.length * 100}%` }} />
                      <span className="unknown" style={{ width: `${(memberCounts?.unknown ?? 0) / shownMembers.length * 100}%` }} />
                    </div>
                    <div className="member-filters" role="group" aria-label="공부 상태 필터">
                      {([
                        ["all", "전체", shownMembers.length],
                        ["studying", "공부 중", memberCounts?.studying ?? 0],
                        ["resting", "쉬는 중", memberCounts?.resting ?? 0],
                        ["unknown", "미확인", memberCounts?.unknown ?? 0],
                      ] as const).map(([filter, label, count]) => (
                        <button key={filter} type="button"
                          className={memberFilter === filter ? "selected" : ""}
                          aria-pressed={memberFilter === filter}
                          onClick={() => setMemberFilter(filter)}>
                          {label} <span>{count}</span>
                        </button>
                      ))}
                    </div>
                    <div className="member-controls">
                      <div>
                        <label htmlFor="member-search">멤버 검색</label>
                        <input
                          id="member-search"
                          type="search"
                          placeholder="닉네임으로 찾기"
                          value={memberQuery}
                          onChange={(event) => setMemberQuery(event.target.value)}
                        />
                      </div>
                      <div>
                        <label htmlFor="member-sort">정렬</label>
                        <select
                          id="member-sort"
                          value={memberSort}
                          onChange={(event) =>
                            setMemberSort(event.target.value as MemberSort)
                          }
                        >
                          <option value="time">시간 많은 순</option>
                          <option value="status">공부 중 우선</option>
                          <option value="name">이름순</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
                {memberError && (
                  <p className="error" role="alert">
                    {memberError}{shownMembers && " 이전 현황이 표시될 수 있습니다."}
                  </p>
                )}
                {groupCheckedAt && (
                  <p className="checked-time">
                    마지막 확인{" "}
                    {new Date(groupCheckedAt).toLocaleTimeString("ko-KR")}
                  </p>
                )}
                {visibleMembers?.length ? (
                  <div className="member-list">
                    {visibleMembers.map((member) => (
                      <div className="member-row" key={member.id}>
                        <span
                          aria-hidden="true"
                          className={`member-indicator ${member.studying === true ? "live" : member.studying === false ? "resting" : "unknown"}`}
                        />
                        <span className="member-name">
                          {member.nickname}
                          <small className={`member-state-label ${member.studying === true ? "studying" : member.studying === false ? "resting" : "unknown"}`}>
                            {member.studying === true
                              ? "공부 중"
                              : member.studying === false
                                ? "쉬는 중"
                                : "공부 상태 미확인"}
                          </small>
                        </span>
                        <span className="member-time">
                          <strong>{member.studyMs === null ? "미확인" : duration(member.studyMs)}</strong>
                          <small>오늘 기록</small>
                          {member.studying === true && member.startedAt !== null && (
                            <>
                              <strong>{duration(Math.max(0, now + clockOffset - member.startedAt))}</strong>
                              <small>진행 중</small>
                            </>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty">
                    {selectedGroup === null
                      ? "그룹을 선택해 주세요."
                      : shownMembers?.length && (memberQuery.trim() || memberFilter !== "all")
                        ? "조건에 맞는 멤버가 없습니다."
                      : shownMembers
                        ? "표시할 멤버가 없습니다."
                        : loadingMembers
                          ? "멤버를 가져오는 중…"
                          : memberError
                            ? "멤버 현황을 확인할 수 없습니다."
                            : "그룹을 선택해 주세요."}
                  </p>
                )}
              </section>
            </div>
          )}
        </main>
      </div>
      <nav className="bottom-nav" aria-label="메뉴">
        {MOBILE_TABS.map((item) => (
          <button
            key={item.tab}
            className={mobileActiveTab === item.tab ? "active" : ""}
            aria-current={mobileActiveTab === item.tab ? "page" : undefined}
            onClick={() => navigateTab(item.tab)}
          >
            <NavIcon tab={item.tab} />
            <span className="bottom-nav-label">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
