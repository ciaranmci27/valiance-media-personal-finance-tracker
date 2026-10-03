import { NextResponse, type NextRequest } from "next/server";
import { openApiDocument } from "@/lib/api/openapi";

export const dynamic = "force-dynamic";

/** The API's OpenAPI document. Public: it describes the endpoints and holds no data. */
export function GET(request: NextRequest) {
  return NextResponse.json(openApiDocument(request.nextUrl.origin), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
