// Horario de atención del bot (pedido "ponerle un horario a la IA"): días de la semana con uno o
// más tramos HH:MM–HH:MM, en la zona horaria elegida. Fuera de horario el bot no responde (ver
// WhatsappService.handleIncomingMessage). Todo el cálculo de zona horaria usa Intl, sin librerías.

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export interface TimeRange {
  from: string; // "09:00"
  to: string; // "13:00"
}
export type WeeklySchedule = Partial<Record<DayKey, TimeRange[]>>;

export const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';
export const MAX_RANGES_PER_DAY = 4;
export const OFF_HOURS_MESSAGE_MAX_LEN = 1500;
export const DEFAULT_OFF_HOURS_MESSAGE =
  'Hola {nombre}, en este momento estamos fuera de nuestro horario de atención. Te respondemos apenas volvamos.';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Valida y normaliza lo que manda el panel. Devuelve el horario limpio o un mensaje de error. */
export function parseSchedule(input: unknown): { schedule: WeeklySchedule } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '"schedule" debe ser un objeto por día' };
  const out: WeeklySchedule = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(DAY_KEYS as readonly string[]).includes(key)) return { error: `Día desconocido: "${key}"` };
    if (!Array.isArray(value)) return { error: `Los tramos de "${key}" deben ser una lista` };
    if (value.length > MAX_RANGES_PER_DAY) return { error: `Máximo ${MAX_RANGES_PER_DAY} tramos por día` };
    const ranges: TimeRange[] = [];
    for (const r of value) {
      const from = (r as any)?.from;
      const to = (r as any)?.to;
      if (typeof from !== 'string' || typeof to !== 'string' || !TIME_RE.test(from) || !TIME_RE.test(to)) {
        return { error: `Hora inválida en "${key}" (formato HH:MM)` };
      }
      if (toMin(from) >= toMin(to)) return { error: `En "${key}" el "desde" tiene que ser anterior al "hasta"` };
      ranges.push({ from, to });
    }
    ranges.sort((a, b) => toMin(a.from) - toMin(b.from));
    out[key as DayKey] = ranges;
  }
  return { schedule: out };
}

/** Día de la semana, fecha y minuto del día en la zona horaria dada. */
function localParts(date: Date, tz: string): { day: DayKey; y: number; m: number; d: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday').toLowerCase().slice(0, 3) as DayKey;
  return { day, y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Instante UTC de una hora local (fecha y minuto) en la zona dada. */
function zonedToUtc(y: number, m: number, d: number, minute: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  const p = localParts(new Date(guess), tz);
  const asLocal = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.minute / 60), p.minute % 60);
  return new Date(guess - (asLocal - guess));
}

export class BusinessHoursService {
  /** ¿Está abierto en este instante? Sin horario activo, siempre abierto. */
  static isOpen(enabled: boolean, schedule: WeeklySchedule | null | undefined, tz: string, now: Date = new Date()): boolean {
    if (!enabled) return true;
    const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
    const { day, minute } = localParts(now, zone);
    return (schedule?.[day] ?? []).some((r) => minute >= toMin(r.from) && minute < toMin(r.to));
  }

  /** Último momento en que cerró (el fin de tramo más reciente antes de `now`), o null si no hubo
   * ninguno en la última semana. Sirve para mandar el aviso fuera de horario una sola vez por
   * período cerrado. */
  static lastClosedAt(schedule: WeeklySchedule | null | undefined, tz: string, now: Date = new Date()): Date | null {
    const zone = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
    for (let back = 0; back <= 7; back++) {
      const ref = localParts(new Date(now.getTime() - back * 86400000), zone);
      const ends = (schedule?.[ref.day] ?? []).map((r) => zonedToUtc(ref.y, ref.m, ref.d, toMin(r.to), zone)).filter((t) => t <= now);
      if (ends.length) return new Date(Math.max(...ends.map((t) => t.getTime())));
    }
    return null;
  }

  static renderOffHoursMessage(template: string, contactName: string): string {
    const text = template.trim() || DEFAULT_OFF_HOURS_MESSAGE;
    return text.replace(/\{nombre\}/g, contactName.trim() || '');
  }
}
