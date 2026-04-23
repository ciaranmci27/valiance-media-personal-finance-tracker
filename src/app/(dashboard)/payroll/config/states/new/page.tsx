import { StateNewPickerContent } from "@/components/features/payroll/state-new-picker-content";

export const metadata = {
  title: "Add State | Payroll Settings",
};

export default function StateNewPickerPage() {
  const now = new Date();
  const defaultYear = now.getFullYear();
  return <StateNewPickerContent defaultYear={defaultYear} />;
}
