export type Tab = "study" | "history" | "groups";

export function tabFromSearch(search: string): Tab {
  const tab = new URLSearchParams(search).get("tab");
  return tab === "history" || tab === "groups" ? tab : "study";
}

export function tabUrl(href: string, tab: Tab): string {
  const url = new URL(href);
  url.searchParams.set("tab", tab);
  return url.href;
}
