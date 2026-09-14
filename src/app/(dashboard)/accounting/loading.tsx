import { AccountingLoading } from "@/components/features/accounting/accounting-loading";

/**
 * Shown the moment the books are opened, while the server builds the
 * workspace. The shell then takes over with the same loader in the same
 * place and carries the sequence on from its second line.
 */
export default function Loading() {
  return <AccountingLoading step={0} />;
}
