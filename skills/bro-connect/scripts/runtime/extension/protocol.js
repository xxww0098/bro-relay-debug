export const PROTOCOL_VERSION = 2;
export const isTaskRequest = (method, path) =>
  ["/api/read", "/api/observe"].includes(path) ||
  (method === "POST" && ["/api/actions", "/api/evaluate", "/api/tabs/focus"].includes(path));
export const FEATURES = [
  "observe",
  "read",
  "ax",
  "refs",
  "frames",
  "shadow-dom",
  "diff",
  "actions",
  "tasks",
  "coordinates",
  "drag",
  "hover",
  "screenshot-mapping",
  "scoped-targets",
  "action-readiness-wait",
  "aria-check",
  "tabs",
  "observation-pages",
  "full-links",
  "sessions",
  "handoff",
  "focus",
];
export const isAutomationPath = (path) =>
  [
    "/api/observe",
    "/api/read",
    "/api/actions",
    "/api/capabilities",
    "/api/sessions",
    "/api/session/check",
    "/api/evaluate",
    "/api/tabs/create",
    "/api/tabs/close",
    "/api/tabs/focus",
    "/api/tabs/claim",
    "/api/tabs/release",
    "/api/tabs/handoff",
    "/api/release",
  ].includes(path) || path.startsWith("/api/tasks/");
