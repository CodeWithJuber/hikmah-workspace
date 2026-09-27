import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /chat/[id] — mirrors the chat shell: top bar, a few
 *  message bubbles and the composer bar. */
export default function ChatLoading() {
  return (
    <div className="chat-shell workspace-experience">
      <header className="chat-topbar workspace-header">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="ml-auto size-9 rounded-md" />
      </header>
      <main className="chat-body workspace-body">
        <section className="workspace-chat-pane" aria-label="Loading conversation" role="status">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
            <div className="flex flex-col items-end gap-2">
              <Skeleton className="h-10 w-2/3 rounded-2xl rounded-br-md" />
              <Skeleton className="h-4 w-1/3" />
            </div>
            <div className="flex flex-col items-start gap-2">
              <Skeleton className="h-4 w-full max-w-md" />
              <Skeleton className="h-4 w-11/12 max-w-md" />
              <Skeleton className="h-4 w-4/5 max-w-md" />
            </div>
            <div className="flex flex-col items-end gap-2">
              <Skeleton className="h-10 w-1/2 rounded-2xl rounded-br-md" />
            </div>
            <div className="flex flex-col items-start gap-2">
              <Skeleton className="h-4 w-full max-w-md" />
              <Skeleton className="h-4 w-3/5 max-w-md" />
            </div>
          </div>
        </section>
      </main>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <Skeleton className="h-14 w-full rounded-2xl" />
      </div>
    </div>
  );
}
