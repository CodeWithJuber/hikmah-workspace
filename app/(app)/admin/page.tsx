import { redirect } from 'next/navigation';

/** The old address for what is now Settings. Kept as a redirect so bookmarks
 * survive the rename; the name "Admin" promised a console that never existed. */
export default function AdminPage() {
  redirect('/settings/overview');
}
