// Merging the feedback list a tab holds with the one another tab of the same
// page saved (#139). Each tab writes its whole list, so a tab used to overwrite
// the comments another tab had added or changed since it loaded.
//
// stored: the list now in storage. known: a Map of the comments in storage
// when this tab last read or wrote it, id to fingerprints. It tells a comment
// deleted in another tab (known, no longer stored) from one this tab has not
// saved yet (not known), and what of a comment this tab changed since.
// prefer: "ours" when this tab saves: of a comment both hold, the parts this
// tab changed (the comment itself, its delivery state, its export marks) keep
// this tab's version, the others take the stored one, so the last change saved
// wins part by part. "stored" when another tab has saved: its version wins.
// keepDelivery: ids this tab is delivering, whose delivery state stays ours.
// Returns the merged list, the comments added by another tab and the ids
// deleted by one. A comment kept from this tab stays the same object, so a
// delivery in flight still updates the listed comment.
export function mergeFeedbackLists(ours, stored, known, { prefer, keepDelivery = new Set() }) {
  const storedById = new Map(stored.map((item) => [item.id, item]));
  const ourIds = new Set(ours.map((item) => item.id));
  const removed = [];
  const kept = new Map();
  ours.forEach((item) => {
    const other = storedById.get(item.id);
    if (other) kept.set(item.id, reconcile(item, other, changedParts(item, known.get(item.id), prefer), keepDelivery.has(item.id)));
    // Deleted in another tab: the deletion wins over this tab's copy.
    else if (known.has(item.id)) removed.push(item.id);
    // Not saved yet (just added here, or a save that failed).
    else kept.set(item.id, item);
  });
  // Neither here nor known: added in another tab. Known but gone from here:
  // this tab deleted it.
  const added = stored.filter((item) => !ourIds.has(item.id) && !known.has(item.id));

  let list;
  if (prefer === "stored") {
    list = stored.filter((item) => kept.has(item.id) || added.includes(item)).map((item) => kept.get(item.id) || item);
    ours.filter((item) => kept.has(item.id) && !storedById.has(item.id)).forEach((item) => insertByDate(list, item));
  } else {
    list = ours.filter((item) => kept.has(item.id));
    added.forEach((item) => insertByDate(list, item));
  }
  return { list, added, removed };
}

const MARK_KEYS = ["exported", "exportedAt", "exportedFileName"];
const PART_KEYS = new Set(["delivery", ...MARK_KEYS]);
// Left out of the fingerprints: the image data does not change, and a save
// that did not fit the storage drops it while the tab still holds it.
const UNCOMPARED_KEYS = new Set(["dataUrl", "persistedWithoutDataUrl"]);

// What a save would write of a comment, part by part, in a fixed key order:
// the comment itself, its delivery state and its export marks.
export function feedbackFingerprints(item) {
  const content = {};
  Object.keys(item).forEach((key) => {
    if (!PART_KEYS.has(key)) content[key] = item[key];
  });
  return {
    content: JSON.stringify(canonical(content)),
    delivery: JSON.stringify(canonical(item.delivery ?? null)),
    marks: JSON.stringify(MARK_KEYS.map((key) => item[key] ?? null))
  };
}

function changedParts(item, known, prefer) {
  if (prefer === "stored") return { content: false, delivery: false, marks: false };
  // Not known while stored: both sides hold an id this tab never read; keep it.
  if (!known) return { content: true, delivery: true, marks: true };
  const now = feedbackFingerprints(item);
  return { content: now.content !== known.content, delivery: now.delivery !== known.delivery, marks: now.marks !== known.marks };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const copy = {};
  Object.keys(value).sort().forEach((key) => {
    if (!UNCOMPARED_KEYS.has(key)) copy[key] = canonical(value[key]);
  });
  return copy;
}

// Writes the merged version into ours, in place. Export marks tell that a text
// was exported, so they stay only on the same text: preferably the marks of
// the side whose marks won, else those of the other side (an export in another
// tab marks comments this tab may save again before it hears of it).
function reconcile(ours, other, changed, keepOwnDelivery) {
  const merged = changed.content ? { ...ours } : { ...other };
  // A save that did not fit the storage drops the image data; this tab may
  // still hold it.
  if (!changed.content && other.screenshot?.persistedWithoutDataUrl && ours.screenshot?.dataUrl) merged.screenshot = ours.screenshot;
  PART_KEYS.forEach((key) => delete merged[key]);
  const delivery = keepOwnDelivery || changed.delivery ? ours.delivery : other.delivery;
  if (delivery !== undefined) merged.delivery = delivery;
  const marked = (changed.marks ? [ours, other] : [other, ours])
    .find((side) => side.exported && side.comment === merged.comment && side.reviewer === merged.reviewer);
  if (marked) MARK_KEYS.forEach((key) => {
    if (marked[key] !== undefined) merged[key] = marked[key];
  });
  Object.keys(ours).forEach((key) => {
    if (!Object.hasOwn(merged, key)) delete ours[key];
  });
  return Object.assign(ours, merged);
}

// Newest first, as the list is kept: before the first comment made earlier,
// or last when the dates cannot tell.
function insertByDate(list, item) {
  const index = typeof item.createdAt === "string"
    ? list.findIndex((other) => typeof other.createdAt === "string" && other.createdAt < item.createdAt)
    : -1;
  if (index === -1) list.push(item);
  else list.splice(index, 0, item);
}
