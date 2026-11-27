// A player's chosen name, as the page keeps it and the host passes it on: both clean it the same way, the host
// because a page of other code may send anything.

/** the most characters a name keeps (it is drawn over an avatar and beside a dot on the map) */
export const NAME_MAX = 16;

/** name as shown: control, format and bidi characters gone (they reorder or hide what others read), whitespace
 * runs one space, trimmed, at most NAME_MAX characters; '' for none or anything not a string */
export function cleanName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const s = name.slice(0, 200).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/gu, ' ').trim();
  return [...s].slice(0, NAME_MAX).join('').trim();
}
