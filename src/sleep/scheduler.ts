/**
 * WaxPrep v3.1 — Timezone-aware Sleep Mode Scheduler
 *
 * NO hardcoded global "everyone sleeps at 2 AM server time".
 *
 * Design:
 * - A lightweight UTC tick runs every 15 minutes (configurable).
 * - For each recently-active student, resolve their IANA timezone from:
 *     1) student_attributes.timezone / time_zone
 *     2) student_profiles.cultural_context.timezone
 *     3) DEFAULT_STUDENT_TIMEZONE env
 *     4) Africa/Lagos fallback
 * - If local hour matches preferred sleep hour (config.local_hour, default 2)
 *   and they have not been consolidated in the last ~20h, enqueue them.
 * - Batch-run sleep pipeline with concurrency limits.
 *
 * Config keys in cognitive_system_config.sleep_mode:
 *   enabled, timezone_aware, local_hour, tick_cron, max_students_per_night,
 *   min_hours_between_runs, lookback_days
 */
import cron from 'node-cron';
import { runSleepModeBatch } from './pipeline';
import { getCognitiveConfig } from '../config/cognitive';
import { logger } from '../middleware/logger';
import { db } from '../db/client';

let scheduledTask: cron.ScheduledTask | null = null;
let tickInFlight = false;

interface SleepModeRuntimeConfig {
  enabled: boolean;
  timezone_aware: boolean;
  schedule_cron: string;
  tick_cron: string;
  local_hour: number;
  max_students_per_night: number;
  min_hours_between_runs: number;
  lookback_days: number;
  batch_size: number;
}

const DEFAULTS: SleepModeRuntimeConfig = {
  enabled: true,
  timezone_aware: true,
  schedule_cron: '0 2 * * *', // legacy global fallback
  tick_cron: '*/15 * * * *',
  local_hour: 2,
  max_students_per_night: 100,
  min_hours_between_runs: 20,
  lookback_days: 7,
  batch_size: 5,
};

