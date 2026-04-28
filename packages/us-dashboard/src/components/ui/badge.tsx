import * as React from "react";
import { cn } from "../../lib/utils";

type BadgeTone = "default" | "laser" | "success" | "warning" | "muted";

export function Badge({
  className,
  tone = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cn("us-badge", `us-badge-${tone}`, className)} {...props} />;
}
