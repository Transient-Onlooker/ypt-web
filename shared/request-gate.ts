// Only one automatic refresh runs at a time; a forced refresh supersedes it.
export class RequestGate {
  private latest = 0;
  private active: number | null = null;

  start(force = false): number | null {
    if (this.active !== null && !force) return null;
    const id = ++this.latest;
    this.active = id;
    return id;
  }

  isCurrent(id: number): boolean {
    return id === this.latest;
  }

  finish(id: number): boolean {
    if (this.active === id) this.active = null;
    return this.isCurrent(id);
  }

  invalidate() {
    this.latest++;
    this.active = null;
  }
}