async function loadSleepConfig(): Promise<SleepModeRuntimeConfig> {
  try {
    const cfg = await getCognitiveConfig('sleep_mode');
    return {
      enabled: cfg.enabled !== false,
      timezone_aware: cfg.timezone_aware !== false,
      schedule_cron: (cfg.schedule_cron as string) || DEFAULTS.schedule_cron,
      tick_cron:
        ((cfg as Record<string, unknown>).tick_cron as string) || DEFAULTS.tick_cron,
      local_hour: clampInt(
        Number((cfg as Record<string, unknown>).local_hour ?? DEFAULTS.local_hour),
        0,
        23,
        DEFAULTS.local_hour
      ),
      max_students_per_night: clampInt(
        Number(cfg.max_students_per_night ?? DEFAULTS.max_students_per_night),
        1,
        5000,
        DEFAULTS.max_students_per_night
      ),
      min_hours_between_runs: clampInt(
        Number(
          (cfg as Record<string, unknown>).min_hours_between_runs ??
            DEFAULTS.min_hours_between_runs
        ),
        1,
        72,
        DEFAULTS.min_hours_between_runs
      ),
      lookback_days: clampInt(
        Number(
          (cfg as Record<string, unknown>).lookback_days ?? DEFAULTS.lookback_days
        ),
        1,
        30,
        DEFAULTS.lookback_days
      ),
      batch_size: clampInt(
        Number((cfg as Record<string, unknown>).batch_size ?? DEFAULTS.batch_size),
        1,
        25,
        DEFAULTS.batch_size
      ),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Local hour (0-23) for an IANA timezone at a given instant.
 */
export function getLocalHour(timeZone: string, at: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      hour: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(at);
    const hourPart = parts.find(p => p.type === 'hour')?.value;
    const h = Number(hourPart);
    if (!Number.isFinite(h)) return at.getUTCHours();
    // Some engines return "24" for midnight
    return h === 24 ? 0 : h;
  } catch {
    return at.getUTCHours();
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve student timezone dynamically — never a hardcoded enum of countries.
 */
export async function resolveStudentTimezone(studentId: string): Promise<string> {
  const fallback =
    process.env.DEFAULT_STUDENT_TIMEZONE ||
    process.env.TZ ||
    'Africa/Lagos';

  try {
    // 1) Dynamic attributes
    const attr = await db.query(
      `SELECT attribute_value FROM student_attributes
       WHERE student_id = $1
         AND is_active = TRUE
         AND attribute_key = ANY($2::text[])
       ORDER BY confidence DESC NULLS LAST, updated_at DESC NULLS LAST
       LIMIT 1`,
      [studentId, ['timezone', 'time_zone', 'tz', 'iana_timezone']]
    );
    if (attr.rows.length > 0) {
      const raw = attr.rows[0].attribute_value;
      const tz = normalizeTz(raw);
      if (tz) return tz;
    }

    // 2) Profile cultural context
    const prof = await db.query(
      `SELECT cultural_context FROM student_profiles WHERE student_id = $1 LIMIT 1`,
      [studentId]
    );
    if (prof.rows.length > 0) {
      const cc = prof.rows[0].cultural_context || {};
      const tz = normalizeTz(cc.timezone || cc.time_zone || cc.tz);
      if (tz) return tz;
    }
  } catch (err) {
    logger.debug({ err, studentId }, '[SleepScheduler] timezone resolve failed');
  }

  return isValidTimeZone(fallback) ? fallback : 'UTC';
}

function normalizeTz(raw: unknown): string | null {
  if (raw == null) return null;
  let s: string;
  if (typeof raw === 'string') {
    s = raw;
    // JSON string value sometimes double-encoded
    if (s.startsWith('"') && s.endsWith('"')) {
      try {
        s = JSON.parse(s);
      } catch {
        /* keep */
      }
    }
  } else if (typeof raw === 'object' && raw !== null && 'value' in (raw as object)) {
    s = String((raw as { value: unknown }).value);
  } else {
    s = String(raw).replace(/^"|"$/g, '');
  }
  s = s.trim();
  if (!s) return null;
  return isValidTimeZone(s) ? s : null;
}

/**
 * Start the sleep mode scheduler (timezone-aware tick by default).
 */
export async function startSleepScheduler(): Promise<void> {
  const config = await loadSleepConfig();
  if (!config.enabled) {
    logger.info('[SleepScheduler] Sleep mode disabled');
    return;
  }

  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  if (config.timezone_aware) {
    const expr = config.tick_cron || DEFAULTS.tick_cron;
    if (!cron.validate(expr)) {
      logger.error({ expr }, '[SleepScheduler] Invalid tick_cron — falling back to */15');
    }
    const tickExpr = cron.validate(expr) ? expr : '*/15 * * * *';

    scheduledTask = cron.schedule(tickExpr, () => {
      runTimezoneAwareTick().catch(err =>
        logger.error({ err }, '[SleepScheduler] Tick failed')
      );
    });

    logger.info(
      `[SleepScheduler] Timezone-aware tick scheduled (${tickExpr}), local_hour=${config.local_hour}`
    );
    return;
  }

  // Legacy: single global cron (server/local process timezone)
  const cronExpression = config.schedule_cron || DEFAULTS.schedule_cron;
  scheduledTask = cron.schedule(cronExpression, async () => {
    logger.info('[SleepScheduler] Starting legacy global consolidation');
    await runNightlyConsolidation(config.max_students_per_night);
  });
  logger.info(`[SleepScheduler] Legacy global cron scheduled for ${cronExpression}`);
}

export function stopSleepScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

/**
 * Core tick: pick students whose local time is the sleep hour.
 */
export async function runTimezoneAwareTick(): Promise<{
  considered: number;
  eligible: number;
  ran: number;
}> {
  if (tickInFlight) {
    logger.debug('[SleepScheduler] Tick already in flight — skip');
    return { considered: 0, eligible: 0, ran: 0 };
  }
  tickInFlight = true;

  try {
    const config = await loadSleepConfig();
    if (!config.enabled) return { considered: 0, eligible: 0, ran: 0 };

    const candidates = await listActiveStudentIds(
      config.lookback_days,
      config.max_students_per_night * 3
    );
    const now = new Date();
    const eligible: string[] = [];

    for (const studentId of candidates) {
      if (eligible.length >= config.max_students_per_night) break;

      const tz = await resolveStudentTimezone(studentId);
      const hour = getLocalHour(tz, now);
      if (hour !== config.local_hour) continue;

      const due = await isDueForSleep(studentId, config.min_hours_between_runs);
      if (!due) continue;

      eligible.push(studentId);
    }

    if (eligible.length === 0) {
      logger.debug(
        { considered: candidates.length, local_hour: config.local_hour },
        '[SleepScheduler] No students in local sleep window'
      );
      return { considered: candidates.length, eligible: 0, ran: 0 };
    }

    logger.info(
      { count: eligible.length, local_hour: config.local_hour },
      '[SleepScheduler] Running timezone-aware consolidation'
    );

    await runInBatches(eligible, config.batch_size);
    return { considered: candidates.length, eligible: eligible.length, ran: eligible.length };
  } finally {
    tickInFlight = false;
  }
}

async function listActiveStudentIds(lookbackDays: number, limit: number): Promise<string[]> {
  const result = await db.query(
    `SELECT student_id, MAX(timestamp) AS last_ts
     FROM conversation_turns
     WHERE timestamp > NOW() - ($1::text || ' days')::interval
     GROUP BY student_id
     ORDER BY last_ts DESC
     LIMIT $2`,
    [String(lookbackDays), limit]
  );
  return result.rows.map(r => r.student_id as string);
}

async function isDueForSleep(studentId: string, minHours: number): Promise<boolean> {
  try {
    const result = await db.query(
      `SELECT MAX(completed_at) AS last_done
       FROM consolidation_logs
       WHERE student_id = $1
         AND completed_at IS NOT NULL
         AND error_message IS NULL`,
      [studentId]
    );
    const last = result.rows[0]?.last_done;
    if (!last) return true;
    const ageMs = Date.now() - new Date(last as string).getTime();
    return ageMs >= minHours * 3600_000;
  } catch {
    return true;
  }
}

async function runInBatches(studentIds: string[], batchSize: number): Promise<void> {
  for (let i = 0; i < studentIds.length; i += batchSize) {
    const batch = studentIds.slice(i, i + batchSize);
    await runSleepModeBatch(batch);
    if (i + batchSize < studentIds.length) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

/**
 * Legacy entry: consolidate recently active students regardless of timezone.
 * Kept for admin/manual bulk runs.
 */
export async function runNightlyConsolidation(maxStudents: number): Promise<void> {
  try {
    const config = await loadSleepConfig();
    const result = await db.query(
      `SELECT DISTINCT student_id FROM conversation_turns
       WHERE timestamp > NOW() - INTERVAL '7 days'
       ORDER BY student_id
       LIMIT $1`,
      [maxStudents]
    );

    const studentIds = result.rows.map(r => r.student_id as string);
    if (studentIds.length === 0) {
      logger.info('[SleepScheduler] No active students to consolidate');
      return;
    }

    logger.info(`[SleepScheduler] Consolidating ${studentIds.length} students (bulk)`);
    await runInBatches(studentIds, config.batch_size);
    logger.info('[SleepScheduler] Bulk consolidation complete');
  } catch (err) {
    logger.error({ err }, '[SleepScheduler] Bulk consolidation failed');
  }
}

/**
 * Manually trigger sleep mode for a specific student.
 */
export async function triggerSleepModeForStudent(studentId: string): Promise<void> {
  const { runSleepMode } = await import('./pipeline');
  await runSleepMode(studentId);
}

/**
 * Admin helper: preview who would sleep on the next tick.
 */
export async function previewSleepCandidates(limit = 50): Promise<
  Array<{ studentId: string; timezone: string; localHour: number; due: boolean }>
> {
  const config = await loadSleepConfig();
  const candidates = await listActiveStudentIds(config.lookback_days, limit);
  const now = new Date();
  const out: Array<{
    studentId: string;
    timezone: string;
    localHour: number;
    due: boolean;
  }> = [];

  for (const studentId of candidates) {
    const timezone = await resolveStudentTimezone(studentId);
    const localHour = getLocalHour(timezone, now);
    const due = await isDueForSleep(studentId, config.min_hours_between_runs);
    out.push({ studentId, timezone, localHour, due });
  }
  return out;
}
