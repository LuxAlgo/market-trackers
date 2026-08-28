# ADR 0004 — FINRA OTC Transparency (ATS/non-ATS) data: do not ship

**Status:** accepted

**Question:** can FINRA's OTC Transparency data — weekly per-symbol, per-ATS equity volume
(Rule 4552) and non-ATS ("de minimis") OTC volume — be ingested by an `market-trackers` source **and**
republished, unmodified, in this project's CC0-1.0 dumps (see `data-licenses/README.md`)?

This is scoped narrowly to that one FINRA product. It is **not** about the FINRA data this
project already ingests: `sources/finra-shortvol` pulls Reg SHO daily short-sale-volume files
from `cdn.finra.org/equity/regsho/daily/…` — plain daily text files, a different product with no
comparable vendor-agreement gate (see `docs/sources/finra-shortvol.md`). Nothing here changes
that source's standing or its CC0 treatment. This ADR also does not implement anything — no
ATS/OTC-Transparency source exists in this codebase, and this decision is why.

## Context

Market Trackers's CC0 dumps are built on the premise that the underlying records are public and the
project adds no editorial content — see `data-licenses/README.md`. That premise only holds if
the upstream source's own terms actually permit redistribution; it doesn't hold by default just
because a regulator "publishes" something. OTC Transparency looked like a plausible next source
(weekly dark-pool/ATS volume by symbol is exactly the kind of "public record" this project
tracks), so the question was whether FINRA's terms for it clear that bar. This investigation used
WebSearch only (no direct fetch of finra.org succeeded from this environment — see
"Verification" below); everything quoted was surfaced via search result summaries and titles, not
by fetching full page text, so treat page-level nuance beyond what's quoted here as unverified.

## Findings (quoted)

**The regulatory mandate and free public display.** FINRA Rule 4552, effective May 12, 2014,
requires each ATS to report weekly volume and trade-count information by security; FINRA in turn
publishes it. Per search results summarizing FINRA's own regulatory notices and the OTC
Transparency pages:

> "FINRA makes the reported volume and trade count information for equity securities publicly
> available on its website, publishing the reported information in each equity security for each
> ATS for each week." … "The data is made freely available to the public on FINRA's website."

