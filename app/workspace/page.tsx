import { redirect } from 'next/navigation';

/**
 * The old workspace shell is gone — its hash-routed screens are real routes
 * now. This address stays working for bookmarks and lands on the chat, the
 * product's front door; auth happens there.
 */
export default function WorkspacePage() {
  redirect('/chat');
}
