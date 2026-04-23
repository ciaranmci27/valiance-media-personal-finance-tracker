// State tax calculator: "custom" - reserved for state-specific overrides
// that don't fit the none/flat/flat_employee_elected/progressive shapes.
//
// Not implemented for the MVP. Adding a state here requires:
//   1. A dedicated file (e.g. state/california.ts) implementing the
//      state's withholding methodology (CA DE 44 tables, NY IT-2104 pubs,
//      etc.).
//   2. A switch case inside state/index.ts that calls it.
//
// Until then, configuring a state with calculation_method='custom' will
// throw at calc time rather than silently under-withhold.

export function calculateCustomIncomeTax(): never {
  throw new Error(
    "State calculation method 'custom' is not implemented. " +
      "Either change the state's calculation_method in Settings, " +
      "or add a state-specific implementation in src/lib/payroll/state/.",
  );
}
