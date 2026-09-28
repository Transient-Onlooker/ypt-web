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