— synthesized from [Regulatory Notice 15-48](https://www.finra.org/rules-guidance/notices/15-48),
[OTC (ATS & Non-ATS) Transparency](https://www.finra.org/filing-reporting/otc-transparency), and
the [ATS Transparency – Phase 1](https://www.finra.org/filing-reporting/otc-transparency/ats-transparency-phase-1)
page (accessed via WebSearch, 2026-08-25). This confirms free **viewing** on FINRA's own site —
which is the "free to view" case the decision rule below treats as insufficient on its own.

**FINRA's general website Terms of Use** (applies site-wide absent a more specific agreement):

> "shall be used only for your own non-commercial personal or professional use" … "no copying,
> redistribution, retransmission, publication or commercial exploitation of downloaded material
> will be permitted without the express written permission of FINRA and, if applicable, the owner
> of any exclusive proprietary rights in such material."

— [Terms of Use](https://www.finra.org/terms-of-use) (accessed via WebSearch, 2026-08-25). This is
the "non-commercial" / "written permission required" case the decision rule treats as a DO NOT
SHIP signal by itself.

**The OTC Transparency page's own note**, per search synthesis:

> "attribution must be given to FINRA, while information is periodically updated with no guarantee
> of accuracy, and any action taken is strictly at the user's own risk."

— [OTC (ATS & Non-ATS) Transparency](https://www.finra.org/filing-reporting/otc-transparency)
(accessed via WebSearch, 2026-08-25). "Attribution required" is itself listed in the decision rule
as a DO NOT SHIP signal, independent of everything else found.

**Bulk/file/API access sits behind a bilateral vendor agreement, not the general website.**
Downloading the weekly files in bulk (rather than viewing them one symbol at a time) requires
accepting an agreement gate, and "professional users and vendors must return to FINRA a fully
executed agreement prior to downloading the ATS Transparency data" — the **FINRA ATS Transparency
Data Vendor Agreement**:

> "Authorized Use is limited to accessing, receiving, using, processing, manipulating, creating
> derivative works, storing, transmitting and disseminating the Data through Vendor's Service to
> Clients and Subscribers pursuant to a valid ATS Transparency Data Subscriber Agreement or as
> otherwise provided for herein. Any use of the Data, by a Vendor, unless expressly described in
> this Agreement or a FINRA approved Attachment B, is prohibited."
>
> "All ATS Information and Data, including all intellectual property rights inherent therein or
> appurtenant thereto, shall be the sole and exclusive property of FINRA, and FINRA reserves any
> right to the System and the ATS Information and Data not explicitly granted herein."

— [FINRA Transparency Services ATS Data Vendor Agreement](https://www.finra.org/sites/default/files/AppSupportDoc/p526737.pdf)
(accessed via WebSearch, 2026-08-25). Redistribution under this agreement is only to the vendor's
_own_ subscribers, each bound by _their own_ separate Subscriber Agreement with FINRA — the
opposite of an unrestricted, public, CC0-style republication to anyone.

**The one redistribution carve-out is narrow and discretionary.** The Vendor Agreement's "Derived
Data" guidelines:

> "Vendors may distribute 'Derived Data' … externally without fee liability." Derived Data "means
> data that is derived from ATS Data and that is not able to be reverse engineered by a reasonably
> skilled user into ATS Data or used as a surrogate," and "FINRA will determine in its sole
> discretion whether the proposed distribution properly qualifies as Derived Data."

— [ATS Data Transparency Derived Data Guidelines](https://www.finra.org/sites/default/files/AppSupportDoc/p549764.pdf)
(accessed via WebSearch, 2026-08-25). Republishing the weekly per-symbol/per-ATS volume figures
themselves — exactly what an `market-trackers` dump would do — is a "surrogate" for the underlying data
by construction, not a one-way-transformed derivative, so this carve-out would not obviously
cover it even before reaching FINRA's discretionary sign-off.

**Historical-charging context.** Bulk ATS Transparency data has required a signed vendor/
subscriber agreement since at least the "ATS Transparency – Phase 1" rollout (2014-era Rule 4552
implementation) through the current OTC Transparency product — search results did not surface a
specific point where FINRA dropped a _dollar fee_ for this specific dataset (as distinct from the
free public _viewing_ that has existed alongside the gated bulk path throughout). What's
consistent across every source found, from 2014-era documents through the current Vendor
Agreement, is the _contractual_ gate on bulk/redistributable access — that has not gone away even
as the free-to-view website matured (new Historical Data API in 2021, etc.).

## Decision

**Do not ship.** No ATS/OTC-Transparency source is implemented, and none should be added under
the terms found above.

Applying this project's rule plainly: redistribution in public-domain-equivalent (CC0) dumps must
be **clearly permitted in writing**; "free to view," "with attribution," "non-commercial," or
unclear terms all mean _don't ship_. Every one of those disqualifying conditions is independently
present here — free-to-view (website only), attribution-required (OTC Transparency page), and
non-commercial/written-permission-required (general Terms of Use) — and the one path that
contemplates redistribution (the Vendor Agreement's "Derived Data" carve-out) is itself gated
behind a bilateral contract, FINRA's sole discretion, and a definition that a straight
ingest-and-republish of the weekly figures likely doesn't satisfy in the first place.

## Consequences

- No `sources/otc-transparency` (or similarly named) source exists, and none should be scaffolded
  even as an unimplemented placeholder until the licensing position changes — a placeholder
  invites exactly the "just wire it up" follow-on that this ADR is meant to prevent.
- Anyone who wants **their own dashboard, alert, or one-off analysis** from this data still can:
  FINRA's public website displays it for free, per-symbol, per-ATS, per-week. That use is
  unaffected by this decision — the decision is specifically about **this project ingesting it
  and republishing it in the CC0 dumps**.
- **What would change this decision:** written confirmation — from FINRA directly, or a
  successor/updated version of the pages and agreements quoted above — that either (a) the weekly
  ATS/non-ATS volume-and-trade-count figures themselves may be redistributed under an open license
  (CC0, CC-BY, or an explicit public-domain dedication) without a bilateral Subscriber Agreement
  gating each downstream recipient, the way SEC EDGAR, USAspending, PatentsView, ClinicalTrials.gov,
  and openFDA already are for the sources this project does ingest; or (b) this project executes
  the ATS Transparency Data Vendor Agreement _and_ obtains a FINRA-approved Attachment B that
  explicitly designates full, unrestricted (CC0-compatible) redistribution of the raw weekly
  figures as approved "Derived Data" use, with that approval itself in writing and cited in a
  revision of this ADR. Absent either, the answer stays no.
- **Honesty over confidence:** this used WebSearch only — no direct fetch of finra.org succeeded
  from this environment (the network egress proxy blocks the domain), so every quote above is a
  search-result/snippet rendering of the underlying PDFs and pages, not a full read of them.
  Treat this ADR as "could not fully verify beyond what's quoted; default deny" rather than a
  definitive legal reading of FINRA's complete terms. That default-deny outcome is itself the
  correct, conservative answer to ship with — not a placeholder for someone to firm up later.

### Verification

- WebSearch only; WebFetch against `www.finra.org` returned `EGRESS_BLOCKED` from this container
  every time it was tried. All URLs above are cited as found by WebSearch on 2026-08-25; re-verify
  directly against finra.org before relying on this for anything beyond this project's own
  ship/no-ship call.
