import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import { reportCatalog } from "@/lib/accounting/report-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(apiOperation("books.reports"), async () => ({
  data: {
    reports: reportCatalog.map(({ id, title, description, group }) => ({
      id,
      title,
      description,
      group,
    })),
  },
}));
