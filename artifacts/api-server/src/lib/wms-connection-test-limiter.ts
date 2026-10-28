type TestKind = "connection" | "vpn";

type SiteLimit = {
  active: boolean;
  nextConnectionAt: number;
  nextVpnAt: number;
};

const COOLDOWN_MS = 10_000;
const AGGREGATE_WINDOW_MS = 10_000;
const MAX_ACTIVE_TESTS = 8;
const MAX_TEST_STARTS_PER_WINDOW = 20;
const MAX_SITE_ENTRIES = 128;

type LimiterLimits = {
  maxActiveTests?: number;
  maxTestStartsPerWindow?: number;
  maxSiteEntries?: number;
};

/**
 * Bounds connection checks both per authorized warehouse and across the process.
 * Callers must authorize the request before acquiring a lease.
 */
export class WmsConnectionTestLimiter {
  private readonly sites = new Map<string, SiteLimit>();
  private readonly starts: number[] = [];
  private activeTests = 0;

  constructor(private readonly limits: LimiterLimits = {}) {}

  acquire(siteKey: string, kind: TestKind, now = Date.now()): (() => void) | undefined {
    while (this.starts.length && this.starts[0]! <= now - AGGREGATE_WINDOW_MS) {
      this.starts.shift();
    }
    if (this.activeTests >= (this.limits.maxActiveTests ?? MAX_ACTIVE_TESTS) ||
      this.starts.length >= (this.limits.maxTestStartsPerWindow ?? MAX_TEST_STARTS_PER_WINDOW)) {
      return undefined;
    }

    let site = this.sites.get(siteKey);
    if (!site) {
      this.removeExpiredSites(now);
      if (this.sites.size >= (this.limits.maxSiteEntries ?? MAX_SITE_ENTRIES)) return undefined;
      site = { active: false, nextConnectionAt: 0, nextVpnAt: 0 };
      this.sites.set(siteKey, site);
    }

    const nextAllowedAt = kind === "connection" ? site.nextConnectionAt : site.nextVpnAt;
    if (site.active || now < nextAllowedAt) return undefined;

    site.active = true;
    if (kind === "connection") site.nextConnectionAt = now + COOLDOWN_MS;
    else site.nextVpnAt = now + COOLDOWN_MS;
    this.activeTests += 1;
    this.starts.push(now);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      site!.active = false;
      this.activeTests -= 1;
    };
  }

  private removeExpiredSites(now: number): void {
    for (const [key, site] of this.sites) {
      if (!site.active && site.nextConnectionAt <= now && site.nextVpnAt <= now) {
        this.sites.delete(key);
      }
    }
  }
}
