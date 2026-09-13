/**
 * The one rule for how the business is taxed in a year: the election from
 * its start year on, the entity's default before it.
 */
import assert from "node:assert/strict";
import {
  businessTypeForYear,
  classificationForYear,
  defaultClassification,
  isElection,
  type TaxProfileFacts,
} from "../src/lib/business-classification";

let n = 0;
const check = (label: string, ok: boolean) => {
  assert.ok(ok, label);
  n++;
};

const llcElected: TaxProfileFacts = {
  entity_type: "llc",
  tax_classification: "s_corp",
  tax_classification_since: 2023,
};

check("an LLC electing nothing is a disregarded entity", defaultClassification("llc") === "disregarded");
check("a corporation electing nothing is a C corporation", defaultClassification("corporation") === "c_corp");
check("a sole proprietorship has only one classification", defaultClassification("sole_proprietorship") === "sole_prop");
check("a partnership has only one classification", defaultClassification("partnership") === "partnership");

check("an LLC taxed as an S corporation is an election", isElection(llcElected));
check("an LLC taxed as a disregarded entity is not", !isElection({ entity_type: "llc", tax_classification: "disregarded" }));
check("a corporation taxed as an S corporation is an election", isElection({ entity_type: "corporation", tax_classification: "s_corp" }));
check("a corporation taxed as a C corporation is not", !isElection({ entity_type: "corporation", tax_classification: "c_corp" }));

check("the year before the election is taxed as the entity's default", classificationForYear(llcElected, 2022) === "disregarded");
check("the election year takes the election", classificationForYear(llcElected, 2023) === "s_corp");
check("later years keep the election", classificationForYear(llcElected, 2026) === "s_corp");
check("no start year means the classification applies to every year", classificationForYear({ ...llcElected, tax_classification_since: null }, 2019) === "s_corp");
check("a start year after the year in question falls back to the default", classificationForYear({ ...llcElected, tax_classification_since: 2027 }, 2026) === "disregarded");

const corpElected: TaxProfileFacts = {
  entity_type: "corporation",
  tax_classification: "s_corp",
  tax_classification_since: 2024,
};
check("a corporation before its S election is a C corporation for the estimator", businessTypeForYear(corpElected, 2023) === "c_corp" && classificationForYear(corpElected, 2023) === "c_corp");
check("a corporation from its S election on is an S corporation for the estimator", businessTypeForYear(corpElected, 2024) === "s_corp");
check("an LLC stays an LLC for the estimator whatever the year", businessTypeForYear(llcElected, 2022) === "llc" && businessTypeForYear(llcElected, 2025) === "llc");
check("sole proprietorships and partnerships map straight through", businessTypeForYear({ entity_type: "sole_proprietorship", tax_classification: "sole_prop", tax_classification_since: null }, 2026) === "sole_prop" && businessTypeForYear({ entity_type: "partnership", tax_classification: "partnership", tax_classification_since: null }, 2026) === "partnership");

console.log(`Business classification: ${n} checks passed.`);
