import type { ReactNode } from "react";
import { BootArrival } from "@/components/layout/boot";

/**
 * Wraps a page that has a loading fallback (`RouteLoading`) so a hard load
 * keeps the boot screen up until this page has hydrated. Every return path
 * of the page carries the marker, denials included.
 */
export function withBootArrival<P>(page: (props: P) => Promise<ReactNode>) {
  return async function ArrivingPage(props: P) {
    const content = await page(props);
    return (
      <>
        <BootArrival />
        {content}
      </>
    );
  };
}
