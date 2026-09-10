// Map page CSS pixels onto the letterboxed screenshot in the preview frame.
export function displayedImageBox(img) {
  const r = img.getBoundingClientRect();
  const nw = Number(img.naturalWidth), nh = Number(img.naturalHeight);
  if (!nw || !nh || !r.width || !r.height) return { x: r.x, y: r.y, width: r.width, height: r.height };
  const scale = Math.min(r.width / nw, r.height / nh);
  const width = nw * scale, height = nh * scale;
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
}

export function mapPointerToFrame(pointer, viewport, frame) {
  if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return null;
  if (!viewport?.width || !viewport?.height || !frame?.width || !frame?.height) return null;
  const scale = Math.min(frame.width / viewport.width, frame.height / viewport.height);
  const x0 = frame.x + (frame.width - viewport.width * scale) / 2;
  const y0 = frame.y + (frame.height - viewport.height * scale) / 2;
  const rect = pointer.rect && Number.isFinite(pointer.rect.width) ? {
    x: x0 + pointer.rect.x * scale,
    y: y0 + pointer.rect.y * scale,
    width: Math.max(0, pointer.rect.width * scale),
    height: Math.max(0, pointer.rect.height * scale),
  } : null;
  return { x: x0 + pointer.x * scale, y: y0 + pointer.y * scale, scale, rect, label: pointer.label || '', kind: pointer.kind || 'move' };
}
