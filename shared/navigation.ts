export type Tab = "study" | "today" | "plan" | "history" | "insights" | "groups";

export function tabFromSearch(search: string): Tab {
  const tab = new URLSearchParams(search).get("tab");
  return tab === "today" || tab === "plan" || tab === "history" ||
    tab === "insights" || tab === "groups" ? tab : "study";
}

export function tabUrl(href: string, tab: Tab): string {
  const url = new URL(href);
  url.searchParams.set("tab", tab);
  return url.href;
}


function validIsoDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value;
}

export function historyDateFromSearch(search: string): string {
  const date = new URLSearchParams(search).get("date");
  return validIsoDate(date) ? date : "";
}

export function trendRangeFromSearch(search: string): 7 | 14 | 30 {
  const range = Number(new URLSearchParams(search).get("range"));
  return range === 14 || range === 30 ? range : 7;
}

export function historyViewUrl(
  href: string,
  state: { date?: string | null; range?: 7 | 14 | 30 | null },
): string {
  const url = new URL(href);
  if (state.date === null || state.date === "") url.searchParams.delete("date");
  else if (state.date !== undefined && validIsoDate(state.date))
    url.searchParams.set("date", state.date);

  if (state.range === null) url.searchParams.delete("range");
  else if (state.range !== undefined)
    url.searchParams.set("range", String(state.range));

  return url.href;
}
