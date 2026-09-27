'use client';
import { Toaster } from 'sonner';

/** The single toast host for the whole app. It lives in the root layout, not
 * in any shell, so surfaces never mount a second one. */
export function ToasterOnce() {
  return <Toaster position="top-center" />;
}
