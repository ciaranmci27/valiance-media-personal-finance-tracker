import { AccountingLoading } from "@/components/features/accounting/accounting-loading";
import { RouteLoading } from "@/components/layout/boot";

/**
 * Shown the moment the books are opened, while the server builds the
 * workspace. The shell then takes over with the same loader in the same
 * place and carries the sequence on from its second line. On a hard load the
 * boot screen covers this wait instead, so there is only ever one loader.
 */
export default function Loading() {
  return (
    <RouteLoading>
      <AccountingLoading step={0} />
    </RouteLoading>
  );
}
