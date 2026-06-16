# NPSA Sales Toolbox — Feature Updates
**Date:** June 16, 2026
**Branch:** `claude/explore-integrate-react-15lBV` (pending merge to `loe-generator`)

---

## 1. Pre-Call Notes Generator — Action Buttons

After generating pre-call notes, two new action buttons appear below the notes panel.

### Start Engagement Letter
Clicking this button carries known information from the pre-call form directly into the Engagement Letter generator:
- Organization name → Client Name
- Organization type (church/school/other) → Client Type
- First attendee name, email, and phone → Contact fields
- Today's date → Signing Date

The generator opens on the Pre-Award tab, ready to fill in locations and programs. This eliminates re-entering data the rep already collected during call prep.

### Draft Follow-up Email
Clicking this button sends the pre-call notes to the AI and generates a personalized post-call email draft. The email:
- Addresses the contact by first name
- References the organization by name
- Cites the specific NSGP dollar amount and deadline from the notes
- Mentions the Engagement Letter and Brochure are attached
- Includes Brad's Calendly link for a follow-up appointment
- Closes from Brad Lynde / NPSA

The draft appears in a panel below the notes with a **Copy Email** button for quick use.

---

## 2. Pre-Call Notes — NSGP Funding Snapshot (Dual-Program)

The NSGP Funding Snapshot section now presents **both funding tracks** available to the prospective client.

### Federal NSGP (always shown)
- Potential award calculated at **$200,000 per physical site/location** (corrected from prior $150K figure)
- Sub-applicant deadline: lists the **last 3 confirmed deadline dates** by year, then projects the next window
- Administering state agency (SAA) identified by state

### State-Funded Program (shown when applicable)
States that operate their own nonprofit security grant program in addition to the federal NSGP now receive a second funding track:

| State | Program | Per-Site Cap |
|-------|---------|-------------|
| Illinois | NSGP-IL | $150,000 |
| California | CSNSGP | $250,000 |
| New York | NYSCAHC | $200,000 |

For these states, the snapshot includes:
- State program potential award (N locations × state cap)
- State program application deadline (last 3 confirmed dates + projected next window)
- **Combined Potential** line summing both federal and state tracks
- **Urgency Frame** sentence noting that the organization can pursue both pathways

For all other states, only the Federal NSGP track is shown with a note that no separate state program exists.

**Example (Illinois, 1 location):**
- Federal NSGP: Up to $200,000
- NSGP-IL: Up to $150,000
- Combined Potential: Up to $350,000 across both NSGP and NSGP-IL

---

## 3. Proposal Tab — Service Model Label

The first dropdown option on the Proposal tab's "Proposal Options" section was relabeled from:

> *In-House — Pre-Award & Compliance*

to:

> **Grant Writing — Pre-Award & Compliance**

This more accurately describes the service being proposed (grant writing and compliance support).

---

## 4. Pre-Award Tab Consolidation with Engagement Variant Selector

The previously separate **"Pre-Award"** and **"Pre-Award (In-House)"** tabs have been merged into a single **"Pre-Award"** tab.

Inside the Pre-Award tab, a new **Engagement Variant** dropdown at the top of the sidebar lets the rep switch between:

| Option | Description |
|--------|-------------|
| **In-House Grant Writing** *(default)* | NPSA manages grant writing, application preparation, and submission |
| **Third Party Grant Writing** | An outside grant writer prepares the applications; NPSA provides advisory & compliance support |

In-House Grant Writing is selected by default, since it is the primary offering. All existing fields, fee calculators, and letter outputs for each variant are fully preserved. The only change is that both variants are accessible from a single tab. Previously saved letters for either variant continue to load correctly.

The saved letter history browser labels previously saved documents as:
- `inh` → Pre-Award (In-House)
- `pre` → Pre-Award (Third Party)

---

## 5. Required Expiration Date Field

A new **Expiration Date** field has been added to the NPSA Authorized Signer section of the sidebar, below the existing Signing Date field.

**Applies to:** Pre-Award, Award Implementation, 3rd Party Grant Writer, and Proposal
**Does not apply to:** Addendum

### Behavior
- Starts empty by default — no expiration date is pre-filled
- The Download PDF button is **disabled** until an expiration date is entered
- A red asterisk and helper text ("Required to download or print") appear when the field is empty

### Document Output
When an expiration date is entered, an italic clause appears in the generated document above the signature block:

> *This offer expires on [date].* (Engagement Letters and Grant Writer forms)
> *This proposal expires on [date].* (Proposals)

This clause is omitted from Addendums entirely.

---

## Summary of Affected Documents

| Document Type | Action Buttons | Dual NSGP Snapshot | Expiration Date Clause |
|---------------|:--------------:|:------------------:|:----------------------:|
| Pre-Award (In-House) | — | — | ✓ |
| Pre-Award (Third Party) | — | — | ✓ |
| Award Implementation | — | — | ✓ |
| 3rd Party Grant Writer | — | — | ✓ |
| Proposal | — | — | ✓ |
| Addendum | — | — | — |
| Pre-Call Notes | ✓ | ✓ | — |
