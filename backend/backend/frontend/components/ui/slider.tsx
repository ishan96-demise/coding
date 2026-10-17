"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";
import * as React from "react";

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>;

export const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
  ({ className = "", ...props }, ref) => (
    <SliderPrimitive.Root
      ref={ref}
      className={`relative flex h-5 w-full touch-none select-none items-center ${className}`}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-white/10">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-cyan-500" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-cyan-100/70 bg-[#07131c] shadow-[0_0_12px_rgba(6,182,212,.36)] outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#080b11] disabled:pointer-events-none disabled:opacity-50" />
    </SliderPrimitive.Root>
  ),
);

Slider.displayName = "Slider";
