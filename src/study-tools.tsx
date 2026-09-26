import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  freshInterval, intervalRemaining, parseInterval, parseIntervalSettings,
  parsePlan, PLAN_ESTIMATES,
} from "../shared/study-tools.ts";
import type { IntervalPhase, IntervalSettings, IntervalTimer, PlanItem } from "../shared/study-tools.ts";

const STORAGE_PREFIX = "ypt-web-personal-tools-";
const phaseNames: Record<IntervalPhase, string> = { focus: "집중", short: "짧은 휴식", long: "긴 휴식" };

function stored(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep it in this page. */ }
}

export function clearPersonalTools() {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch { /* Storage may be unavailable. */ }
}

function clock(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function StudyTools({ date, now }: { date: string; now: number }) {
  const planKey = `${STORAGE_PREFIX}plan-${date}`;
  const intervalKey = `${STORAGE_PREFIX}interval-${date}`;
  const taskKey = `${STORAGE_PREFIX}task-${date}`;
  const [items, setItems] = useState<PlanItem[]>(() => parsePlan(stored(planKey)));
  const [activeTaskId, setActiveTaskId] = useState(() => stored(taskKey) ?? "");
  const [draft, setDraft] = useState("");
  const [estimate, setEstimate] = useState<number>(25);
  const [timer, setTimer] = useState<IntervalTimer>(() => parseInterval(stored(intervalKey)));
  const [settings, setSettings] = useState<IntervalSettings>(() => parseIntervalSettings(stored(`${STORAGE_PREFIX}settings`)));
  const [settingsDraft, setSettingsDraft] = useState<Record<IntervalPhase, string>>(() => {
    const saved = parseIntervalSettings(stored(`${STORAGE_PREFIX}settings`));
    return { focus: String(saved.focus), short: String(saved.short), long: String(saved.long) };
  });
  const [settingsError, setSettingsError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => save(planKey, items), [planKey, items]);
  useEffect(() => save(intervalKey, timer), [intervalKey, timer]);
  useEffect(() => save(`${STORAGE_PREFIX}settings`, settings), [settings]);
  useEffect(() => {
    try {
      if (activeTaskId) sessionStorage.setItem(taskKey, activeTaskId);
      else sessionStorage.removeItem(taskKey);
    } catch { /* Keep the selection in this page. */ }
  }, [activeTaskId, taskKey]);
  useEffect(() => {
    if (timer.endsAt !== null && now >= timer.endsAt) {
      setTimer((current) => current.endsAt !== null && now >= current.endsAt
        ? { ...current, endsAt: null, remainingMs: 0, completed: true }
        : current);
    }
  }, [timer.endsAt, now]);

  const completed = items.filter((item) => item.done);
  const plannedMinutes = items.reduce((sum, item) => sum + item.estimateMinutes, 0);
  const completedMinutes = completed.reduce((sum, item) => sum + item.estimateMinutes, 0);
  const activeTask = items.find((item) => item.id === activeTaskId && !item.done);
  const remainingMs = intervalRemaining(timer, now);
  const active = timer.endsAt !== null && remainingMs > 0;

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (items.length >= 12) { setNotice("할 일은 오늘 최대 12개까지 적을 수 있어요."); return; }
    setItems((old) => [...old, { id: crypto.randomUUID(), text, estimateMinutes: estimate, done: false }]);
    setDraft("");
    setNotice("");
  }

  function choosePhase(phase: IntervalPhase) {
    setTimer(freshInterval(phase, settings[phase]));
    setNotice("");
  }
  function applySettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = {
      focus: Number(settingsDraft.focus), short: Number(settingsDraft.short), long: Number(settingsDraft.long),
    };
    const parsed = parseIntervalSettings(JSON.stringify(next));
    if (parsed.focus !== next.focus || parsed.short !== next.short || parsed.long !== next.long) {
      setSettingsError("집중은 5~180분, 휴식은 각각 1~60분으로 입력해 주세요.");
      return;
    }
    setSettings(next);
    setSettingsError("");
    if (timer.endsAt === null) setTimer(freshInterval(timer.phase, next[timer.phase]));
  }
  function toggleInterval() {
    if (active) setTimer((old) => ({ ...old, remainingMs: intervalRemaining(old, Date.now()), endsAt: null }));
    else setTimer((old) => {
      const currentRemaining = intervalRemaining(old, Date.now()) || settings[old.phase] * 60_000;
      return { ...old, remainingMs: currentRemaining, endsAt: Date.now() + currentRemaining, completed: false };
    });
    setNotice("");
  }

  return <div className="study-tools-grid">
    <section className="tool-card" aria-labelledby="plan-heading">
      <div className="card-head"><span id="plan-heading">오늘의 계획</span><strong>{completed.length}/{items.length}</strong></div>
      <p className="tool-intro">할 일과 예상 시간을 정해 오늘의 흐름을 잡아보세요.</p>
      <form className="plan-form" onSubmit={addItem}>
        <label className="visually-hidden" htmlFor="plan-text">할 일</label>
        <input id="plan-text" type="text" maxLength={80} placeholder="오늘 할 일" value={draft}
          onChange={(event) => setDraft(event.target.value)} />
        <label className="visually-hidden" htmlFor="plan-estimate">예상 시간</label>
        <select id="plan-estimate" value={estimate} onChange={(event) => setEstimate(Number(event.target.value))}>
          {PLAN_ESTIMATES.map((minutes) => <option value={minutes} key={minutes}>{minutes}분</option>)}
        </select>
        <button className="secondary" type="submit" disabled={!draft.trim() || items.length >= 12}>추가</button>
      </form>
      {items.length > 0 ? <>
        <div className="plan-progress" role="progressbar" aria-label="완료한 계획" aria-valuenow={completed.length} aria-valuemin={0} aria-valuemax={items.length}>
          <span style={{ width: `${completed.length / items.length * 100}%` }} />
        </div>
        <p className="plan-estimate">예상 {completedMinutes}분 완료 / 전체 {plannedMinutes}분</p>
        <ul className="plan-list">
          {items.map((item) => <li key={item.id} className={item.done ? "is-done" : ""}>
            <label><input type="checkbox" checked={item.done} onChange={() => setItems((old) => old.map((candidate) =>
              candidate.id === item.id ? { ...candidate, done: !candidate.done } : candidate))} />
              <span>{item.text}</span></label>
            <small>{item.estimateMinutes}분</small>
            {!item.done && <button className="text-button plan-focus" type="button"
              aria-pressed={activeTaskId === item.id}
              onClick={() => setActiveTaskId((old) => old === item.id ? "" : item.id)}>
              {activeTaskId === item.id ? "선택됨" : "집중"}
            </button>}
            <button className="text-button" type="button" aria-label={`${item.text} 삭제`}
              onClick={() => setItems((old) => old.filter((candidate) => candidate.id !== item.id))}>×</button>
          </li>)}
        </ul>
        {completed.length > 0 && <button className="text-button clear-done" type="button"
          onClick={() => setItems((old) => old.filter((item) => !item.done))}>완료 항목 지우기</button>}
      </> : <p className="tool-empty">아직 계획이 없어요. 작은 일부터 하나 적어보세요.</p>}
      {notice && <p className="tool-notice" role="status">{notice}</p>}
      <p className="tool-footnote">예상 시간은 직접 적은 계획이며 열품타 공부시간에 합산되지 않습니다.</p>
    </section>

    <section className="tool-card interval-card" aria-labelledby="interval-heading">
      <div className="card-head"><span id="interval-heading">집중 리듬</span><span className="tool-local">이 탭에서만</span></div>
      <p className="tool-intro">원하는 구간을 고르고 시간을 확인하세요.</p>
      <div className="interval-phases" role="group" aria-label="카운트다운 구간">
        {(Object.keys(phaseNames) as IntervalPhase[]).map((phase) => <button type="button" key={phase}
          className={timer.phase === phase ? "selected" : ""} aria-pressed={timer.phase === phase}
          onClick={() => choosePhase(phase)}>{phaseNames[phase]} {settings[phase]}분</button>)}
      </div>
      <div className="interval-display" role="timer" aria-label={`${phaseNames[timer.phase]} 남은 시간 ${clock(remainingMs)}`}>
        <span>{timer.phase === "focus" ? "FOCUS" : "REST"}</span>
        <strong>{clock(remainingMs)}</strong>
        {timer.phase === "focus" && activeTask && <em>{activeTask.text}</em>}
        <small role={timer.completed || remainingMs === 0 ? "status" : undefined}>{timer.completed || remainingMs === 0 ? "시간이 끝났어요. 다음 구간을 선택해 주세요." :
          active ? "진행 중" : "준비됨"}</small>
      </div>
      <div className="interval-actions">
        <button className="primary" type="button" onClick={toggleInterval}>{active ? "잠시 멈춤" : remainingMs === 0 ? "다시 시작" : "시작 / 계속"}</button>
        <button className="secondary" type="button" onClick={() => choosePhase(timer.phase)}>초기화</button>
      </div>
      <details className="interval-settings">
        <summary>구간 길이 조정</summary>
        <form onSubmit={applySettings}>
          {(Object.keys(phaseNames) as IntervalPhase[]).map((phase) => <label key={phase}>
            {phaseNames[phase]}
            <input type="number" inputMode="numeric" min={phase === "focus" ? 5 : 1}
              max={phase === "focus" ? 180 : 60} step={1} value={settingsDraft[phase]}
              onChange={(event) => setSettingsDraft((old) => ({ ...old, [phase]: event.target.value }))} />분
          </label>)}
          <button className="secondary" type="submit">적용</button>
        </form>
        {settingsError && <p className="tool-notice" role="alert">{settingsError}</p>}
        <p className="tool-footnote">진행 중이라면 다음 구간부터 새 길이가 적용됩니다.</p>
      </details>
      <p className="tool-footnote">이 카운트다운은 열품타 타이머를 시작·정지하지 않습니다. 휴식할 때는 열품타 타이머도 직접 일시정지하세요.</p>
    </section>
  </div>;
}
