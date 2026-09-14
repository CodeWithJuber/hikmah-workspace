/** The address the legal pages tell people to write to.
 *
 * Separate from the page that prints it because it is a deployment setting,
 * not markup: the operator's own address, and never one this code made up. A
 * privacy policy with no way to reach anybody is the part an audit calls out.
 */
export function contactAddress(): string {
  const named = process.env.HIKMAH_CONTACT_EMAIL;
  return typeof named === 'string' && named.includes('@') ? named.trim() : '';
}
