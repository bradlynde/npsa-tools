# Grant knowledge import report

Extracted 2026-09-17 from the Drive `grant-knowledge` folder (audit of 2026-08-11). This is what the extractor could not settle by itself. **Section 1 needs a ruling before the load**; the rest is for review.

| | |
| :-- | --: |
| jurisdiction | 57 |
| program | 108 |
| requirement | 465 |
| cycle | 99 |
| deadline | 98 |
| contact | 103 |
| note | 153 |
| source | 253 |
| **records** | **1336** |
| imported as verified | 1153 |
| imported as unverified (waits in the queue) | 183 |
| jurisdictions with no file | none |

A ruling goes in `scripts/gk-rulings.json` (`records` to add, `patch` to change one by its import key, `skip` to leave one out), then re-run the extractor.

## 1. Needs a ruling

- **TX/federal FY2026**: the web check moved this to **2026-02-12** (was 2026-07-06); Drive has 2026-07-06 (Stage 2: IJ, VA, mission and resolution uploaded to eGrants), 2026-07-06 (Stage 2: IJ, VA, mission and resolution uploaded to eGrants). Web check's reason: Texas collects NSGP subapplications through eGrants months ahead of the rest of the country — the FFY2026 solicitation closed February 12, 2026, with awards performing from September 1, 2026. The extracted date put it in July alongside everyone else. A Texas client told 'you have until July' misses the cycle by five months, and there is no second window. Sources: egrants.gov.texas.gov/fundingopp/nonprofit-security-grant-program-nsgp-federal-fiscal-year-2026; grantedai.com — Nonprofit Security Grant Program (NSGP), Federal Fiscal Year 2026, Office of the Governor, State of Texas. **Neither is imported as verified until ruled.**
- **AL/federal FY2026**: the web check moved this to **2026-07-16** (was 2026-07-15); Drive has 2026-07-15 (Application due). Web check's reason: Two results give Thursday, July 16, 2026, and July 16, 2026 is in fact a Thursday — the day-of-week corroborates the date. July 15 was a Wednesday. Sources: alea.gov/nonprofit-security-grant-program-nsgp; instrumentl.com — NSGP Alabama. **Neither is imported as verified until ruled.**
- **AZ/AZ-NSGP**: the web check says this cycle is "labelled FY2027" (labelled FY2026). The June 12, 2026 deadline is correct, but AZDOHS runs it as the FY2027 cycle. Mislabelling the year makes the row look superseded when it is the current one. The bundle labels a state program's round by the year its deadline falls in; say if this one should read otherwise.
- **AL/NSGP-S FY2026**: the Sales Toolbox table says **2026-07-16** (verified); Drive says **2026-07-15**. Both imported; see section 5.
- **TN/TN-HOW FY2026**: the Sales Toolbox table says **2025-07-31** (knowledge-base); Drive says **2026-08-03, 2026-07-29**. Both imported; see section 5.
- **TX/NSGP-S FY2026**: the Sales Toolbox table says **2026-02-12** (verified); Drive says **2026-07-06**. Both imported; see section 5.

## Rulings already applied (scripts/gk-rulings.json)

- d:TX:NSGP-S:2026:final: patched (Texas runs two stages; the July date is the second)
- d:TX:NSGP-UA:2026:final: patched (same two-stage process as NSGP-S)
- d:TX:NSGP-S:2026:stage1-certification: added (TX.yaml carries Stage 1 only in prose, so no parser lifts it)
- n:TX:-:fy26-stage-1-date: added (the conflict the import must not settle silently)

## 2. The 2026-08-08 web check against Drive

