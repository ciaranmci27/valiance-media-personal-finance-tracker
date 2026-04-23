// State tax calculator: "none" - states with no income tax (TX, FL, WA, etc.).
// Income tax withholding is zero regardless of wages. SUTA / SDI are still
// computed upstream by the dispatcher; this module only handles income tax.

export interface NoneIncomeTaxInput {
  grossThisPeriod: number;
}

export interface NoneIncomeTaxResult {
  stateIncomeTax: 0;
}

export function calculateNoneIncomeTax(
  _input: NoneIncomeTaxInput,
): NoneIncomeTaxResult {
  return { stateIncomeTax: 0 };
}
