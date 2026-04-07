import { loadConfig, resolveEnvString } from "./config";

/** IANA zone from env, config, or host default (e.g. macOS system zone). */
export function getResolvedUserTimezone(): string {
  const env = resolveEnvString("USER_TIMEZONE") ?? resolveEnvString("ACTIVITY_TIMEZONE");
  if (env?.trim()) return env.trim();
  try {
    const cfg = loadConfig();
    if (cfg.timezone?.trim()) return cfg.timezone.trim();
  } catch {
    /* ignore */
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** UTC instant → local wall-clock in `timeZone`, format YYYY-MM-DDTHH:MM:SS.mmm (no suffix). */
export function utcIsoToLocalWall(isoUtc: string, timeZone: string): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) {
    return utcIsoToLocalWall(new Date().toISOString(), timeZone);
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      fractionalSecondDigits: 3,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
    const y = get("year");
    const mo = get("month");
    const da = get("day");
    const h = get("hour");
    const mi = get("minute");
    const s = get("second");
    const f = get("fractionalSecond") || "000";
    return `${y}-${mo}-${da}T${h}:${mi}:${s}.${f}`;
  } catch {
    return utcIsoToLocalWall(isoUtc, "UTC");
  }
}

export function localCalendarDateInZone(isoUtc: string, timeZone: string): string {
  return utcIsoToLocalWall(isoUtc, timeZone).slice(0, 10);
}

export function normalizeUtcIso(input: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}