- FL/FL-NSGP: marked **dormant** from the 2026-08-08 web check (No cycle confirmed since the 2023 program closed in January 2024.)
- NJ/NJ-NSGP-THE: `exclusive_with` NJ-NSGP-SP from the web check
- NJ/NJ-NSGP-SP: `exclusive_with` NJ-NSGP-THE from the web check
- SD/NSGP-S: 2026-07-17 downgraded to "verify" by the web check (Nothing published corroborates the July 17 date; South Dakota's page says only that the 2026 non-profit window has closed. The date may well be right — but 'confirmed' is a promise, and this one cannot be backed.)
- WA/federal-noi FY2026: web check's 2026-06-30 agrees with Drive.
- PA/PA-NSGFP: added 2026-09-10 from the web check (unverified). Drive does not have it.
- TN/TN-HOW: added 2026-07-29 from the web check (unverified). Drive does not have it.

## 3. Prose companions

- **IL.md**: last verified "April 2026 — FY 2025 cycle". Imported as **unverified**. 20 notes.
- **NC.md**: last verified "May 13, 2026 — FY25 cycle closed, FY26 pre-NOFO". Imported as **unverified**. 18 notes.
- **NY.md**: last verified "April 15, 2026". Imported as **unverified**. Contains terms the audit retired: "Grants Gateway". 18 notes.
- **OR.md**: last verified "June 23, 2026 — FY25 cycle closed, FY26 pre-NOFO". Imported as **unverified**. Contains terms the audit retired: "DEMES". 8 notes.
- **TX.md**: last verified "September 2026 — rewritten to agree with `states/TX.yaml` (NPSA full audit 2026-08-11)". Imported as **verified**. Contains terms the audit retired: "TDEM Grants Portal". 11 notes.
- **UT.md**: last verified "April 21, 2026 — FY26 cycle (pre-NOFO)". Imported as **unverified**. 11 notes.
- **WA.md**: last verified "April 14, 2026 — FY26 cycle (pre-NOFO)". Imported as **unverified**. 11 notes.

Prose sections that restate what the YAML holds (SAA, portal, program parameters, required documents, registration, cost share) were not imported; the YAML is the authority for those. Timelines, allocations and history were imported as `history` notes so the past cycles in them are not lost; the research pass turns them into cycles.

## 4. The client intake page against Drive

- **CO**: the client page shows "CO EMGrants account / DHSEM grants portal access" but no Drive registration step matches it. Drive has: "Apply to FEDERAL NSGP first and NOT be selected".
- **KY**: the client page shows "Kentucky eClearinghouse — client self-registers on the KY DLG Portal (Dept for Local Government, NOT KOHS), then files the project for EO 12372 state review" but no Drive registration step matches it. Drive has: "Kentucky eClearinghouse account — OBSOLETE for NSGP as of FY26".

## 5. The live deadline table

45 rows read; 25 already had a matching date in the bundle. The rest:

- AL / federal / 2026: **2026-07-16** came from the live table (verified, confirmed), imported unverified. Drive has **2026-07-15** for the same program and cycle: they disagree, and both are in the bundle. Rule on it.
- AZ / federal / 2025: **2025-10-15** came from the live table (knowledge-base, illustrative), imported unverified.
- CA / CSNSGP / 2026: **2025-12-12** came from the live table (knowledge-base, illustrative), imported unverified.
- CA / federal / 2025: **2025-11-21** came from the live table (knowledge-base, illustrative), imported unverified.
- CT / federal / 2026: **2026-07-12** came from the live table (manual, confirmed), imported verified (typed by hand).
- DC / federal / 2025: **2026-01-09** came from the live table (knowledge-base, illustrative), imported unverified.
- GA / federal / 2025: **2025-11-17** came from the live table (knowledge-base, illustrative), imported unverified.
- IN / federal / 2025: **2025-10-21** came from the live table (knowledge-base, illustrative), imported unverified.
- KY / federal / 2025: **2026-01-16** came from the live table (verified, illustrative), imported unverified.
- ME / federal / 2025: **2025-12-15** came from the live table (knowledge-base, illustrative), imported unverified.
- MI / federal / 2025: **2025-10-26** came from the live table (knowledge-base, illustrative), imported unverified.
- MT / federal / 2025: **2025-10-15** came from the live table (knowledge-base, illustrative), imported unverified.
- NE / NE-NSGP / 2024: **2025-01-31** came from the live table (knowledge-base, illustrative), imported unverified.
- NH / federal / 2025: **2025-10-29** came from the live table (knowledge-base, illustrative), imported unverified.
- NJ / NJ-NSGP-THE / 2025: **2025-09-15** came from the live table (knowledge-base, illustrative), imported unverified.
- OK / federal / 2025: **2025-10-31** came from the live table (knowledge-base, illustrative), imported unverified.
- OR / federal / 2025: **2026-01-15** came from the live table (knowledge-base, confirmed), imported unverified.
- RI / federal / 2025: **2026-01-19** came from the live table (knowledge-base, confirmed), imported unverified.
- TN / TN-HOW / 2026: **2025-07-31** came from the live table (knowledge-base, illustrative), imported unverified. Drive has **2026-08-03, 2026-07-29** for the same program and cycle: they disagree, and both are in the bundle. Rule on it.
- TX / federal / 2026: **2026-02-12** came from the live table (verified, confirmed), imported unverified. Drive has **2026-07-06** for the same program and cycle: they disagree, and both are in the bundle. Rule on it.

## 6. Still unknown in Drive (each became an open question)

- AR/NSGP-S: submission.method, submission.target
- AS/NSGP-S: submission.method, submission.target
- CO/CO-NSGP: locations_max
- CT/CT-NSGP: locations_max
- FL/FL-NSGP: ma_allowed_pct, cost_match, stackable_with_federal
- GA/GA-FPC: stackable_with_federal
- GU/NSGP-S: submission.method, submission.target
- HI/NSGP-UA: submission.method, submission.target
- IL/NSGP-IL: stackable_with_federal
- LA/LCSSGP: stackable_with_federal
- MA/CNSGP: locations_max, award_cap_per_location, award_cap_per_applicant, stackable_with_federal
- MA/CNSPGP: locations_max, award_cap_per_location, award_cap_per_applicant, stackable_with_federal
- MD/PAHC: award_cap_per_applicant, stackable_with_federal
- ME/ME-NSGP: locations_max, award_cap_per_location, award_cap_per_applicant, ma_allowed_pct, cost_match, submission.method, submission.target
- MN/MN-SUPP: ma_allowed_pct
- MP/NSGP-S: submission.method, submission.target
- NE/NE-NSGP: locations_max
- NJ/NJ-NSGP-THE: locations_max, cost_match
- NJ/NJ-NSGP-SP: locations_max, cost_match
- NV/NSGP-S: submission.method, submission.target
- NV/NSGP-UA: submission.method, submission.target
- NY/SCAHC: cost_match
- OH/OSG: locations_max, ma_allowed_pct, cost_match, stackable_with_federal
- PA/PA-NSGFP: locations_max, stackable_with_federal
- PR/NSGP-S: submission.method, submission.target
- VI/NSGP-S: submission.method, submission.target
- WA/WA-COMMERCE-RNSG: award_cap_per_location, submission.method

## 7. Contacts parsed out of free text

| Where | Name | Role or org | Email | Phone | Flag |
| :-- | :-- | :-- | :-- | :-- | :-- |
| AK/NSGP-S |  | MVA Grants Section | mva.grants@alaska.gov | 907-428-7000 |  |
| AL/NSGP-S |  | ALEA Grants Administration |  | 334-517-2815 |  |
| AR/NSGP-S |  |  | HSGP@ADEM.Arkansas.gov | 501-683-6700 | ⚠️ decoded from ADEM page's obfuscated mailto — pattern matches ADEM convention; co |
| AS/NSGP-S | Vinnie Atofau Jr. |  | v.atofau@asdhs.as.gov | (684) 699-3800 |  |
| AZ/NSGP-S |  | AZDOHS Grants | hs@azdohs.gov |  |  |
| CA/NSGP-S |  |  | Nonprofit.Security.Grant@caloes.ca.gov |  |  |
| CA/NSGP-S |  | VA help | VA@caloes.ca.gov | (888) 788-7983 |  |
| CA/CSNSGP |  |  | CSNSGP@caloes.ca.gov | 1-916-845-8410 |  |
| CO/NSGP-S |  |  | CDPS_DHSEM_NSGPadmin@state.co.us |  |  |
| CT/NSGP-S |  |  | DEMHS.NSGP-S@ct.gov |  |  |
| CT/CT-NSGP |  |  | DEMHS.CT-NSGP@ct.gov |  |  |
| DC/NSGP-UA | Charles Madden |  | charles.madden@dc.gov | 202-724-6568 | ⚠️ no longer published on hsema.dc.gov/nsgp as of 8/2026 — reconfirm before using;  |
| DC/NSGP-UA |  |  | NCR.NSGP@dc.gov |  |  |
| DC/NSGP-UA |  |  | Cembrye.ross@dc.gov |  |  |
| DE/NSGP-S |  | Nicole Carey / Chanel Daniels | preparednessgrants@delaware.gov | 302-659-3362 |  |
| FL/NSGP-S |  | FDEM NSGP | fdem_nsgpgrant@em.myflorida.com |  |  |
| FL/NSGP-S | Amy Garmon | NSGP Program Manager |  |  |  |
| FL/NSGP-S |  |  | FLNSGP@em.myflorida.com |  |  |
| FL/NSGP-S | Linda McWhorter |  |  | (850) 815-4302 | ⚠️ reconfirm — not on current pages |
| FL/FL-NSGP |  | FDEM Grants Unit |  |  |  |
| GA/NSGP-S |  | GEMA/HS NSGP line |  | (404) 635-7068 |  |
| GA/NSGP-S |  | Main line |  | (404) 635-7200 |  |
| GU/NSGP-S | Esther J.C. Aguigui |  | esther.aguigui@ghs.guam.gov | (671) 475-9600 |  |
| GU/NSGP-S | Michael Taijeron Jr. |  | michael.taijeron@ghs.guam.gov | 671-478-0291 |  |
| HI/NSGP-S | Glen Badua | Grants Manager | glen.m.badua@hawaii.gov |  |  |
| HI/NSGP-S | Frank J. Pace |  | frank.j.pace@hawaii.gov | 808-369-3570 | ⚠️ FEMA's row still links the old dod.hawaii.gov site — stale on affiliation |
| IA/NSGP-S | Kimberly Grandinetti | NSGP Grant Manager | kimberly.grandinetti@iowa.gov | 515-577-1985 |  |
| ID/NSGP-S | Val Mills | PM | vmills@imd.idaho.gov | 208-258-6570 |  |
| ID/NSGP-S | Matt McCarter | PM | mmccarter@imd.idaho.gov | 208-258-6517 | ⚠️ Kari Harneck no longer listed as of 8/2026 |
| IL/NSGP-S | Tammy Porter | Preparedness Grants Program Mgr, IEMA | Tammy.D.Porter@illinois.gov | (217) 557-4831 |  |
| IL/NSGP-S |  | ITTF grants desk |  | (217) 782-7860 |  |
| IN/NSGP-S |  | IDHS Grants Management | grants@dhs.in.gov | 317-232-2222 |  |
| KS/NSGP-S | Lieutenant Edna Murphy | Grant Administration | NSGP.KHP@KS.GOV |  |  |
| KY/NSGP-S | Jennifer Annis |  | jennifer.annis@ky.gov |  | ⚠️ FY26 submission POCs — confirm still current each cycle |
| KY/NSGP-S |  | KOHS main |  | (502) 564-2081 |  |
| LA/NSGP-S | Kaneshia Thomas-Cheatham | Grants Technician, Preparedness Grants Section | Kaneshia.Thomas-Cheatham2@la.gov | (225) 925-1812 |  |
| LA/NSGP-S |  |  | PrepGrants@LA.GOV |  |  |
| LA/LCSSGP |  | LCSS, 7667 Independence Blvd., Baton Rouge, LA 70806 |  |  |  |
| MA/NSGP-S | Brian P. Nichols | MA State Coordinator for federal NSGP | Brian.P.Nichols@mass.gov |  |  |
| MA/CNSGP | Myesha M. Auguste | Program Coordinator | Myesha.M.Auguste@mass.gov |  |  |
| MD/NSGP-S |  | MDEM NSGP | nsgp.mdem@maryland.gov |  |  |
| ME/NSGP-S |  |  | HSGrants.maine@maine.gov | 207-624-4400 |  |
| MI/NSGP-S |  |  | MSP-EMHSD-NSGP@michigan.gov |  |  |
| MN/NSGP-S | Greg Ruehl | NSGP & OPSG Grant Administrator | greg.ruehl@state.mn.us | 651-583-4960 | ⚠️ per Ruehl's email signature; NOTE: HSEM website shows 651-586-4960 — one-digit c |
| MN/NSGP-S |  | HSEM | dps.hsem@state.mn.us | 651-201-7400 |  |
| MO/NSGP-S | Joanne Talleur | Grants Specialist | Joanne.Talleur@dps.mo.gov | 573-522-2851 |  |
| MO/NSGP-S | Chelsey Call | Grants Supervisor |  | 573-526-9203 |  |
| MO/NSGP-S | Joni McCarter | Program Manager |  | 573-526-9020 |  |
| MO/NSGP-S |  | MO DPS Homeland Security | homeland.security@dps.mo.gov | 573-522-1113 |  |
| MP/NSGP-S | Naomi Ada |  | naomi.ada@cnmihsem.gov.mp | (670) 488-1001 |  |
| MS/NSGP-S |  | MOHS Grants | mohsgrants@dps.ms.gov | 601-987-1278 |  |
| MS/NSGP-S | Beth Loflin |  | beth.loflin@dps.ms.gov |  | ⚠️ from SAA email — not on the public page |
| MT/NSGP-S |  | MT DES | mtdes@mt.gov | (406) 324-4777 |  |
| NC/NSGP-S |  |  | NSGP@ncdps.gov | 919-710-8885 |  |
| NC/NSGP-S |  | Salesforce | NCEMSalesforce@ncdps.gov |  |  |
| ND/NSGP-S | Debbie LaCombe | NDDES Preparedness Section Chief | dlacombe@nd.gov | 701-328-8119 | ⚠️ ⚠️ Debbie LaCombe is only publicly traceable to the 2022 announcement — stale-ri |
| NE/NSGP-S |  | NEMA NSGP | nema.nsgp@nebraska.gov |  |  |
| NE/NSGP-S |  | general preparedness grants | nema.grants@nebraska.gov | 402-471-7421 |  |
| NH/NSGP-S |  | Grants Management Bureau | HomelandGrants@dos.nh.gov | (603) 271-7663 |  |
| NH/NSGP-S | Madison Cleveland | Grants Program Specialist |  | 603-271-7050 |  |
| NJ/NSGP-S |  | NJOHSP Grants | grants@njohsp.gov |  |  |
| NJ/NSGP-S |  | Main line |  | (609) 584-4000 |  |
| NM/NSGP-S |  | NMDHSEM Grants Management Bureau | dhsem-grantsmanagement@state.nm.us |  |  |
| NM/NSGP-S |  | Main line |  | (505) 476-9600 |  |
| NV/NSGP-S | Shea Slone | Preparedness Grants Supervisor | seslone@oem.nv.gov |  |  |
| NV/NSGP-S |  | grants inbox | DHSGrants@oem.nv.gov | 775-687-0300 | ⚠️ public page still shows old DHSgrants@dem.nv.gov address |
| NY/NSGP-S |  | DHSES NSGP | nsgp@dhses.ny.gov | 1-866-837-9133 |  |
| NY/SCAHC |  | DCJS | funding@dcjs.ny.gov |  |  |
| NY/SCAHC | Jason Tillou | Public Safety Grants Rep 4 |  | (518) 457-9787 |  |
| NY/SCAHC | Cillian Flavin | Dep. Commissioner |  |  |  |
| OH/NSGP-S |  | Ohio EMA NSGP | NSGP@dps.ohio.gov |  |  |
| OH/NSGP-S |  | Main line |  | (614) 889-7150 |  |
| OK/NSGP-S |  | OKOHS Grants | hsgrants@okohs.ok.gov |  |  |
| OR/NSGP-S | Kevin Jeffries | Grant Coordinator | kevin.jeffries@oem.oregon.gov | 971-719-0740 |  |
| OR/NSGP-S | Carin Sherman | Grant Specialist | Carin.Sherman@oem.oregon.gov | 971-433-7957 |  |
| PA/NSGP-S |  | PEMA Grants | NSGPgrant@pa.gov |  |  |
| PA/PA-NSGFP |  | PCCD | RA-CD-NPSEC-GRANT@pa.gov |  |  |
| PR/NSGP-S | Taviana Nevares |  | tnevares@oasp.pr.gov | (305) 721-0008 | ⚠️ ⚠️ oasp.pr.gov DNS does NOT resolve as of 8/11/2026 (site dead) — the tnevares@o |
| RI/NSGP-S |  | RIEMA Grants | ema.grants@ema.ri.gov | (401) 946-9996 |  |
| RI/NSGP-S | Denise Manni |  | denise.manni@ema.ri.gov | 401-572-7502 | ⚠️ reconfirm — not on current page |
| RI/NSGP-S | Rinky Roy-Philip |  | rinky.royphilip.ctr@ema.ri.gov | 401-318-0962 | ⚠️ reconfirm |
| SC/NSGP-S | Robert Connell | PhD | rconnell@sled.sc.gov | 803-896-7021 |  |
| SD/NSGP-S |  | SD Office of Homeland Security |  | (605) 773-3450 |  |
| SD/NSGP-S |  | general DPS |  | (605) 773-2914 |  |
| TN/NSGP-S |  |  | OHS.Grants@tn.gov |  |  |
| TX/NSGP-S |  | eGrants help desk | eGrants@gov.texas.gov | (512) 463-1919 |  |
| TX/NSGP-S | Will Ogletree |  | Will.Ogletree@gov.texas.gov |  |  |
| UT/NSGP-S | Danielle Smith | NSGP Program Manager | daniellesmith@utah.gov | 801.870.0793 |  |
| VA/NSGP-S |  | VDEM Grants | vdemgrants@VDEM.virginia.gov |  |  |
| VA/NSGP-UA-NCR |  | DC HSEMA NSGP |  |  |  |
| VI/NSGP-S | Florecita Brunn |  | florecita.brunn@vitema.vi.gov | (340) 715-6819 |  |
| VI/NSGP-S |  | VITEMA general intake if Brunn unreachable | contact@vitema.vi.gov | (340) 774-2244 |  |
| VT/NSGP-S |  | Vermont Homeland Security Grants Unit | DPS.HSUGrants@vermont.gov |  |  |
| WA/NSGP-S |  |  | preparedness.grants@mil.wa.gov |  |  |
| WA/NSGP-S | Chris Burd | NSGP Program Manager | christopher.burd@mil.wa.gov | 253-512-7482 | ⚠️ no longer listed on the NSGP page as of 8/2026 — may still be PM; reconfirm |
| WA/WA-COMMERCE-RNSG | Michelle Griffin |  | Michelle.Griffin@commerce.wa.gov | 360-584-3437 |  |
| WI/NSGP-S |  | WEM NSGP | NSGP@widma.gov |  |  |
| WV/NSGP-S | Ian A. Jones |  | ian.a.jones@wv.gov | 304-414-7673 |  |
| WV/NSGP-S |  | WV Homeland Security SAA | HSSAA@wv.gov |  |  |
| WY/NSGP-S | Darryl Erickson | NSGP Program Manager | darryl.erickson1@wyo.gov | 307-777-4917 |  |

A contact with a flag, or with neither an email nor a phone, imports unverified. Each keeps its original line in `extra.raw`.

## 8. Text cut to fit

Nothing was cut.

## 9. Not read

- states/GA.yaml.bak-20260906-200833: not a state file, not read
- states/TX-v1-2026-04-SUPERSEDED.md: not a state file, not read
- states/_archive: not a state file, not read
