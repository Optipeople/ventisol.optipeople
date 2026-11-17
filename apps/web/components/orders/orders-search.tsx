"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, SearchField, Spinner } from "@optipeople/ui";

/**
 * The order search, kept in the URL as `q`. Typing waits a moment before
 * the page is asked again; Enter asks at once. A new search starts on page 1,
 * so the pager's `page` is not carried along.
 */
export function OrdersSearch({
  value,
  basePath,
  preserve,
}: {
  value: string;
  basePath: string;
  /** The other params to keep: tab, filters, sort. */
  preserve: Record<string, string>;
}) {
  const router = useRouter();
  const [text, setText] = useState(value);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the URL when it changes from elsewhere (back button, tab switch).
  // Our own search coming back is left alone: the user may have typed on.
  const [seen, setSeen] = useState(value);
  const [sent, setSent] = useState(value);
  if (seen !== value) {
    setSeen(value);
    if (value !== sent) setText(value);
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function go(next: string) {
    if (timer.current) clearTimeout(timer.current);
    const qs = new URLSearchParams(preserve);
    const trimmed = next.trim();
    setSent(trimmed);
    if (trimmed) qs.set("q", trimmed);
    else qs.delete("q");
    startTransition(() => router.replace(qs.size ? `${basePath}?${qs}` : basePath, { scroll: false }));
  }

  function change(next: string) {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go(next), 350);
  }

  return (
    <form
      role="search"
      className="flex w-[300px] max-w-full items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        go(text);
      }}
    >
      <Field label="Søg" htmlFor="orders-search">
        <SearchField
          id="orders-search"
          size="medium"
          className="h-[36px] min-w-0"
          value={text}
          placeholder="Ordrenummer, kunde eller sag"
          onChange={(e) => change(e.target.value)}
          onClear={() => {
            setText("");
            go("");
          }}
          maxLength={200}
          autoComplete="off"
        />
      </Field>
      <span className="flex h-[36px] w-4 shrink-0 items-center" aria-live="polite">
        {pending ? <Spinner className="h-4 w-4" aria-label="Søger" /> : null}
      </span>
    </form>
  );
}
