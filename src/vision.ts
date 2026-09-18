// Image-attachment gating and context formatting — pure functions, no client or
// store dependencies (same test posture as perception.ts). The only code that
// ever touches image bytes/URLs is Brain.describeImage; everything here
// operates on attachment metadata.

export const IMAGE_MAX_PER_MESSAGE = 3;

export type AttachmentMeta = { url: string; contentType?: string | null; size: number; name?: string };

/** Keep image attachments worth a vision call: image/* minus animated GIFs
 * (single-frame descriptions of GIFs mislead more than they inform), under the
 * byte cap (provider-side limits reject oversized images anyway), at most
 * maxCount by position — a ten-image dump must not fan out ten vision calls. */
export function qualifyingImages(
  attachments: Iterable<AttachmentMeta>,
  maxBytes: number,
  maxCount = IMAGE_MAX_PER_MESSAGE
): Array<AttachmentMeta & { contentType: string }> {
  const out: Array<AttachmentMeta & { contentType: string }> = [];
  for (const a of attachments) {
    if (out.length >= maxCount) break;
    if (!a.contentType?.startsWith("image/") || a.contentType === "image/gif") continue;
    if (a.size > maxBytes) continue;
    out.push({ ...a, contentType: a.contentType });
  }
  return out;
}

/** Frame a description as the bot's own observation of an attachment — not
 * text the author wrote. This steers extraction toward
 * direct_observation/uncertain_inference and keeps the reply model from
 * reciting depicted content as the author's claims. */
export function formatImageContext(descriptions: string[], authorName: string): string {
  if (!descriptions.length) return "";
  const lines = descriptions.map(d => `"${d}"`).join("; ");
  return `${authorName} attached image${descriptions.length > 1 ? "s" : ""} — content observed by the bot: ${lines}`;
}
