import { AppLoading } from "@/components/ui/app-loading";
import { RouteLoading } from "@/components/layout/boot";
import { TAX_STEPS } from "@/components/features/tax/tax-steps";

/**
 * Shown the moment the estimator is opened, while the server loads the saved
 * estimates. The page then continues the same loader until the books have
 * been read, so arrival is one loader, not a page that loads twice. On a hard
 * load the boot screen covers this wait instead.
 */
export default function Loading() {
  return (
    <RouteLoading>
      <AppLoading
        steps={TAX_STEPS}
        step={0}
        announcement="Loading the estimator"
      />
    </RouteLoading>
  );
}
