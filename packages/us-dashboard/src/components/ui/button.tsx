import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva("us-button", {
  variants: {
    variant: {
      default: "us-button-default",
      secondary: "us-button-secondary",
      ghost: "us-button-ghost",
      laser: "us-button-laser",
    },
    size: {
      sm: "us-button-sm",
      md: "us-button-md",
      icon: "us-button-icon",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "md",
  },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
