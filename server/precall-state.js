/**
 * The briefing's "NSGP GRANT FUNDING DATA" block for one state: the federal track with
 * its SAA, then each state-funded program with its cap, whether it stacks, and what
 * could make it the wrong thing to pitch. The model writes the funding section from
 * this, so every hedge in it is deliberate.
 *
 * `programs` is in the shape nsgp_state_reference has always used (acronym, name,
 * perSite, perApplicant, stackable, note, exclusiveWith, dormant, unconfirmed,
 * availabilityNote, administeredBy); knowledge.js briefingFor() supplies it.
 */
export function stateFundingBlock({ state: orgState, saaName, programs: statePrograms = [], federalSiteCap = 200000 }) {
  // A cap can be per site, per applicant, or unpublished, and the difference is
  // the difference between "up to $250,000 per building" and "up to $50,000 full
  // stop". Stating the wrong one inflates the number a rep quotes on a call.
  const capLine = (p) => {
    if (p.perSite && p.perApplicant) return `$${p.perSite.toLocaleString()} per site, up to $${p.perApplicant.toLocaleString()} per applicant`;
    if (p.perSite) return `$${p.perSite.toLocaleString()} per site`;
    if (p.perApplicant) return `$${p.perApplicant.toLocaleString()} per applicant (NOT per site)`;
    return 'cap not published — do not state an amount';
  };
  // Several of these are alternatives to federal NSGP rather than additions:
  // Arizona, Colorado and Nebraska all bar applicants who have federal awards.
  // Presenting them as stackable would be a straightforwardly wrong pitch.
  const stackLine = (p) => p.stackable === true
    ? 'Stackable with federal NSGP.'
    : p.stackable === false
      ? 'NOT stackable — this is an ALTERNATIVE to federal NSGP, and eligibility usually depends on NOT holding a federal award. Do not present the two as additive.'
      : 'Stackability not confirmed — do not claim the two can be combined.';

  /*
   * Stackability against the federal award is not the only way two numbers get
   * wrongly added together. New Jersey runs two state programs, each of which
   * stacks with federal NSGP, and an organization may be awarded only one of
   * them — so the honest ceiling is $100,000, not $120,000.
   */
  const exclusiveLine = (p) => p.exclusiveWith?.length
    ? `  MUTUALLY EXCLUSIVE with ${p.exclusiveWith.join(', ')} — the organization may apply to both but can be AWARDED only one state program per fiscal year. Do not add these two caps together.`
    : null;

  // A program with published caps and no live cycle is the quietest way to be
  // wrong: everything reads correctly and the money is not there.
  const availabilityLine = (p) => p.dormant
    ? `  AVAILABILITY: dormant — ${p.availabilityNote} Do not present this as currently available funding; mention it only as something to watch.`
    : p.unconfirmed
      ? `  AVAILABILITY: unconfirmed — ${p.availabilityNote} Do not present this as available funding.`
      : null;

return [
    `NSGP GRANT FUNDING DATA:`,
    `State: ${orgState}`,
    ``,
    `PROGRAM 1 — Federal NSGP (always applicable):`,
    `  Program: Federal Nonprofit Security Grant Program (NSGP)`,
    `  Award cap: $${federalSiteCap.toLocaleString()} per physical site/location`,
    `  Administered in-state by (SAA): ${saaName}`,
    statePrograms.length
      ? statePrograms.map((p, i) => [
          ``,
          `PROGRAM ${i + 2} — State-funded (${orgState}):`,
          `  Program: ${p.name} (${p.acronym})`,
          `  Award cap: ${capLine(p)}`,
          `  ${stackLine(p)}`,
          exclusiveLine(p),
          availabilityLine(p),
          p.administeredBy ? `  Administered by ${p.administeredBy} — NOT the SAA named above. Point the client at the right office.` : null,
          p.note ? `  Note: ${p.note}` : null,
        ].filter(Boolean).join('\n')).join('\n')
      : `\nSTATE-FUNDED PROGRAMS: ${orgState} does NOT operate a separate state-funded nonprofit security grant program. Federal NSGP is the only track — present only the federal track and note there is no separate state program.`,
    ``,
    `DEADLINES: filled in by the application from a curated table and inserted at the <<FUNDING_DEADLINES>> token. Do NOT write any deadline date anywhere in your output.`,
].join('\n');
}
