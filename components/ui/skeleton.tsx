import { cn } from "@/lib/utils"

/** A loading placeholder that reserves the space its content will take.
 *
 * The shimmer is `.skeleton-shimmer` (app/styles/workspace.css): a slow,
 * subtle light sweep over the neutral fill, disabled under
 * prefers-reduced-motion. `bg-accent` stays underneath as the static fill
 * when the animation is off. Pair with fixed heights (h-6, h-28, …) so the
 * layout never shifts when the real content arrives. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-md bg-accent skeleton-shimmer", className)}
      {...props}
    />
  )
}

export { Skeleton }
