import { redirect } from "next/navigation";
import { PayrollEncryptionGuard } from "@/components/features/payroll/payroll-encryption-guard";
import { PayrollWorkflowRail } from "@/components/features/payroll/workflow-rail";
import { isDemoMode } from "@/lib/demo";
import { isSsnEncryptionConfigured } from "@/lib/crypto/ssn";
import { PAYROLL_ENABLED } from "@/lib/env";

export default function PayrollLayout({ children }: { children: React.ReactNode }) {
  if (!PAYROLL_ENABLED) {
    redirect("/");
  }
  if (!isDemoMode() && !isSsnEncryptionConfigured()) {
    return <PayrollEncryptionGuard />;
  }
  return (
    <div className="space-y-6">
      <div className="max-w-5xl mx-auto">
        <PayrollWorkflowRail />
      </div>
      {children}
    </div>
  );
}
