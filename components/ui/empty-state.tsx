import * as React from "react"

import { cn } from "@/lib/utils"

/** An empty state that never dead-ends: a plain-language message, a clear
 * next step, and room for both.
 *
 * Pass `action` with the one thing the user should do next (a button or a
 * link) — an EmptyState without an action is a wall, not a state. The icon
 * mark is decorative; the title carries the meaning. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className
      )}
    >
      {icon ? (
        <span className="mb-1 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border [&_svg]:size-5">
          {icon}
        </span>
      ) : null}
      <p className="text-base font-semibold tracking-tight text-foreground">
        {title}
      </p>
      {description ? (
        <div className="max-w-sm text-sm leading-relaxed text-muted-foreground">
          {description}
        </div>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}
