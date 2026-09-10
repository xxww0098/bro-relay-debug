import { TaskError } from "./tasks.js";

// Leases coordinate trusted clients sharing Chrome. They are not an access
// control sandbox against another local debugger or the user themselves.
export function createSessions({
  now = Date.now,
  ttlMs = 120000,
  cancelTab = () => {},
  cancelSession = () => {},
  active = () => [],
} = {}) {
  const sessions = new Map(),
    claims = new Map(),
    stopped = new Map();
  const valid = (id) => {
    if (typeof id !== "string" || !/^[\w.-]{1,128}$/.test(id))
      throw new TaskError(
        "invalid_session",
        "Use a sessionId with 1–128 letters, digits, dots, dashes or underscores",
      );
    return id;
  };
  const publicClaim = (claim) => claim && { ...claim };
  function stop(id, reason = "session_stopped") {
    valid(id);
    cancelSession(id, reason);
    const released = [];
    for (const [tabId, claim] of claims)
      if (claim.sessionId === id) {
        cancelTab(tabId, reason);
        released.push(publicClaim(claim));
        claims.delete(tabId);
      }
    sessions.delete(id);
    stopped.set(id, reason);
    if (stopped.size > 500) stopped.delete(stopped.keys().next().value);
    return released;
  }
  function sweep() {
    for (const [id, session] of sessions)
      if (session.expiresAt <= now()) stop(id, "session_expired");
  }
  function touch(id) {
    valid(id);
    sweep();
    if (stopped.has(id))
      throw new TaskError(
        stopped.get(id),
        "Session ended; start a new session explicitly",
        409,
      );
    if (!sessions.has(id) && sessions.size >= 100)
      throw new TaskError("session_limit", "Too many active sessions", 429);
    const session = { sessionId: id, expiresAt: now() + ttlMs };
    sessions.set(id, session);
    return session;
  }
  function check(tabId, id) {
    sweep();
    const claim = claims.get(tabId);
    if (claim && claim.sessionId !== id)
      throw new TaskError(
        "tab_claimed",
        `Tab is owned by session ${claim.sessionId}; request a handoff or wait for release`,
        409,
      );
    if (id) touch(id);
    return claim;
  }
  function claim(tabId, id, { created = false, label = "" } = {}) {
    valid(id);
    check(tabId, id);
    if (!claims.has(tabId))
      claims.set(tabId, {
        tabId,
        sessionId: id,
        created,
        label: String(label).slice(0, 100),
        claimedAt: now(),
      });
    if (label) claims.get(tabId).label = String(label).slice(0, 100);
    return {
      ...publicClaim(claims.get(tabId)),
      expiresAt: sessions.get(id).expiresAt,
    };
  }
  function release(tabId, id) {
    check(tabId, id);
    if (active().some((job) => job.tabId === tabId))
      throw new TaskError(
        "tab_busy",
        "Cancel and await pending tasks before releasing this tab",
        409,
      );
    const result = publicClaim(claims.get(tabId));
    claims.delete(tabId);
    return result;
  }
  function handoff(tabId, id, toSessionId) {
    valid(toSessionId);
    check(tabId, id);
    if (!claims.has(tabId))
      throw new TaskError(
        "tab_unclaimed",
        "Claim the tab before handing it off",
        409,
      );
    // Validate the receiver before releasing the owner.
    touch(toSessionId);
    const previous = release(tabId, id);
    return claim(tabId, toSessionId, previous);
  }
  return {
    claim,
    check,
    release,
    handoff,
    touch,
    stop,
    sweep,
    forget: (tabId) => claims.delete(tabId),
    list: () => {
      sweep();
      return [...claims.values()].map((c) => ({
        ...c,
        expiresAt: sessions.get(c.sessionId)?.expiresAt,
      }));
    },
    stopAll: (reason) => {
      for (const id of [...sessions.keys()]) stop(id, reason);
    },
  };
}
