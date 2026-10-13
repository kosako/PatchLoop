// Merging the feedback list a tab holds with the one another tab of the same
// page saved (#139). Each tab writes its whole list, so a tab used to overwrite
// the comments another tab had added or changed since it loaded.
//
// stored: the list now in storage. known: a Map of the comments in storage
// when this tab last read or wrote it, id to fingerprint. It tells a comment
// deleted in another tab (known, no longer stored) from one this tab has not
// saved yet (not known), and a comment this tab changed since (its fingerprint
// differs) from one it only holds a copy of.
// prefer: "ours" when this tab saves: its version of a comment it changed
// wins (the last change saved wins), and another tab's version of one it did
// not change is taken in. "stored" when another tab has saved: its versions win.
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
    if (other) {
      const oursWins = prefer === "ours" && known.get(item.id) !== feedbackFingerprint(item);
      kept.set(item.id, reconcile(item, other, oursWins, keepDelivery.has(item.id)));
    }
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

// What a save would write of a comment, in a fixed key order. The image data is
// left out: it does not change, and a save that did not fit the storage drops
// it (persistedWithoutDataUrl) while the tab still holds it.
export function feedbackFingerprint(item) {
  return JSON.stringify(canonical(item));
}

const UNCOMPARED_KEYS = new Set(["dataUrl", "persistedWithoutDataUrl"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const copy = {};
  Object.keys(value).sort().forEach((key) => {
    if (!UNCOMPARED_KEYS.has(key)) copy[key] = canonical(value[key]);
  });
  return copy;
}

// Applies the winning version to ours in place. The export marks survive when
// either side has them and the comment is the same, as an export in another
// tab marks comments this tab may save again before it hears of it.
function reconcile(ours, other, oursWins, keepOwnDelivery) {
  const sameComment = ours.comment === other.comment && ours.reviewer === other.reviewer;
  const marked = sameComment ? [ours, other].find((item) => item.exported) : undefined;
  const marks = marked && { exported: marked.exported, exportedAt: marked.exportedAt, exportedFileName: marked.exportedFileName };
  if (!oursWins) {
    const delivery = ours.delivery;
    const screenshot = other.screenshot?.persistedWithoutDataUrl && ours.screenshot?.dataUrl ? ours.screenshot : undefined;
    Object.keys(ours).forEach((key) => {
      if (!Object.hasOwn(other, key)) delete ours[key];
    });
    Object.assign(ours, other);
    if (keepOwnDelivery) {
      if (delivery === undefined) delete ours.delivery;
      else ours.delivery = delivery;
    }
    if (screenshot) ours.screenshot = screenshot;
  }
  if (marks) Object.assign(ours, marks);
  return ours;
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
