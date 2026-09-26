import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Day, Group, Member, Snapshot } from "../shared/types.ts";
import { PENDING_RECOVERY_MS } from "../shared/constants.ts";
import { duration, formatDaySummary, formatDayCsv, formatTrendCsv, longestVerifiedStreak } from "../shared/format.ts";
import type { TrendDay } from "../shared/format.ts";
import { RequestGate } from "../shared/request-gate.ts";
import "./style.css";

type Tab = "study" | "history" | "groups";
function NavIcon({ tab }: { tab: Tab }) {
  const paths = {
    study: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.7 1.8" /></>,
    history: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h6" /></>,
    groups: <><circle cx="9" cy="9" r="2.5" /><path d="M3.5 19v-1.2a5.5 5.5 0 0 1 11 0V19zM16 7a2.5 2.5 0 0 1 0 5M17 14a4 4 0 0 1 3.5 4V19h-3" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[tab]}</svg>;
}
type MemberSort = "time" | "name" | "status";
type MemberFilter = "all" | "studying" | "resting" | "unknown";
type Session = { authenticated: boolean; csrf?: string };
type ApiError = Error & { code?: string; status?: number };
const SYNC_SECONDS = [10, 15, 30, 60, 120] as const;
const GOAL_MINUTES = [0, 30, 60, 90, 120, 180, 240, 360, 480, 600, 720] as const;
const HISTORY_CACHE_MS = 5 * 60_000;
const SYNC_STORAGE_KEY = "ypt-web-sync-seconds";
const GOAL_STORAGE_KEY = "ypt-web-daily-goal-minutes";
const REMEMBERED_EMAIL_KEY = "ypt-web-remembered-email";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const CROSS_ORIGIN_API = API_BASE_URL !== "" &&
  new URL(API_BASE_URL).origin !== window.location.origin;
const SESSION_STORAGE_KEY = "ypt-web-session-token";
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
    return GOAL_MINUTES.find((value) => value === saved) ?? 0;
  } catch {
    return 0;
  }
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

