import {z} from "zod";
import {dateSchema} from "./contracts";
export interface ContractorItem {
 id:string;name:string;contractor_classification:string;documentation_status:string;
 paid_cents:string;card_cents:string;meets_threshold:boolean;
}
export interface ContractorView {
 year:number;through:string;revision:string;threshold_cents:string;offset:number;count:number;rows:ContractorItem[];
}
// Thresholds are contextual worksheet rules, never an instruction to file a form.
export const contractorYearRules: Record<
  number,
  { minimum_cents: string; source: string; revision: string }
> = {
  2025: {
    minimum_cents: "60000",
    source: "https://www.irs.gov/pub/irs-prior/i1099mec--2025.pdf",
    revision: "2025-04",
  },
  2026: {
    minimum_cents: "200000",
    source: "https://www.irs.gov/pub/taxpros/fs-2025-08.pdf",
    revision: "FS-2025-08",
  },
};

export const contractorFilterSchema=z.object({
 year:z.number().int().min(1900).max(2100),through:dateSchema,
 offset:z.number().int().min(0).max(10000000).default(0),query:z.string().max(200).default(''),party:z.uuid().optional(),
}).strict().refine(v=>v.through.startsWith(`${v.year}-`));
export type ContractorFilter=z.infer<typeof contractorFilterSchema>;
