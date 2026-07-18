function boundedRetryDelay(attempt, {
  baseDelay = 2_000,
  maxDelay = 60_000,
  jitterRatio = 0.2,
  random = Math.random,
} = {}) {
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  const exponential = Math.min(maxDelay, baseDelay * 2 ** exponent);
  const jitter = exponential * Math.max(0, jitterRatio) * Math.max(0, Math.min(1, random()));
  return Math.min(maxDelay, Math.round(exponential + jitter));
}

function createRecoveryManager({
  connect,
  onReady = () => {},
  onUnavailable = () => {},
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => new Date(),
  random = Math.random,
  baseDelay = 2_000,
  maxDelay = 60_000,
} = {}) {
  if (typeof connect !== "function") throw new TypeError("connect must be a function");
  let timer = null;
  let currentAttempt = null;
  let stopped = true;
  const recovery = {
    state: "starting",
    attempts: 0,
    lastError: "",
    lastErrorAt: "",
    readyAt: "",
    retryAt: "",
  };

  function clearScheduledRetry() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(delay) {
    if (stopped) return;
    clearScheduledRetry();
    recovery.retryAt = new Date(now().getTime() + delay).toISOString();
    timer = setTimer(() => {
      timer = null;
      void attemptConnection();
    }, delay);
  }

  function attemptConnection() {
    if (stopped) return Promise.resolve(false);
    if (currentAttempt) return currentAttempt;
    recovery.state = recovery.attempts ? "recovering" : "starting";
    recovery.retryAt = "";
    currentAttempt = (async () => {
      try {
        const value = await connect();
        recovery.state = "ready";
        recovery.attempts = 0;
        recovery.lastError = "";
        recovery.lastErrorAt = "";
        recovery.readyAt = now().toISOString();
        await onReady(value);
        return true;
      } catch (error) {
        recovery.state = "unavailable";
        recovery.attempts += 1;
        recovery.lastError = safeError(error);
        recovery.lastErrorAt = now().toISOString();
        const delay = boundedRetryDelay(recovery.attempts, { baseDelay, maxDelay, random });
        logger.error?.(`[recovery] connection attempt ${recovery.attempts} failed; retrying in ${delay}ms`);
        await onUnavailable(error);
        schedule(delay);
        return false;
      } finally {
        currentAttempt = null;
      }
    })();
    return currentAttempt;
  }

  function start() {
    stopped = false;
    clearScheduledRetry();
    return attemptConnection();
  }

  function retry() {
    stopped = false;
    clearScheduledRetry();
    return attemptConnection();
  }

  function reportFailure(error) {
    recovery.state = "unavailable";
    recovery.attempts = Math.max(1, recovery.attempts + 1);
    recovery.lastError = safeError(error);
    recovery.lastErrorAt = now().toISOString();
    recovery.readyAt = "";
    void onUnavailable(error);
    schedule(boundedRetryDelay(recovery.attempts, { baseDelay, maxDelay, random }));
  }

  function stop() {
    stopped = true;
    clearScheduledRetry();
    recovery.state = "stopped";
    recovery.retryAt = "";
  }

  function status() {
    return { ...recovery, inFlight: Boolean(currentAttempt), scheduled: timer !== null };
  }

  return { reportFailure, retry, start, status, stop };
}

function safeError(error) {
  return String(error?.message || error || "Connection unavailable").slice(0, 300);
}

module.exports = { boundedRetryDelay, createRecoveryManager };
