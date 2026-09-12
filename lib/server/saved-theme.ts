/** The owner's saved theme, read from the workspace they last saved.
 *
 * A fallback for the first paint when the theme cookie is not there yet. The
 * cookie is written in the browser by the workspace provider, so an owner who
 * signs in and stays on the chat surface never writes one — and would see the
 * wrong colour until they opened the workspace once.
 *
 * Deliberately quiet: a page that cannot read a preference should render in the
 * default colour, not fail. Every path returns 'light' rather than throwing.
 */
import { isTheme, type Theme } from '../theme.ts';

export async function savedTheme(): Promise<Theme> {
  try {
    const { identity, database } = await import('../kernel/server.ts');
    const user = await identity();
    const row = (await database()
      .prepare('SELECT body FROM workspace_states WHERE user_id = ?')
      .bind(user.userId)
      .first()) as { body?: string } | null;
    if (!row?.body) return 'light';
    // Read the one field rather than parsing the whole envelope: this runs on
    // every request that arrives without the cookie, and the envelope can be
    // megabytes.
    const theme = (JSON.parse(row.body) as { preferences?: { theme?: unknown } })?.preferences
      ?.theme;
    return isTheme(theme) ? theme : 'light';
  } catch {
    // Signed out, no row, unreadable JSON, or no database yet.
    return 'light';
  }
}
