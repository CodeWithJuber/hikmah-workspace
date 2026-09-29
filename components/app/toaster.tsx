'use client';
import { Toaster } from 'sonner';

/** The single toast host for the whole app. It lives in the root layout, not
 * in any shell, so surfaces never mount a second one.
 *
 * The look is ours (`.hikmah-toast` in app/styles/workspace.css): popover
 * surface, neutral border, level-2 shadow. Sonner's own slide/fade does the
 * motion. */
export function ToasterOnce() {
  return (
    <Toaster
      position="top-center"
      gap={8}
      toastOptions={{
        classNames: {
          toast: 'hikmah-toast',
          title: 'hikmah-toast-title',
          description: 'hikmah-toast-description',
          actionButton: 'hikmah-toast-action',
          cancelButton: 'hikmah-toast-cancel',
        },
      }}
    />
  );
}
