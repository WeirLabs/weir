// Notification merge tags: the one place that decides which notifications
// replace each other. Pure.
//
// The web `Notification` API treats a repeated `tag` as "the same thing":
// the new one REPLACES a notification that is still showing, and by default
// does not alert again — which made back-to-back notifications look like they
// never fired. The policy (docs/features/notify.md, design D5):
//
//   same top-level session + same type  -> same tag, re-alert on replace
//   different session                   -> different tag (never hides another session's ask)
//   same session, different type        -> different tag (an approval must not hide a "finished")

/**
 * @param {unknown} sessionId - the TOP-LEVEL session id the user sees
 * @param {string} type - the note type (approval, question, plan, completed, failed, stopped, test)
 * @returns {string}
 */
export function tagFor(sessionId, type) {
  // Session ids are opaque; keep the tag printable and bounded without
  // changing distinct ids into the same string.
  const id = String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
  return `orrery:${id}:${type}`
}

/** Same-tag replacement always alerts again, so a merged repeat is never silent. */
export const RENOTIFY = true
