"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Map as MapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";

interface Props {
  defaultYear: number;
}

export function StateNewPickerContent({ defaultYear }: Props) {
  const router = useRouter();
  const [stateCode, setStateCode] = React.useState("");
  const [yearStr, setYearStr] = React.useState(String(defaultYear));

  const handleContinue = () => {
    if (!stateCode) {
      toast("error", "Select a state");
      return;
    }
    const year = Number(yearStr);
    if (!year || year < 2000 || year > 2100) {
      toast("error", "Enter a valid 4-digit year");
      return;
    }
    router.push(`/payroll/config/states/${stateCode}/${year}`);
  };

  return (
    <div className="space-y-6 max-w-xl mx-auto">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
            <MapIcon className="h-5 w-5 text-violet-500" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Add State</h1>
            <p className="text-sm text-muted-foreground">
              Pick a state and tax year to configure
            </p>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-xl p-6 space-y-4">
        <CustomSelect
          label="State"
          value={stateCode}
          onChange={setStateCode}
          options={STATE_OPTIONS}
          placeholder="Select state"
        />
        <NumberInput
          label="Tax Year"
          value={yearStr}
          onChange={(e) => setYearStr(e.target.value)}
          integer
          noCommas
          placeholder="2026"
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={handleContinue}>Continue</Button>
      </div>
    </div>
  );
}
