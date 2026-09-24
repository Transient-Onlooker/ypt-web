import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Day, Group, Member, Snapshot } from "../shared/types.ts";
import "./style.css";

type Tab = "study" | "history" | "groups";
type MemberSort = "studying" | "time" | "name";
type Session = { authenticated: boolean; csrf?: string };
type ApiError = Error & { code?: string; status?: number };
let csrf = "";

async function api<T>(path: string, method = "GET", data?: object): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET"
        ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
        : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    [key: string]: unknown;
  };
  if (!response.ok) {
    const error = new Error(
      result.error || "요청을 처리하지 못했습니다.",
    ) as ApiError;
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  return result as T;
}
function duration(ms: number | null | undefined) {
  if (ms == null) return "확인 중";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await api<Session>("/login", "POST", {
        email,
        password,
      });
      csrf = response.csrf ?? "";
      setPassword("");
      await onLogin();
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
        <form onSubmit={submit}>
          <label htmlFor="email">이메일</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="password">비밀번호</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotCheckedAt, setSnapshotCheckedAt] = useState<number | null>(null);
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  const [tab, setTab] = useState<Tab>("study");
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
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [groupCheckedAt, setGroupCheckedAt] = useState<number | null>(null);
  const [loadingGroup, setLoadingGroup] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [groupError, setGroupError] = useState("");
  const [memberError, setMemberError] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberSort, setMemberSort] = useState<MemberSort>("studying");
  const inFlight = useRef(false);
  const authEpoch = useRef(0);
  const snapshotRequest = useRef(0);
  const groupRequest = useRef(0);
  const memberRequest = useRef(0);
  const memberLoadingGroup = useRef<{ id: number; requestId: number } | null>(
    null,
  );

  const loadSnapshot = useCallback(async () => {
    const requestId = ++snapshotRequest.current;
    const epoch = authEpoch.current;
    setRefreshingSnapshot(true);
    try {
      const result = await api<Snapshot>("/snapshot");
      if (requestId !== snapshotRequest.current || epoch !== authEpoch.current)
        return;
      setSnapshot(result);
      setClockOffset(result.serverNow - Date.now());
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
      if (requestId !== snapshotRequest.current || epoch !== authEpoch.current)
        return;
      if ((cause as ApiError).status === 401) {
        authEpoch.current++;
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
        setDay(null);
        setDate("");
        setSelectedSubject("");
        setError("");
        setHistoryError("");
        setGroupError("");
        setMemberError("");
        setMemberQuery("");
        setMemberSort("studying");
        setTab("study");
        setSession({ authenticated: false });
        csrf = "";
      } else
        setError(
          cause instanceof Error
            ? cause.message
            : "상태를 확인하지 못했습니다.",
        );
    } finally {
      if (requestId === snapshotRequest.current && epoch === authEpoch.current)
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
    const interval = setInterval(onVisible, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [session?.authenticated, loadSnapshot]);
  useEffect(() => {
    if (tab !== "history" || !date || !session?.authenticated) return;
    if (snapshot?.today.date === date) {
      setDay(null);
      setLoadingDay(false);
      setHistoryError("");
      return;
    }
    let active = true;
    setLoadingDay(true);
    setDay(null);
    setHistoryError("");
    api<Day>(`/history?date=${encodeURIComponent(date)}`)
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
  }, [tab, date, session?.authenticated, snapshot?.today.date, historyRefresh]);
  const loadGroups = useCallback(async () => {
    const requestId = ++groupRequest.current;
    const epoch = authEpoch.current;
    setLoadingGroup(true);
    try {
      const result = await api<{ groups: Group[] }>("/groups");
      if (requestId !== groupRequest.current || epoch !== authEpoch.current)
        return;
      setGroups(result.groups);
      setSelectedGroup((old) =>
        old && result.groups.some((g) => g.id === old)
          ? old
          : (result.groups[0]?.id ?? null),
      );
      setGroupError("");
    } catch (cause) {
      if (requestId !== groupRequest.current || epoch !== authEpoch.current)
        return;
      setGroupError(
        cause instanceof Error ? cause.message : "그룹을 가져오지 못했습니다.",
      );
    } finally {
      if (requestId === groupRequest.current && epoch === authEpoch.current)
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
    if (tab !== "groups" || selectedGroup === null || !session?.authenticated)
      return;
    memberRequest.current++;
    setMembers(null);
    setGroupCheckedAt(null);
    setMemberError("");
    setMemberQuery("");
    void loadMembers(selectedGroup);
    const refresh = () => {
      if (document.visibilityState === "visible")
        void loadMembers(selectedGroup);
    };
    document.addEventListener("visibilitychange", refresh);
    const interval = setInterval(refresh, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(interval);
    };
  }, [tab, selectedGroup, session?.authenticated, loadMembers]);
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
      await loadSnapshot();
    } catch (cause) {
      if (epoch !== authEpoch.current) return;
      await loadSnapshot();
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
    try {
      await api("/logout", "POST", {});
      authEpoch.current++;
      snapshotRequest.current++;
      groupRequest.current++;
      memberRequest.current++;
      memberLoadingGroup.current = null;
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
      setMemberSort("studying");
      setHistoryError("");
      setDay(null);
      setSelectedSubject("");
      setDate("");
      setTab("study");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "로그아웃하지 못했습니다.",
      );
    } finally {
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
        onLogin={async () => {
          authEpoch.current++;
          setSession({ authenticated: true, csrf });
          setError("");
          await loadSnapshot();
        }}
      />
    );
  const timer = snapshot?.timer;
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
    else status = "상태 확인 필요";
  }
  const displayedDay = date === snapshot?.today.date ? snapshot.today : day;
  const statusStale =
    snapshotCheckedAt !== null && now - snapshotCheckedAt > 45_000;
  const visibleMembers = members
    ?.filter((member) =>
      member.nickname
        .toLocaleLowerCase("ko-KR")
        .includes(memberQuery.trim().toLocaleLowerCase("ko-KR")),
    )
    .sort((a, b) => {
      const nameOrder = a.nickname.localeCompare(b.nickname, "ko-KR");
      if (memberSort === "name") return nameOrder;
      const timeOrder = (b.studyMs ?? -1) - (a.studyMs ?? -1);
      if (memberSort === "time") return timeOrder || nameOrder;
      return (
        Number(b.studying === true) - Number(a.studying === true) ||
        timeOrder ||
        nameOrder
      );
    });
  return (
    <div className="shell">
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
            공부
          </button>
          <button
            className={tab === "history" ? "active" : ""}
            aria-current={tab === "history" ? "page" : undefined}
            onClick={() => setTab("history")}
          >
            기록
          </button>
          <button
            className={tab === "groups" ? "active" : ""}
            aria-current={tab === "groups" ? "page" : undefined}
            onClick={() => setTab("groups")}
          >
            그룹
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
            className="top-status"
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
        <main>
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
                {timer?.state === "idle" && !appOnly && (
                  <div className="form-area">
                    <label htmlFor="subject">과목</label>
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
                        종료
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
                        종료
                      </button>
                    </>
                  )}
                  {timer &&
                    ["starting", "stopping", "uncertain"].includes(
                      timer.state,
                    ) && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void change("resolve")}
                      >
                        앱에서 정지 확인 후 복구
                      </button>
                    )}
                </div>
                {((timer?.state === "idle" && !appOnly) ||
                  timer?.state === "paused") && (
                  <p className="card-note">
                    시작·재개 전에 서버가 앱 타이머 상태를 다시 확인합니다.
                  </p>
                )}
                {timer &&
                  ["starting", "stopping", "uncertain"].includes(
                    timer.state,
                  ) && (
                    <p className="caution">
                      요청 결과가 불확실합니다. 열품타 앱에서 타이머를 정지한 뒤
                      복구하세요. 같은 요청은 자동 재시도하지 않습니다.
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
                <p className="card-note">
                  화면을 닫아도 타이머는 계속됩니다. 앱에서 시작한 타이머도
                  여기서 일시정지하거나 종료할 수 있습니다.
                </p>
                {snapshotCheckedAt && (
                  <p className="checked-time">
                    마지막 상태 확인 {new Date(snapshotCheckedAt).toLocaleTimeString("ko-KR")}
                  </p>
                )}
              </section>
              <section className="summary-card">
                <div className="card-head">오늘의 공부</div>
                <div className="summary-date">
                  {snapshot?.today.date ?? "—"}
                </div>
                <div className="summary-time">
                  {duration(snapshot?.today.totalMs)}
                </div>
                <p className="summary-label">기록된 총 공부시간</p>
                {running && (
                  <div className="live-session">
                    <span>
                      진행 중인 시간 · {timer?.subject || snapshot?.remoteSubject || "과목 미확인"}
                    </span>
                    <strong>{duration(liveMs)}</strong>
                    <small>완료된 기록과 별도로 표시합니다.</small>
                  </div>
                )}
                <div className="subject-list">
                  {snapshot?.today.subjects.map((subject) => (
                    <div className="subject-row" key={subject.title}>
                      <span>{subject.title}</span>
                      <strong>{duration(subject.studyMs)}</strong>
                    </div>
                  ))}
                  {!snapshot?.today.subjects.length && (
                    <p className="empty">오늘 기록된 과목 시간이 없습니다.</p>
                  )}
                </div>
              </section>
            </div>
          )}
          {tab === "history" && (
            <section className="history-card">
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
                <button
                  className="text-button"
                  disabled={loadingDay}
                  onClick={() => {
                    if (date === snapshot?.today.date) void loadSnapshot();
                    else setHistoryRefresh((old) => old + 1);
                  }}
                >
                  새로고침
                </button>
              </div>
              {!snapshot?.capabilities.history && (
                <p className="card-note">
                  과거 날짜 조회는 실제 API 확인 후 제공됩니다.
                </p>
              )}
              {historyError && (
                <p className="error" role="alert">{historyError}</p>
              )}
              {loadingDay ? (
                <p>기록을 가져오는 중…</p>
              ) : displayedDay ? (
                <>
                  <div className="history-total">
                    <span>{displayedDay.date} 총 공부시간</span>
                    <strong>{duration(displayedDay.totalMs)}</strong>
                  </div>
                  <div className="subject-list">
                    {displayedDay.subjects.map((subject) => (
                      <div className="subject-row" key={subject.title}>
                        <span>{subject.title}</span>
                        <strong>{duration(subject.studyMs)}</strong>
                      </div>
                    ))}
                    {!displayedDay.subjects.length && (
                      <p className="empty">이 날짜에 기록된 과목 시간이 없습니다.</p>
                    )}
                  </div>
                  {!displayedDay.subjectTimesAvailable && (
                    <p className="card-note">
                      이 날짜의 과목별 시간은 확인되지 않았습니다.
                    </p>
                  )}
                </>
              ) : (
                <p className="empty">해당 날짜의 기록을 확인할 수 없습니다.</p>
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
                          memberRequest.current++;
                          setSelectedGroup(group.id);
                          setMembers(null);
                          setGroupCheckedAt(null);
                        }}
                      >
                        {group.title}
                        <span>
                          {group.memberCount == null
                            ? ""
                            : `${group.memberCount}명`}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="empty">
                    {loadingGroup
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
                {members && (
                  <p className="member-summary">
                    공부 중 {members.filter((member) => member.studying === true).length}명
                    {" · "}전체 {members.length}명
                    {memberQuery.trim() &&
                      ` · 검색 결과 ${visibleMembers?.length ?? 0}명`}
                  </p>
                )}
                {members && members.length > 0 && (
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
                        <option value="studying">공부 중 우선</option>
                        <option value="time">시간 많은 순</option>
                        <option value="name">이름순</option>
                      </select>
                    </div>
                  </div>
                )}
                {memberError && (
                  <p className="error" role="alert">
                    {memberError}{members && " 이전 현황이 표시될 수 있습니다."}
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
                          className={`member-indicator ${member.studying ? "live" : ""}`}
                        />
                        <span className="member-name">
                          {member.nickname}
                          <small>
                            {member.studying === null
                              ? "상태 미확인"
                              : member.studying
                                ? "공부 중"
                                : "쉬는 중"}
                          </small>
                        </span>
                        <strong>{duration(member.studyMs)}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty">
                    {selectedGroup === null
                      ? "그룹을 선택해 주세요."
                      : members?.length && memberQuery.trim()
                        ? "검색 결과가 없습니다."
                      : members
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
          <span aria-hidden="true">◉</span>공부
        </button>
        <button
          className={tab === "history" ? "active" : ""}
          aria-current={tab === "history" ? "page" : undefined}
          onClick={() => setTab("history")}
        >
          <span aria-hidden="true">▦</span>기록
        </button>
        <button
          className={tab === "groups" ? "active" : ""}
          aria-current={tab === "groups" ? "page" : undefined}
          onClick={() => setTab("groups")}
        >
          <span aria-hidden="true">◎</span>그룹
        </button>
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
