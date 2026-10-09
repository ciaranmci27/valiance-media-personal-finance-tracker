import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Any API address with no route of its own: a JSON 404 in the API's envelope,
 * never the page fallback (which redirects home). An agent or script calling a
 * wrong or retired endpoint must read "not found", not a page.
 */
function notFound() {
  return NextResponse.json(
    {
      success: false,
      error: { code: "not_found", message: "No API endpoint at this address" },
    },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
