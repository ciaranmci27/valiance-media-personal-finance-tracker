import { AppLoading } from "@/components/ui/app-loading";
import { TAX_STEPS } from "@/components/features/tax/tax-steps";

/**
 * Shown the moment the estimator is opened, while the server loads the saved
 * estimates. The page then continues the same loader until the books have
 * been read, so arrival is one loader, not a page that loads twice.
 */
export default function Loading() {
  return (
    <AppLoading
      steps={TAX_STEPS}
      step={0}
      announcement="Loading the estimator"
    />
  );
}
