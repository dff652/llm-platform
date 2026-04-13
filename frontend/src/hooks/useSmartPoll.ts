import { useEffect, useRef, useCallback } from 'react';

/** Preset: 5s when active, 30s when idle, backoff to 60s after 1 minute. */
export const SMART_POLL_ACTIVE_IDLE = {
  getInterval: (s: string) => s === 'active' ? 5000 : 30000,
  backoffAfterMs: 60000,
  backoffMaxMs: 60000,
} as const;

/**
 * Configuration for useSmartPoll.
 */
export interface SmartPollConfig {
  /** Map task status to poll interval in ms. Return null to stop polling. */
  getInterval: (status: string) => number | null;
  /** Whether polling is enabled (default true). */
  enabled?: boolean;
  /** Maximum consecutive errors before stopping (default 5). */
  maxErrors?: number;
  /** Linear backoff: after this many ms in same status, add `backoffStepMs` each tick, up to `backoffMaxMs`. */
  backoffAfterMs?: number;
  /** Milliseconds to add per backoff step (default 1000). */
  backoffStepMs?: number;
  /** Maximum interval after backoff (default 10000). */
  backoffMaxMs?: number;
}

/**
 * Smart polling hook with adaptive intervals, Page Visibility integration,
 * and optional X-Poll-After header support.
 *
 * @param fn         Async function called each tick. Receives `silent` boolean (true for background refreshes).
 *                   May return a number (X-Poll-After seconds from backend) to override the local interval,
 *                   or undefined to use local strategy.
 * @param status     Current status string (e.g. TaskStatus). Drives interval selection.
 * @param config     SmartPollConfig with getInterval and optional backoff settings.
 */
export function useSmartPoll(
  fn: (silent: boolean) => Promise<number | undefined | void>,
  status: string | null | undefined,
  config: SmartPollConfig,
) {
  const {
    getInterval,
    enabled = true,
    maxErrors = 5,
    backoffAfterMs = 30000,
    backoffStepMs = 1000,
    backoffMaxMs = 10000,
  } = config;

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const errCountRef = useRef(0);
  const statusEnteredAtRef = useRef<number>(Date.now());
  const prevStatusRef = useRef<string | null | undefined>(status);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverIntervalRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  // Track when status changes to reset backoff timer
  useEffect(() => {
    if (status !== prevStatusRef.current) {
      prevStatusRef.current = status;
      statusEnteredAtRef.current = Date.now();
      serverIntervalRef.current = null; // reset server hint on status change
    }
  }, [status]);

  const computeInterval = useCallback((): number | null => {
    // Server override takes precedence
    if (serverIntervalRef.current !== null) {
      if (serverIntervalRef.current < 0) return null; // server says stop
      return serverIntervalRef.current * 1000; // seconds -> ms
    }

    if (!status) return null;
    const base = getInterval(status);
    if (base === null) return null;

    // Apply linear backoff if in same status for a while
    const elapsed = Date.now() - statusEnteredAtRef.current;
    if (elapsed > backoffAfterMs) {
      const steps = Math.floor((elapsed - backoffAfterMs) / backoffStepMs);
      return Math.min(base + steps * backoffStepMs, backoffMaxMs);
    }

    return base;
  }, [status, getInterval, backoffAfterMs, backoffStepMs, backoffMaxMs]);

  const scheduleTick = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!isMountedRef.current || !enabled) return;
    if (errCountRef.current >= maxErrors) return;

    const interval = computeInterval();
    if (interval === null) return;

    timerRef.current = setTimeout(async () => {
      if (!isMountedRef.current) return;
      try {
        const serverHint = await fnRef.current(true);
        if (typeof serverHint === 'number') {
          serverIntervalRef.current = serverHint;
        }
        errCountRef.current = 0;
      } catch {
        errCountRef.current += 1;
      }
      scheduleTick();
    }, interval);
  }, [enabled, maxErrors, computeInterval]);

  // Ref so visibility and initial-fetch effects always call the latest scheduleTick
  // without depending on its identity (which changes when status/config changes).
  const scheduleTickRef = useRef(scheduleTick);
  scheduleTickRef.current = scheduleTick;

  // Page Visibility: pause on hidden, resume on visible
  useEffect(() => {
    if (!enabled) return;

    const handleVisibility = () => {
      if (document.hidden) {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      } else if (isMountedRef.current) {
        fnRef.current(true)
          .then((serverHint) => {
            if (typeof serverHint === 'number') {
              serverIntervalRef.current = serverHint;
            }
            errCountRef.current = 0;
          })
          .catch(() => {
            errCountRef.current += 1;
          })
          .finally(() => {
            scheduleTickRef.current();
          });
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled]);

  // Main effect: initial fetch only once (when enabled toggles on)
  useEffect(() => {
    isMountedRef.current = true;
    errCountRef.current = 0;

    if (!enabled) return;

    fnRef.current(false)
      .then((serverHint) => {
        if (typeof serverHint === 'number') {
          serverIntervalRef.current = serverHint;
        }
      })
      .catch(() => {
        errCountRef.current += 1;
      })
      .finally(() => {
        scheduleTickRef.current();
      });

    return () => {
      isMountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reschedule when status changes (interval may have changed)
  useEffect(() => {
    if (enabled && isMountedRef.current) {
      scheduleTick();
    }
  }, [status, enabled, scheduleTick]);
}
