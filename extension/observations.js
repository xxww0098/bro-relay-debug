// Presentation is separate from targeting: complete AX names remain available
// for locators even when a repeated container summary is omitted from output.
const containers = new Set([
  "RootWebArea",
  "Iframe",
  "IframePresentational",
  "main",
  "article",
  "region",
  "group",
  "form",
  "dialog",
  "navigation",
  "complementary",
  "banner",
  "contentinfo",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
]);
const whitespace = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export function observationRecords(data, { mode = "snapshot", rootRef } = {}) {
  const byRef = new Map(data.nodes.filter((n) => n.ref).map((n) => [n.ref, n]));
  const children = new Map();
  for (const node of data.nodes) {
    const parent = byRef.has(node.parentRef) ? node.parentRef : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  const roots = rootRef
    ? [byRef.get(rootRef)].filter(Boolean)
    : mode === "read" && data.nodes.some((n) => n.role === "main" && n.frameId === data.frames[0]?.id)
      ? data.nodes.filter((n) => n.role === "main" && n.frameId === data.frames[0]?.id)
      : children.get(null) || [];
  const records = new Map(),
    visited = new Set();
  function visit(node, depth = 0) {
    if (visited.has(node)) return;
    visited.add(node);
    const descendants = children.get(node.ref) || [];
    const redundant = data.redundantRefs.has(node.ref);
    const structural = containers.has(node.role);
    // Article/cell/group accessible names can contain their entire descendants.
    // Emit the actual descendants once, keeping a semantic boundary and ref.
    const repeatedSummary =
      descendants.length &&
      structural &&
      node.name &&
      (whitespace(node.name) === whitespace(descendants.map((child) => child.name || "").join(" ")) ||
        descendants.some((child) => whitespace(child.name) === whitespace(node.name)));
    const name = repeatedSummary ? "" : whitespace(node.name);
    const hasLine =
      !redundant &&
      (name ||
        structural ||
        node.url ||
        [
          "textbox",
          "searchbox",
          "button",
          "checkbox",
          "radio",
          "combobox",
        ].includes(node.role));
    if (hasLine) {
      const attrs = Object.entries(node).filter(
        ([k, v]) =>
          !["ref", "role", "name", "frameId", "parentRef", "within"].includes(
            k,
          ) && v !== undefined,
      );
      const line =
        `${"  ".repeat(Math.min(depth, 24))}[${node.ref || "-"}] ${node.role}${name ? " " + JSON.stringify(name) : ""}` +
        attrs.map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join("") +
        (node.frameId !== data.frames[0]?.id ? ` frame=${node.frameId}` : "");
      records.set(node.ref || `text_${records.size}`, line);
    }
    for (const child of descendants)
      visit(child, depth + (hasLine && structural ? 1 : 0));
  }
  for (const node of roots) visit(node);
  return records;
}

export function textPage(text, offset, maxLength) {
  let end = Math.min(text.length, offset + maxLength);
  // Keep ordinary nodes intact; very long text nodes are explicitly continued.
  if (end < text.length) {
    const newline = text.lastIndexOf("\n", end);
    if (newline > offset) end = newline + 1;
  }
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end])
  )
    end--;
  return {
    snapshot: text.slice(offset, end),
    end,
    truncated: end < text.length,
  };
}
