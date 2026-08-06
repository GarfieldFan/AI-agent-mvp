"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import type { ChatControl } from "@/lib/types";

type ChatControlRendererProps = {
  control: ChatControl;
  onSubmit: (value: string | string[]) => void;
};

/** Renders the structured control the LLM asked for (radio/checkbox/select)
 * below its message, in place of a free-text reply. This is the piece that
 * turns the chatbot's `{ type: "radio" | "checkbox" | "select" | "text" }`
 * JSON responses into an actual form control. */
export function ChatControlRenderer({ control, onSubmit }: ChatControlRendererProps) {
  const [selected, setSelected] = React.useState<string[]>([]);
  const [singleValue, setSingleValue] = React.useState("");

  if (control.type === "text" || !control.options?.length) return null;

  if (control.type === "radio") {
    return (
      <div className="flex flex-wrap gap-2 pt-2">
        {control.options.map((option) => (
          <Button
            key={option.value}
            variant="outline"
            size="sm"
            onClick={() => onSubmit(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    );
  }

  if (control.type === "select") {
    return (
      <div className="flex items-center gap-2 pt-2">
        <Select value={singleValue} onValueChange={(value) => setSingleValue(value ?? "")}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder={control.label ?? "Choose…"} />
          </SelectTrigger>
          <SelectContent>
            {control.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" disabled={!singleValue} onClick={() => onSubmit(singleValue)}>
          Confirm
        </Button>
      </div>
    );
  }

  // checkbox — multi-select
  function toggle(value: string) {
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  return (
    <div className="space-y-2 pt-2">
      <div className="flex flex-wrap gap-2">
        {control.options!.map((option) => {
          const isChecked = selected.includes(option.value);
          return (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors",
                isChecked ? "border-primary bg-primary/5" : "hover:bg-muted",
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={isChecked}
                onChange={() => toggle(option.value)}
              />
              {option.label}
            </label>
          );
        })}
      </div>
      <Button size="sm" disabled={selected.length === 0} onClick={() => onSubmit(selected)}>
        Submit
      </Button>
    </div>
  );
}
