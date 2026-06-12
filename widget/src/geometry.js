// Pure coordinate math for the widget. DOM state is injected as a `metrics`
// snapshot (see viewportMetrics() in index.js) so these functions stay
// testable under node:test:
//   { scrollX, scrollY, viewportWidth, viewportHeight,
//     documentWidth, documentHeight, windowWidth, windowHeight }

export function round(value) {
  return Math.round(value * 10) / 10;
}

export function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function pointFromClient(clientX, clientY, metrics) {
  const pageX = clientX + metrics.scrollX;
  const pageY = clientY + metrics.scrollY;
  return {
    x: (clientX / Math.max(metrics.viewportWidth, 1)) * 100,
    y: (clientY / Math.max(metrics.viewportHeight, 1)) * 100,
    documentX: (pageX / Math.max(metrics.documentWidth, 1)) * 100,
    documentY: (pageY / Math.max(metrics.documentHeight, 1)) * 100,
    clientX,
    clientY,
    pageX,
    pageY
  };
}

export function rectFromPoints(start, end, metrics) {
  const leftPx = Math.min(start.clientX, end.clientX);
  const topPx = Math.min(start.clientY, end.clientY);
  const rightPx = Math.max(start.clientX, end.clientX);
  const bottomPx = Math.max(start.clientY, end.clientY);
  const viewportWidth = Math.max(metrics.viewportWidth, 1);
  const viewportHeight = Math.max(metrics.viewportHeight, 1);
  const pageLeftPx = leftPx + metrics.scrollX;
  const pageTopPx = topPx + metrics.scrollY;
  const documentWidth = Math.max(metrics.documentWidth, 1);
  const documentHeight = Math.max(metrics.documentHeight, 1);

  return {
    leftPx,
    topPx,
    rightPx,
    bottomPx,
    pageLeftPx,
    pageTopPx,
    widthPx: rightPx - leftPx,
    heightPx: bottomPx - topPx,
    x: (leftPx / viewportWidth) * 100,
    y: (topPx / viewportHeight) * 100,
    width: ((rightPx - leftPx) / viewportWidth) * 100,
    height: ((bottomPx - topPx) / viewportHeight) * 100,
    documentX: (pageLeftPx / documentWidth) * 100,
    documentY: (pageTopPx / documentHeight) * 100,
    documentWidth: ((rightPx - leftPx) / documentWidth) * 100,
    documentHeight: ((bottomPx - topPx) / documentHeight) * 100
  };
}

export function rectContainsArea(elementRect, rect) {
  return elementRect.left <= rect.leftPx + 1
    && elementRect.top <= rect.topPx + 1
    && elementRect.right >= rect.rightPx - 1
    && elementRect.bottom >= rect.bottomPx - 1;
}

export function documentPercentToPxX(value, metrics) {
  const percent = numberOrNull(value);
  if (percent == null) return null;
  return (percent / 100) * Math.max(metrics.documentWidth, metrics.windowWidth, 1);
}

export function documentPercentToPxY(value, metrics) {
  const percent = numberOrNull(value);
  if (percent == null) return null;
  return (percent / 100) * Math.max(metrics.documentHeight, metrics.windowHeight, 1);
}

// Restore prefers stored document pixels over document-size percentages:
// the document height can differ between save and reload (dynamic content),
// which shifts every percentage-resolved position. Percentages remain as a
// fallback for stored feedback that lacks pixel values.
export function pointFromStoredTarget(target, metrics) {
  const pageX = numberOrNull(target.pageX) ?? documentPercentToPxX(target.documentX, metrics);
  const pageY = numberOrNull(target.pageY) ?? documentPercentToPxY(target.documentY, metrics);
  if (pageX == null || pageY == null) return null;
  return { pageX, pageY };
}

export function rectFromStoredArea(area, metrics) {
  const pageLeftPx = numberOrNull(area.pageX) ?? documentPercentToPxX(area.documentX, metrics);
  const pageTopPx = numberOrNull(area.pageY) ?? documentPercentToPxY(area.documentY, metrics);
  const widthPx = numberOrNull(area.clientWidth) ?? documentPercentToPxX(area.documentWidth, metrics);
  const heightPx = numberOrNull(area.clientHeight) ?? documentPercentToPxY(area.documentHeight, metrics);

  if (pageLeftPx == null || pageTopPx == null || widthPx == null || heightPx == null) return null;
  return {
    pageLeftPx,
    pageTopPx,
    widthPx: Math.max(1, widthPx),
    heightPx: Math.max(1, heightPx)
  };
}
