import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Day, Group, Member, Snapshot } from "../shared/types.ts";
import "./style.css";

type Tab = "study" | "history" | "groups";
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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Tab>("study");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState("");
  const [appIdle, setAppIdle] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  const [date, setDate] = useState("");
  const [day, setDay] = useState<Day | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [groupCheckedAt, setGroupCheckedAt] = useState<number | null>(null);
  const [loadingGroup, setLoadingGroup] = useState(false);
  const inFlight = useRef(false);

  const loadSnapshot = useCallback(async () => {
    try {
      const result = await api<Snapshot>("/snapshot");
      setSnapshot(result);
      setClockOffset(result.serverNow - Date.now());
      setDate((old) => old || result.today.date);
      setSelectedSubject((old) => old || result.subjects[0]?.title || "");
      setNow(Date.now());
      setError("");
    } catch (cause) {
      if ((cause as ApiError).status === 401) {
        setSession({ authenticated: false });
        csrf = "";
      } else
        setError(
          cause instanceof Error
            ? cause.message
            : "상태를 확인하지 못했습니다.",
        );
    }
  }, []);
  useEffect(() => {
    api<Session>("/session")
      .then((result) => {
        csrf = result.csrf ?? "";
        setSession(result);
        if (result.authenticated) void loadSnapshot();
      })
      .catch(() => {
        setSession({ authenticated: false });
        setError("서버에 연결하지 못했습니다.");
      });
  }, [loadSnapshot]);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
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
      setDay(snapshot.today);
      setLoadingDay(false);
      return;
    }
    let active = true;
    setLoadingDay(true);
    setDay(null);
    api<Day>(`/history?date=${encodeURIComponent(date)}`)
      .then((result) => {
        if (active) {
          setDay(result);
          setError("");
        }
      })
      .catch((cause) => {
        if (active)
          setError(
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
  }, [tab, date, session?.authenticated, snapshot?.today]);
  const loadGroups = useCallback(async () => {
    setLoadingGroup(true);
    try {
      const result = await api<{ groups: Group[] }>("/groups");
      setGroups(result.groups);
      setSelectedGroup((old) =>
        old && result.groups.some((g) => g.id === old)
          ? old
          : (result.groups[0]?.id ?? null),
      );
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "그룹을 가져오지 못했습니다.",
      );
    } finally {
      setLoadingGroup(false);
    }
  }, []);
  const loadMembers = useCallback(async (id: number) => {
    try {
      const result = await api<{ members: Member[]; checkedAt: number }>(
        `/groups/${id}/members`,
      );
      setMembers(result.members);
      setGroupCheckedAt(result.checkedAt);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "멤버 상태를 가져오지 못했습니다.",
      );
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
    void loadMembers(selectedGroup);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible")
        void loadMembers(selectedGroup);
    }, 30_000);
    return () => clearInterval(interval);
  }, [tab, selectedGroup, session?.authenticated, loadMembers]);
  async function change(
    action: "start" | "pause" | "resume" | "stop" | "resolve",
  ) {
    if (!snapshot || inFlight.current) return;
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
              confirmedAppIdle: appIdle,
            },
      );
      setAppIdle(false);
      await loadSnapshot();
    } catch (cause) {
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
    try {
      await api("/logout", "POST", {});
      csrf = "";
      setSession({ authenticated: false });
      setSnapshot(null);
      setGroups(null);
      setMembers(null);
      setSelectedSubject("");
      setDate("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "로그아웃하지 못했습니다.",
      );
    }
  }
  if (session === null)
    return <div className="loading-screen">연결 확인 중…</div>;
  if (!session.authenticated)
    return (
      <Login
        onLogin={async () => {
          setSession({ authenticated: true, csrf });
          await loadSnapshot();
        }}
      />
    );
  const timer = snapshot?.timer;
  const remoteActive = snapshot?.remoteStatus === "running";
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
  const status = !timer
    ? "상태 확인 중"
    : appOnly
      ? "앱에서 공부 중"
      : timer.state === "running"
        ? "공부 중"
        : timer.state === "paused"
          ? "일시정지"
          : timer.state === "idle"
            ? "대기 중"
            : "상태 확인 필요";
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
            onClick={() => setTab("study")}
          >
            공부
          </button>
          <button
            className={tab === "history" ? "active" : ""}
            onClick={() => setTab("history")}
          >
            기록
          </button>
          <button
            className={tab === "groups" ? "active" : ""}
            onClick={() => setTab("groups")}
          >
            그룹
          </button>
        </nav>
        <button className="sidebar-logout" onClick={() => void logout()}>
          로그아웃
        </button>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="mobile-brand">YPT WEB</div>
          <div className="top-status">
            <span className={`status-dot ${running ? "live" : ""}`} />
            {status}
            {(timer?.subject || snapshot?.remoteSubject) && (
              <span className="status-subject">
                {" · "}
                {timer?.subject || snapshot?.remoteSubject}
              </span>
            )}
            {running && <strong>{duration(liveMs)}</strong>}
          </div>
          <button className="desktop-logout" onClick={() => void logout()}>
            로그아웃
          </button>
        </header>
        <main>
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
                    onClick={() => void loadSnapshot()}
                  >
                    상태 새로고침
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
                {((timer?.state === "idle" && !appOnly) ||
                  timer?.state === "paused") && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={appIdle}
                      onChange={(event) => setAppIdle(event.target.checked)}
                    />
                    열품타 앱에서 실행 중인 타이머가 없는지 확인했습니다.
                  </label>
                )}
                <div className="timer-actions">
                  {timer?.state === "idle" && !appOnly && (
                    <button
                      className="primary"
                      disabled={busy || !appIdle || !selectedSubject}
                      onClick={() => void change("start")}
                    >
                      공부 시작
                    </button>
                  )}
                  {timer?.state === "running" && (
                    <>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void change("pause")}
                      >
                        일시정지
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
                  {timer?.state === "paused" && (
                    <>
                      <button
                        className="primary"
                        disabled={busy || !appIdle}
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
                {timer &&
                  ["starting", "stopping", "uncertain"].includes(
                    timer.state,
                  ) && (
                    <p className="caution">
                      요청 결과가 불확실합니다. 열품타 앱에서 타이머를 정지한 뒤
                      복구하세요. 같은 요청은 자동 재시도하지 않습니다.
                    </p>
                  )}
                <p className="card-note">
                  화면을 닫아도 타이머는 계속됩니다. 앱에서 시작한 타이머도
                  여기서 일시정지하거나 종료할 수 있습니다.
                </p>
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
                <div className="subject-list">
                  {snapshot?.today.subjects.map((subject) => (
                    <div className="subject-row" key={subject.title}>
                      <span>{subject.title}</span>
                      <strong>{duration(subject.studyMs)}</strong>
                    </div>
                  ))}
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
              </div>
              {!snapshot?.capabilities.history && (
                <p className="card-note">
                  과거 날짜 조회는 실제 API 확인 후 제공됩니다.
                </p>
              )}
              {loadingDay ? (
                <p>기록을 가져오는 중…</p>
              ) : day ? (
                <>
                  <div className="history-total">
                    <span>{day.date} 총 공부시간</span>
                    <strong>{duration(day.totalMs)}</strong>
                  </div>
                  <div className="subject-list">
                    {day.subjects.map((subject) => (
                      <div className="subject-row" key={subject.title}>
                        <span>{subject.title}</span>
                        <strong>{duration(subject.studyMs)}</strong>
                      </div>
                    ))}
                  </div>
                  {!day.subjectTimesAvailable && (
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
                    새로고침
                  </button>
                </div>
                {groups?.length ? (
                  <div className="group-list">
                    {groups.map((group) => (
                      <button
                        key={group.id}
                        className={selectedGroup === group.id ? "selected" : ""}
                        onClick={() => {
                          setSelectedGroup(group.id);
                          setMembers(null);
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
                      onClick={() => void loadMembers(selectedGroup)}
                    >
                      새로고침
                    </button>
                  )}
                </div>
                {groupCheckedAt && (
                  <p className="checked-time">
                    마지막 확인{" "}
                    {new Date(groupCheckedAt).toLocaleTimeString("ko-KR")}
                  </p>
                )}
                {members?.length ? (
                  <div className="member-list">
                    {members.map((member) => (
                      <div className="member-row" key={member.id}>
                        <span
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
                      : members
                        ? "표시할 멤버가 없습니다."
                        : "멤버를 가져오는 중…"}
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
          onClick={() => setTab("study")}
        >
          <span>◉</span>공부
        </button>
        <button
          className={tab === "history" ? "active" : ""}
          onClick={() => setTab("history")}
        >
          <span>▦</span>기록
        </button>
        <button
          className={tab === "groups" ? "active" : ""}
          onClick={() => setTab("groups")}
        >
          <span>◎</span>그룹
        </button>
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