async function api<T>(path: string, method = "GET", data?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api${path}`, {
      method,
      credentials: CROSS_ORIGIN_API ? "include" : "same-origin",
      headers: {
        ...(CROSS_ORIGIN_API && sessionToken && path !== "/login"
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
    if (CROSS_ORIGIN_API && response.status === 401 && path !== "/login")
      rememberSessionToken("");
    const error = new Error(
      result.error || "요청을 처리하지 못했습니다.",
    ) as ApiError;
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  if (CROSS_ORIGIN_API && path === "/login") {
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
function focusMilestone(ms: number) {
  if (ms >= 90 * 60_000) return "🎉 현재 타이머 90분 돌파";
  if (ms >= 50 * 60_000) return "✦ 현재 타이머 50분 돌파";
  if (ms >= 25 * 60_000) return "✦ 현재 타이머 25분 돌파";
  return null;
}
function DailyGoal({ minutes, onChange, recordedMs, liveMs }: {
  minutes: number;
  onChange: (minutes: number) => void;
  recordedMs: number;
  liveMs: number;
}) {
  const goalMs = minutes * 60_000;
  const progress = goalMs ? Math.min(100, Math.floor(recordedMs / goalMs * 100)) : 0;
  const previewProgress = goalMs ? Math.min(100, Math.floor((recordedMs + liveMs) / goalMs * 100)) : 0;
  const milestone = progress >= 100 ? "🎉 오늘의 목표 달성!"
    : progress >= 75 ? "✦ 거의 다 왔어요"
    : progress >= 50 ? "✦ 절반을 넘었어요"
    : progress >= 25 ? "✦ 좋은 출발이에요"
    : "첫 25%를 향해 시작해 볼까요?";
  return (
    <div className="daily-goal">
      <div className="daily-goal-head">
        <label htmlFor="daily-goal-minutes">하루 목표</label>
        <select id="daily-goal-minutes" value={minutes}
          onChange={(event) => onChange(Number(event.target.value))}>
          {GOAL_MINUTES.map((value) => (
            <option key={value} value={value}>
              {value ? goalLabel(value) : minutes ? "목표 지우기" : "목표 정하기"}
            </option>
          ))}
        </select>
      </div>
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
  const subjects = [...day.subjects].sort((a, b) =>
    (b.studyMs ?? -1) - (a.studyMs ?? -1) ||
    a.title.localeCompare(b.title, "ko-KR"),
  );
  const maxMs = Math.max(0, ...subjects.map((subject) => subject.studyMs ?? 0));
  return (
    <div className="subject-list">
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
            <strong>{duration(subject.studyMs)}</strong>
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
function YesterdayCompare({ today, cached, loadDay, onOpen }: {
  today: Day;
  cached: Day | null;
  loadDay: (date: string, force?: boolean) => Promise<Day>;
  onOpen: (date: string) => void;
}) {
  const yesterdayDate = shiftDate(today.date, -1);
  const [yesterday, setYesterday] = useState<Day | null>(cached);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  useEffect(() => () => { requestId.current++; }, []);

  async function load() {
    if (loading) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const result = await loadDay(yesterdayDate, yesterday !== null);
      if (currentRequest === requestId.current) setYesterday(result);
    } catch (cause) {
      if (currentRequest === requestId.current)
        setError(cause instanceof Error ? cause.message : "어제 기록을 확인하지 못했습니다.");
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }

  const difference = yesterday ? today.totalMs - yesterday.totalMs : 0;
  return (
    <div className="yesterday-compare">
      <div className="card-head">
        <span>어제와 비교</span>
        <button className="text-button" disabled={loading} onClick={() => void load()}>
          {loading ? "확인 중…" : yesterday ? "다시 확인" : "어제 기록 보기"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}{yesterday && " 이전 비교가 표시될 수 있습니다."}
        </p>
      )}
      {yesterday ? (
        <>
          <div className="comparison-times">
            <span>어제 · {yesterdayDate.slice(5).replace("-", ".")}
              <strong>{duration(yesterday.totalMs)}</strong></span>
            <span>오늘 · {today.date.slice(5).replace("-", ".")}
              <strong>{duration(today.totalMs)}</strong></span>
          </div>
          <p className="comparison-message">
            {difference > 0
              ? `오늘 완료 기록이 어제보다 ${duration(difference)} 많아요.`
              : difference < 0
                ? `어제 완료 기록까지 ${duration(-difference)} 남았어요.`
                : "어제와 오늘의 완료 기록이 같아요."}
          </p>
          <button className="text-button" onClick={() => onOpen(yesterdayDate)}>
            어제 상세 기록 보기 →
          </button>
        </>
      ) : !loading && !error ? (
        <p className="card-note">누르면 어제의 완료 기록을 조회해 오늘과 비교합니다.</p>
      ) : null}
    </div>
  );
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
function HistoryTrend({ today, previous, onLoaded, onSelect, loadDay }: {
  today: Day;
  previous: TrendDay[] | null;
  onLoaded: (days: TrendDay[]) => void;
  onSelect: (date: string) => void;
  loadDay: (date: string, force?: boolean) => Promise<Day>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const loadingRef = useRef(false);
  useEffect(() => () => { requestId.current++; }, []);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const rows: TrendDay[] = [];
      for (let offset = 1; offset <= 6; offset += 2) {
        const dates = [offset, offset + 1].map((days) => shiftDate(today.date, -days));
        const results = await Promise.allSettled(dates.map((date) => loadDay(date, previous !== null)));
        if (currentRequest !== requestId.current) return;
        results.forEach((result, index) => {
          rows.push({
            date: dates[index],
            totalMs: result.status === "fulfilled" && result.value.date === dates[index]
              ? result.value.totalMs : null,
          });
        });
      }
      if (currentRequest !== requestId.current) return;
      onLoaded(rows);
      if (rows.some((row) => row.totalMs === null))
        setError("일부 날짜를 확인하지 못했습니다. 다시 불러오면 전체 기간을 확인합니다.");
    } catch {
      if (currentRequest === requestId.current)
        setError("7일 기록을 확인하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      loadingRef.current = false;
      if (currentRequest === requestId.current) setLoading(false);
    }
  }

  const days = previous && [...previous, { date: today.date, totalMs: today.totalMs }]
    .sort((a, b) => a.date.localeCompare(b.date));
  const known = days?.filter((row) => row.totalMs !== null) ?? [];
  const maxMs = Math.max(1, ...known.map((row) => row.totalMs ?? 0));
  const knownTotal = known.reduce((sum, row) => sum + (row.totalMs ?? 0), 0);
  const studyDays = known.filter((row) => (row.totalMs ?? 0) > 0).length;
  const bestDay = known.reduce<TrendDay | null>((best, row) =>
    !best || (row.totalMs ?? 0) > (best.totalMs ?? 0) ? row : best, null);
  const streak = days ? longestVerifiedStreak(days) : 0;
  return (
    <div className="history-trend">
      <div className="card-head">
        <span>최근 7일</span>
        <button className="text-button" disabled={loading} onClick={() => void load()}>
          {loading ? "확인 중…" : previous ? "다시 불러오기" : "7일 기록 불러오기"}
        </button>
      </div>
      <p className="card-note">누르면 오늘을 포함한 7일의 완료 기록을 확인합니다. 자동으로 추가 요청하지 않습니다.</p>
      {days && (
        <>
          <p className="week-total">확인된 {known.length}일 합계 <strong>{duration(knownTotal)}</strong></p>
          <div className="week-insights">
            <span>공부한 날 <strong>{studyDays}/{known.length}일</strong></span>
            <span>확인된 날 평균 <strong>{duration(knownTotal / Math.max(1, known.length))}</strong></span>
            <span>확인된 최장 연속 <strong>{streak}일</strong></span>
            {studyDays > 0 && bestDay && (
              <span>가장 많이 한 날 <strong>{bestDay.date.slice(5).replace("-", ".")} · {duration(bestDay.totalMs)}</strong></span>
            )}
          </div>
          <CsvButton filename={`ypt-week-${today.date}.csv`}
            csv={formatTrendCsv(days)} label="7일 기록 CSV 저장" />
          <div className="week-list">
            {days.map((row) => (
              <button className="week-row" key={row.date} onClick={() => onSelect(row.date)}
                aria-label={`${row.date} 기록 보기, ${row.totalMs === null ? "시간 확인 불가" : duration(row.totalMs)}`}>
                <span>{shortDayLabel(row.date)}</span>
                <span className="week-track" aria-hidden="true">
                  {row.totalMs !== null && <span style={{ width: `${row.totalMs / maxMs * 100}%` }} />}
                </span>
                <strong>{row.totalMs === null ? "확인 불가" : duration(row.totalMs)}</strong>
              </button>
            ))}
          </div>
        </>
      )}
      {error && <p className="card-note" role="status">{error}</p>}
    </div>
  );
}
function Login({
  onLogin,
  notice,
}: {
  onLogin: (rememberWarning: string) => Promise<void>;
  notice: string;
}) {
  const [initialEmail] = useState(savedEmail);
  const [keepEmail, setKeepEmail] = useState(Boolean(initialEmail));
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      await onLogin(rememberWarning);
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
        <div className="brand-mark" aria-hidden="true">
          Y
        </div>
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
  const [sessionLoadError, setSessionLoadError] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [loginNotice, setLoginNotice] = useState("");
  const [rememberWarning, setRememberWarning] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotCheckedAt, setSnapshotCheckedAt] = useState<number | null>(null);
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  const [tab, setTab] = useState<Tab>("study");
  const [syncSeconds, setSyncSeconds] = useState(savedSyncSeconds);
  const [goalMinutes, setGoalMinutes] = useState(savedGoalMinutes);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState("");
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  const [date, setDate] = useState("");
  const [day, setDay] = useState<Day | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [trend, setTrend] = useState<{ todayDate: string; days: TrendDay[] } | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [groupCheckedAt, setGroupCheckedAt] = useState<number | null>(null);
  const [loadingGroup, setLoadingGroup] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [groupError, setGroupError] = useState("");
  const [memberError, setMemberError] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberSort, setMemberSort] = useState<MemberSort>("time");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");
  const inFlight = useRef(false);
  const authEpoch = useRef(0);
  const snapshotGate = useRef(new RequestGate());
  const groupGate = useRef(new RequestGate());
  const memberRequest = useRef(0);
  const memberLoadingGroup = useRef<{ id: number; requestId: number } | null>(
    null,
  );
  const lastMemberGroup = useRef<number | null>(null);
  const previousTimerKey = useRef<string | null>(null);
  const previousTab = useRef<Tab>("study");
  const historyCache = useRef(new Map<string, { day: Day; checkedAt: number }>());
  const historyRequests = useRef(new Map<string, Promise<Day>>());
  const forceHistoryDate = useRef<string | null>(null);

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
    } catch (cause) {
      if (!snapshotGate.current.isCurrent(requestId) || epoch !== authEpoch.current)
        return;
      if ((cause as ApiError).status === 401) {
        authEpoch.current++;
        snapshotGate.current.invalidate();
        groupGate.current.invalidate();
        historyCache.current.clear();
        historyRequests.current.clear();
        forceHistoryDate.current = null;
        setTrend(null);
        setRefreshingSnapshot(false);
        setSnapshot(null);
        setSnapshotCheckedAt(null);
        setGroups(null);
        setMembers(null);
        setSelectedGroup(null);
        setGroupCheckedAt(null);
        setLoadingGroup(false);
        setLoadingMembers(false);
        setLoadingDay(false);
        memberLoadingGroup.current = null;
        lastMemberGroup.current = null;
        setDay(null);
        setDate("");
        setSelectedSubject("");
        setError("");
        setHistoryError("");
        setGroupError("");
        setMemberError("");
        setMemberQuery("");
        setMemberSort("time");
        setMemberFilter("all");
        setTab("study");
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
  }, []);
  useEffect(() => {
    let active = true;
    api<Session>("/session")
      .then((result) => {
        if (!active) return;
        csrf = result.csrf ?? "";
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
    const startedAt =
      snapshot?.timer.state === "running"
        ? snapshot.timer.startedAt
        : snapshot?.remoteStatus === "running"
          ? snapshot.remoteStartedAt
          : null;
    document.title = startedAt
      ? `${duration(now + clockOffset - startedAt)} · YPT Web`
      : "YPT Web · 공부";
  }, [session?.authenticated, snapshot, now, clockOffset]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadSnapshot();
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
  const loadGroups = useCallback(async () => {
    const requestId = groupGate.current.start();
    if (requestId === null) return;
    const epoch = authEpoch.current;
    setLoadingGroup(true);
    try {
      const result = await api<{ groups: Group[] }>("/groups");
      if (!groupGate.current.isCurrent(requestId) || epoch !== authEpoch.current)
        return;
      setGroups(result.groups);
      setSelectedGroup((old) =>
        old && result.groups.some((g) => g.id === old)
          ? old
          : (result.groups[0]?.id ?? null),
      );
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
    if (memberLoadingGroup.current?.id === id) return;
    const requestId = ++memberRequest.current;
    memberLoadingGroup.current = { id, requestId };
    const epoch = authEpoch.current;
    setLoadingMembers(true);
    try {
      const result = await api<{ members: Member[]; checkedAt: number }>(
        `/groups/${id}/members`,
      );
      if (requestId !== memberRequest.current || epoch !== authEpoch.current)
        return;
      setMembers(result.members);
      setGroupCheckedAt(result.checkedAt);
      setMemberError("");
    } catch (cause) {
      if (requestId !== memberRequest.current || epoch !== authEpoch.current)
        return;
      setMemberError(
        cause instanceof Error
          ? cause.message
          : "멤버 상태를 가져오지 못했습니다.",
      );
    } finally {
      if (memberLoadingGroup.current?.requestId === requestId)
        memberLoadingGroup.current = null;
      if (requestId === memberRequest.current && epoch === authEpoch.current)
        setLoadingMembers(false);
    }
  }, []);
  useEffect(() => {
    if (tab === "groups" && session?.authenticated && groups === null)
      void loadGroups();
  }, [tab, session?.authenticated, groups, loadGroups]);
  useEffect(() => {
    if (tab !== "groups" || !session?.authenticated) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadGroups();
    };
    document.addEventListener("visibilitychange", refresh);
    const interval = setInterval(refresh, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(interval);
    };
  }, [tab, session?.authenticated, loadGroups]);
  useEffect(() => {
    if (tab !== "groups" || !session?.authenticated) return;
    if (lastMemberGroup.current !== selectedGroup) {
      lastMemberGroup.current = selectedGroup;
      memberRequest.current++;
      memberLoadingGroup.current = null;
      setMembers(null);
      setGroupCheckedAt(null);
      setMemberError("");
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
  ) {
    if (!snapshot || inFlight.current) return;
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
      if (epoch !== authEpoch.current) return;
      await loadSnapshot(true);
    } catch (cause) {
      if (epoch !== authEpoch.current) return;
      await loadSnapshot(true);
      setError(
        cause instanceof Error
          ? cause.message
          : "타이머 결과를 확인하지 못했습니다.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
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
        authEpoch.current++;
        historyCache.current.clear();
        historyRequests.current.clear();
        forceHistoryDate.current = null;
        setTrend(null);
        snapshotGate.current.invalidate();
        groupGate.current.invalidate();
        memberRequest.current++;
        memberLoadingGroup.current = null;
        lastMemberGroup.current = null;
        csrf = "";
        setSession({ authenticated: false });
        setSnapshot(null);
        setSnapshotCheckedAt(null);
        setRefreshingSnapshot(false);
        setGroups(null);
        setMembers(null);
        setLoadingGroup(false);
        setLoadingMembers(false);
        setLoadingDay(false);
        setSelectedGroup(null);
        setGroupCheckedAt(null);
        setError("");
        setGroupError("");
        setMemberError("");
        setMemberQuery("");
        setMemberSort("time");
        setMemberFilter("all");
        setHistoryError("");
        setDay(null);
        setSelectedSubject("");
        setDate("");
        setTab("study");
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
        onLogin={async (warning) => {
          authEpoch.current++;
          snapshotGate.current.invalidate();
          groupGate.current.invalidate();
          historyCache.current.clear();
          historyRequests.current.clear();
          forceHistoryDate.current = null;
          setTrend(null);
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
  const liveMs = running
    ? Math.max(
        0,
        now +
          clockOffset -
          (timer?.startedAt ?? snapshot?.remoteStartedAt ?? now),
      )
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
  const yesterdayDate = snapshot?.today ? shiftDate(snapshot.today.date, -1) : null;
  const yesterdayCache = yesterdayDate ? historyCache.current.get(yesterdayDate) : null;
  const cachedYesterday = yesterdayCache && Date.now() - yesterdayCache.checkedAt < HISTORY_CACHE_MS
    ? yesterdayCache.day : null;
  const selectedGroupDetails = groups?.find((group) => group.id === selectedGroup);
  const shownMembers = selectedGroup !== null && lastMemberGroup.current === selectedGroup
    ? members : null;
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
    snapshotCheckedAt !== null && now - snapshotCheckedAt > 45_000;
  const focusMessage = running && !statusStale && !remoteUnverified
    ? focusMilestone(liveMs) : null;
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
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">본문으로 이동</a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">Y</div>
          <span>YPT WEB</span>
        </div>
        <nav aria-label="메뉴">
          <button
            className={tab === "study" ? "active" : ""}
            aria-current={tab === "study" ? "page" : undefined}
            onClick={() => setTab("study")}
          >
            <NavIcon tab="study" />공부
          </button>
          <button
            className={tab === "history" ? "active" : ""}
            aria-current={tab === "history" ? "page" : undefined}
            onClick={() => setTab("history")}
          >
            <NavIcon tab="history" />기록
          </button>
          <button
            className={tab === "groups" ? "active" : ""}
            aria-current={tab === "groups" ? "page" : undefined}
            onClick={() => setTab("groups")}
          >
            <NavIcon tab="groups" />그룹
          </button>
        </nav>
        <button
          className="sidebar-logout"
          disabled={loggingOut || busy}
          onClick={() => void logout()}
        >
          로그아웃
        </button>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="mobile-brand">YPT WEB</div>
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
            {running && <strong>{duration(liveMs)}</strong>}
          </div>
          <button
            className="desktop-logout"
            disabled={loggingOut || busy}
            onClick={() => void logout()}
          >
            로그아웃
          </button>
        </header>
        <main id="main-content" tabIndex={-1}>
          {rememberWarning && (
            <div className="remember-warning" role="status">
              {rememberWarning}
              <button onClick={() => setRememberWarning("")} aria-label="안내 닫기">×</button>
            </div>
          )}
          {tab !== "study" && running && (
            <div className="active-strip">
              <div>
                <span className="active-strip-label">
                  {status}
                  {timer?.subject || snapshot?.remoteSubject
                    ? ` · ${timer?.subject || snapshot?.remoteSubject}`
                    : ""}
                </span>
                <strong>{duration(liveMs)}</strong>
              </div>
              <button className="secondary" onClick={() => setTab("study")}
              >
                타이머 보기
              </button>
            </div>
          )}
          <div className="page-title">
            <div>
              <p className="eyebrow">
                {tab === "study"
                  ? "FOCUS"
                  : tab === "history"
                    ? "HISTORY"
                    : "TOGETHER"}
              </p>
              <h1>
                {tab === "study" ? "공부" : tab === "history" ? "기록" : "그룹"}
              </h1>
              <p className="page-subtitle">
                {tab === "study" ? "오늘의 집중을 이어가세요." : tab === "history" ? "쌓인 시간을 한눈에 확인하세요." : "함께 공부하는 사람들을 만나보세요."}
              </p>
            </div>
            <label className="sync-control" htmlFor="sync-seconds" title="타이머 상태와 선택한 그룹 멤버의 서버 조회 주기입니다. 화면의 시간 표시는 매초 갱신됩니다.">
              자동 동기화
              <select
                id="sync-seconds"
                value={syncSeconds}
                onChange={(event) => {
                  const seconds = Number(event.target.value);
                  if (!SYNC_SECONDS.some((value) => value === seconds)) return;
                  setSyncSeconds(seconds);
                  try {
                    localStorage.setItem(SYNC_STORAGE_KEY, String(seconds));
                  } catch {
                    // Storage can be unavailable in private browsing.
                  }
                }}
              >
                {SYNC_SECONDS.map((seconds) => (
                  <option key={seconds} value={seconds}>{seconds}초</option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="알림 닫기">
                ×
              </button>
            </div>
          )}
          {tab === "study" && (
            <div className="study-grid">
              <section className="timer-card">
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
                <div className={`timer-face ${running ? "is-running" : ""}`}>
                  <div className="timer-face-inner">
                    <span className="timer-face-kicker">나의 집중 시간</span>
                    <div className="timer-display" aria-live="off">
                      {running
                        ? duration(liveMs)
                        : timer?.state === "paused"
                          ? "--:--:--"
                          : "00:00:00"}
                    </div>
                    <div className="timer-caption">
                      {status}
                      {timer?.subject ? ` · ${timer.subject}` : ""}
                    </div>
                    {focusMessage && (
                      <p className="focus-milestone">{focusMessage}</p>
                    )}
                  </div>
                </div>
                {timer?.state === "idle" && !appOnly && (
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
                  {timer?.state === "idle" && !appOnly && (
                    <button
                      className="primary"
                      disabled={busy || !selectedSubject || remoteUnverified}
                      onClick={() => void change("start")}
                    >
                      공부 시작
                    </button>
                  )}
                  {timer?.state === "running" && (
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
                  {timer?.state === "paused" && (
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
                <details className="timer-help">
                  <summary>타이머 이용 안내</summary>
                  <p>일시정지는 과목을 기억해 재개할 수 있습니다. 공부 끝내기는 구간을 마무리하고 다음 시작 때 과목을 다시 고릅니다.</p>
                  <p>시작·재개 전에 서버가 앱 타이머 상태를 다시 확인합니다. 화면을 닫아도 타이머는 계속되며, 앱에서 시작한 공부도 여기서 제어할 수 있습니다.</p>
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
              <section className="summary-card">
                <div className="card-head">
                  <span>오늘의 공부</span>
                  {snapshot?.today && <CopyDayButton
                    key={`${snapshot.today.date}:${snapshot.today.totalMs}`}
                    day={snapshot.today} />}
                </div>
                <div className="summary-date">
                  {snapshot?.today.date ?? "—"}
                </div>
                <div className="summary-time">
                  {duration(snapshot?.today.totalMs)}
                </div>
                <p className="summary-label">기록된 총 공부시간</p>
                {snapshot?.today && (
                  <DailyGoal minutes={goalMinutes} recordedMs={snapshot.today.totalMs}
                    liveMs={running && !statusStale && !remoteUnverified ? liveMs : 0}
                    onChange={(minutes) => {
                      if (!GOAL_MINUTES.some((value) => value === minutes)) return;
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
                    <span>
                      진행 중인 시간 · {timer?.subject || snapshot?.remoteSubject || "과목 미확인"}
                    </span>
                    <strong>{duration(liveMs)}</strong>
                    <small>완료된 기록과 별도로 표시합니다.</small>
                  </div>
                )}
                {snapshot?.capabilities.history && snapshot.today && (
                  <YesterdayCompare key={snapshot.today.date} today={snapshot.today}
                    cached={cachedYesterday}
                    loadDay={getHistoryDay}
                    onOpen={(selectedDate) => {
                      setDate(selectedDate);
                      setTab("history");
                    }} />
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
            </div>
          )}
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
              {snapshot?.capabilities.history && snapshot.today && (
                <HistoryTrend key={snapshot.today.date} today={snapshot.today}
                  previous={trend?.todayDate === snapshot.today.date ? trend.days : null}
                  onLoaded={(days) => setTrend({ todayDate: snapshot.today.date, days })}
                  loadDay={getHistoryDay}
                  onSelect={(selectedDate) => {
                    setDate(selectedDate);
                    document.getElementById("history-top")?.scrollIntoView();
                  }} />
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
                    {groups.map((group) => (
                      <button
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
                          {selectedGroup === group.id && shownMembers
                            ? `현재 ${shownMembers.length}명${group.capacity === null ? "" : ` / 정원 ${group.capacity}명`}`
                            : group.capacity === null
                              ? ""
                              : `정원 ${group.capacity}명`}
                        </span>
                      </button>
                    ))}
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
                    {" · "}화면이 보일 때 {syncSeconds}초마다 자동 확인
                  </p>
                )}
                {visibleMembers?.length ? (
                  <div className="member-list">
                    {visibleMembers.map((member) => (
                      <div className="member-row" key={member.id}>
                        <span
                          aria-hidden="true"
                          className={`member-indicator ${member.studying ? "live" : ""}`}
                        />
                        <span className="member-name">
                          {member.nickname}
                          <small>
                            {member.studying === true
                              ? "공부 중"
                              : member.studying === false
                                ? "쉬는 중"
                                : "공부 상태 미확인"}
                          </small>
                        </span>
                        <span className="member-time">
                          <strong>{duration(member.studyMs)}</strong>
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
        <button
          className={tab === "study" ? "active" : ""}
          aria-current={tab === "study" ? "page" : undefined}
          onClick={() => setTab("study")}
        >
          <NavIcon tab="study" />공부
        </button>
        <button
          className={tab === "history" ? "active" : ""}
          aria-current={tab === "history" ? "page" : undefined}
          onClick={() => setTab("history")}
        >
          <NavIcon tab="history" />기록
        </button>
        <button
          className={tab === "groups" ? "active" : ""}
          aria-current={tab === "groups" ? "page" : undefined}
          onClick={() => setTab("groups")}
        >
          <NavIcon tab="groups" />그룹
        </button>
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
