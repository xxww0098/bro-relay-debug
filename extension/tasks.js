// Shared by the extension and tests. A queue owns a whole operation, not one
// mouse event, so independently submitted scripts cannot interleave keystrokes.
export class TaskError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function checkCancelled(signal) {
  if (signal?.aborted)
    throw new TaskError(
      "task_cancelled",
      "Task cancelled; completed actions were not undone",
      409,
    );
}
export function pause(ms, signal) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new TaskError("task_cancelled", "Task cancelled", 409));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export function createTaskQueue({ limit = 100 } = {}) {
  const tails = new Map(),
    jobs = new Map(),
    cancelledRequests = new Map();
  const publicJob = (job) => ({
    id: job.id,
    tabId: job.tabId,
    sessionId: job.sessionId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    results: job.results,
    completedActions: job.results.length,
    observation: job.observation,
    error: job.error,
    interruptedAction:
      job.finishedAt && job.currentAction ? job.currentAction : undefined,
  });
  function get(id) {
    const job = jobs.get(id);
    if (!job && cancelledRequests.has(id)) return cancelledRequests.get(id);
    if (!job)
      throw new TaskError(
        "task_not_found",
        "Task not found (the extension may have restarted)",
        404,
      );
    return publicJob(job);
  }
  function start(tabId, run, timeoutMs = 20000, requestedId, sessionId) {
    for (const [id, job] of jobs) {
      if (jobs.size < limit) break;
      if (job.finishedAt) jobs.delete(id);
    }
    if (jobs.size >= limit)
      throw new TaskError("task_limit", "Too many pending tasks", 429);
    const id = requestedId || `job_${crypto.randomUUID()}`;
    if (!/^job_[\w-]{36}$/.test(id))
      throw new TaskError("invalid_task_id", "Invalid task id");
    if (cancelledRequests.has(id))
      throw new TaskError(
        "task_cancelled",
        "This request was cancelled before execution",
        409,
      );
    if (jobs.has(id))
      throw new TaskError(
        "duplicate_task",
        "Task id already exists; inspect its result instead of replaying actions",
        409,
      );
    const job = {
      id,
      tabId,
      sessionId,
      status: "queued",
      createdAt: Date.now(),
      results: [],
      controller: new AbortController(),
    };
    jobs.set(id, job);
    const previous = tails.get(tabId) || Promise.resolve();
    const done = previous
      .catch(() => {})
      .then(async () => {
        let timer;
        try {
          checkCancelled(job.controller.signal);
          job.status = "running";
          job.startedAt = Date.now();
          timer = setTimeout(() => {
            job.timedOut = true;
            job.controller.abort();
          }, timeoutMs);
          const observation = await run(job, job.controller.signal);
          checkCancelled(job.controller.signal);
          job.observation = observation;
          job.status = "completed";
        } catch (error) {
          job.status = job.controller.signal.aborted ? "cancelled" : "failed";
          job.error = {
            code: job.timedOut
              ? "task_timeout"
              : job.cancelReason || error.code || "action_failed",
            message: error.message,
            status: error.status || 500,
          };
        } finally {
          clearTimeout(timer);
          job.finishedAt = Date.now();
        }
        return publicJob(job);
      });
    tails.set(tabId, done);
    done.finally(() => {
      if (tails.get(tabId) === done) tails.delete(tabId);
    });
    return { id, done };
  }
  function cancel(id, reason = "task_cancelled", sessionId) {
    if (!jobs.has(id)) {
      if (!/^job_[\w-]{36}$/.test(id))
        throw new TaskError("invalid_task_id", "Invalid task id");
      const result = {
        id,
        sessionId,
        status: "cancelled",
        results: [],
        error: {
          code: reason,
          message: "Request cancelled before execution",
          status: 409,
        },
        cancellationRequested: true,
      };
      cancelledRequests.set(id, result);
      if (cancelledRequests.size > 500)
        cancelledRequests.delete(cancelledRequests.keys().next().value);
      return result;
    }
    get(id);
    const job = jobs.get(id);
    if (!job.finishedAt) {
      job.cancelReason = reason;
      job.controller.abort();
    }
    return { ...publicJob(job), cancellationRequested: !job.finishedAt };
  }
  function cancelTab(tabId, reason = "task_cancelled") {
    for (const job of jobs.values())
      if (job.tabId === tabId && !job.finishedAt) cancel(job.id, reason);
  }
  function cancelSession(sessionId, reason = "session_stopped") {
    for (const job of jobs.values())
      if (job.sessionId === sessionId && !job.finishedAt)
        cancel(job.id, reason);
  }
  const active = () =>
    [...jobs.values()]
      .filter((j) => !j.finishedAt)
      .map((j) => ({
        id: j.id,
        tabId: j.tabId,
        sessionId: j.sessionId,
        status: j.status,
        completedActions: j.results.length,
      }));
  const cancelAll = () => {
    const pending = active();
    for (const job of pending) cancel(job.id);
    return pending.length;
  };
  return { start, get, cancel, cancelTab, cancelSession, active, cancelAll };
}
