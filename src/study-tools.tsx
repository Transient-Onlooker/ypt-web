import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  bulkPlanCandidates, eligibleCarryOver, parsePlan, PLAN_ESTIMATES, planTemplate,
  previousCalendarDate, summarizePlannedSubjects,
} from "../shared/study-tools.ts";
import type { PlanItem } from "../shared/study-tools.ts";
import type { Day, Subject } from "../shared/types.ts";
import { duration } from "../shared/format.ts";

const STORAGE_PREFIX = "ypt-web-personal-tools-";

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

export function StudyTools({ date, today, subjects, onFocusTaskChange }: {
  date: string; today: Day; subjects: Subject[]; onFocusTaskChange: (task: string) => void;
}) {
  const planKey = `${STORAGE_PREFIX}plan-${date}`;
  const taskKey = `${STORAGE_PREFIX}task-${date}`;
  const templateKey = `${STORAGE_PREFIX}plan-template`;
  const [items, setItems] = useState<PlanItem[]>(() => parsePlan(stored(planKey)));
  const [previousItems] = useState<PlanItem[]>(() => parsePlan(stored(
    `${STORAGE_PREFIX}plan-${previousCalendarDate(date)}`)));
  const [template, setTemplate] = useState<PlanItem[]>(() => parsePlan(stored(templateKey)));
  const [activeTaskId, setActiveTaskId] = useState(() => stored(taskKey) ?? "");
  const [draft, setDraft] = useState("");
  const [bulkDraft, setBulkDraft] = useState("");
  const [estimate, setEstimate] = useState<number>(25);
  const [selectedPlanSubject, setSelectedPlanSubject] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => save(planKey, items), [planKey, items]);
  useEffect(() => save(templateKey, template), [templateKey, template]);
  useEffect(() => {
    if (selectedPlanSubject && !subjects.some((subject) => subject.title === selectedPlanSubject))
      setSelectedPlanSubject("");
  }, [subjects, selectedPlanSubject]);
  useEffect(() => {
    try {
      if (activeTaskId) sessionStorage.setItem(taskKey, activeTaskId);
      else sessionStorage.removeItem(taskKey);
    } catch { /* Keep the selection in this page. */ }
  }, [activeTaskId, taskKey]);

  const completed = items.filter((item) => item.done);
  const plannedMinutes = items.reduce((sum, item) => sum + item.estimateMinutes, 0);
  const completedMinutes = completed.reduce((sum, item) => sum + item.estimateMinutes, 0);
  const activeTask = items.find((item) => item.id === activeTaskId && !item.done);
  useEffect(() => onFocusTaskChange(activeTask?.text ?? ""), [activeTask?.text, onFocusTaskChange]);
  const carryOver = eligibleCarryOver(items, previousItems);
  const templateToAdd = eligibleCarryOver(items, template);
  const plannedSubjects = summarizePlannedSubjects(items, today);

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (items.length >= 12) { setNotice("할 일은 오늘 최대 12개까지 적을 수 있어요."); return; }
    setItems((old) => [...old, { id: crypto.randomUUID(), text, estimateMinutes: estimate, done: false,
      ...(subjects.some((subject) => subject.title === selectedPlanSubject)
        ? { subjectTitle: selectedPlanSubject } : {}) }]);
    setDraft("");
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
        <label className="visually-hidden" htmlFor="plan-subject">과목 연결</label>
        <select className="plan-subject-select" id="plan-subject" value={selectedPlanSubject}
          onChange={(event) => setSelectedPlanSubject(event.target.value)}>
          <option value="">과목 연결 안 함</option>
          {subjects.map((subject) => <option key={subject.title} value={subject.title}>{subject.title}</option>)}
        </select>
        <button className="secondary" type="submit" disabled={!draft.trim() || items.length >= 12}>추가</button>
      </form>
      {carryOver.length > 0 && <button className="text-button plan-carry" type="button"
        onClick={() => setItems((old) => [...old, ...eligibleCarryOver(old, previousItems).map((item) =>
          ({ ...item, id: crypto.randomUUID(), done: false }))])}>
        어제 미완료 {carryOver.length}개 이어가기
      </button>}
      <details className="plan-template">
        <summary>반복 계획</summary>
        <div className="plan-template-actions">
          <button className="secondary" type="button" disabled={items.length === 0}
            onClick={() => { setTemplate(planTemplate(items)); setNotice("현재 계획을 반복 계획으로 저장했어요."); }}>
            현재 계획 저장
          </button>
          <button className="secondary" type="button" disabled={templateToAdd.length === 0}
            onClick={() => {
              setItems((old) => [...old, ...eligibleCarryOver(old, template).map((item) =>
                ({ ...item, id: crypto.randomUUID(), done: false }))]);
              setNotice("반복 계획을 오늘로 가져왔어요.");
            }}>불러오기{templateToAdd.length > 0 ? ` ${templateToAdd.length}개` : ""}</button>
        </div>
        <p>완료 표시를 지워 저장합니다. 같은 이름의 할 일은 중복으로 추가하지 않습니다. 로그아웃하면 이 탭의 반복 계획도 삭제됩니다.</p>
      </details>
      <details className="plan-template">
        <summary>여러 할 일 빠른 입력</summary>
        <label className="visually-hidden" htmlFor="plan-bulk">한 줄에 할 일 하나씩</label>
        <textarea id="plan-bulk" rows={4} maxLength={1500} value={bulkDraft}
          placeholder={"한 줄에 하나씩 적거나 붙여넣기\n예: 영어 단어 복습\n수학 문제 풀기"}
          onChange={(event) => setBulkDraft(event.target.value)} />
        <button className="secondary" type="button" disabled={!bulkDraft.trim() || items.length >= 12}
          onClick={() => {
            const candidates = bulkPlanCandidates(bulkDraft, items);
            if (candidates.length === 0) {
              setNotice("추가할 새 할 일이 없습니다. 중복이나 80자 제한을 확인해 주세요.");
              return;
            }
            setItems((old) => [...old, ...bulkPlanCandidates(bulkDraft, old).map((text) =>
              ({ id: crypto.randomUUID(), text, estimateMinutes: estimate, done: false,
                ...(subjects.some((subject) => subject.title === selectedPlanSubject)
                  ? { subjectTitle: selectedPlanSubject } : {}) }))]);
            setBulkDraft("");
            setNotice(`${candidates.length}개를 추가했어요.`);
          }}>선택한 예상 시간으로 추가</button>
        <p>위에서 고른 예상 시간과 과목을 모두 적용합니다. 중복은 건너뛰고 최대 12개까지 추가합니다.</p>
      </details>
      {items.length > 0 ? <>
        <div className="plan-progress" role="progressbar" aria-label="완료한 계획" aria-valuenow={completed.length} aria-valuemin={0} aria-valuemax={items.length}>
          <span style={{ width: `${completed.length / items.length * 100}%` }} />
        </div>
        <p className="plan-estimate">예상 {completedMinutes}분 완료 / 전체 {plannedMinutes}분</p>
        <ul className="plan-list">
          {items.map((item) => <li key={item.id} className={item.done ? "is-done" : ""}>
            <label><input type="checkbox" checked={item.done} onChange={() => setItems((old) => old.map((candidate) =>
              candidate.id === item.id ? { ...candidate, done: !candidate.done } : candidate))} />
              <span>{item.text}{item.subjectTitle && <small className="plan-subject-name"> · {item.subjectTitle}</small>}</span></label>
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
      {plannedSubjects.length > 0 && <div className="plan-vs-record">
        <h3>과목 계획과 완료 기록</h3>
        {plannedSubjects.map((subject) => <div className="plan-vs-record-row" key={subject.title}>
          <div className="plan-vs-record-label">
            <span className="subject-color" style={{ backgroundColor: subject.color || "#8aa494" }} aria-hidden="true" />
            <strong>{subject.title}</strong>
          </div>
          <p>계획 {subject.plannedMs / 60_000}분 · 완료 기록 {subject.recordedMs === null ? "미확인" : duration(subject.recordedMs)}</p>
          {subject.recordedMs !== null && <small>계획 대비 {Math.floor(subject.recordedMs / subject.plannedMs * 100)}%</small>}
          {subject.recordedMs !== null && <div className="plan-vs-record-track" role="progressbar"
            aria-label={`${subject.title} 계획 대비 완료 기록`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.floor(subject.recordedMs / subject.plannedMs * 100))}>
            <span style={{ width: `${Math.min(100, subject.recordedMs / subject.plannedMs * 100)}%` }} />
          </div>}
        </div>)}
        <p>완료 기록은 해당 과목 전체 시간이며, 위 할 일만 따로 측정한 값은 아닙니다. 진행 중인 시간은 제외합니다.</p>
      </div>}
      <p className="tool-footnote">예상 시간은 직접 적은 계획이며 열품타 공부시간에 합산되지 않습니다.</p>
    </section>

  </div>;
}
