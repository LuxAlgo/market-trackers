# Fixtures — the golden corpus

Each case directory contains the raw input document (`input.*`), the exact
expected parse output (`expected.json`), and a `meta.json` describing where
the document came from and whether a human verified the expected output.

Parser changes must keep every golden passing. New tricky documents get added
**with** their hand-verified output — this corpus is the project's crown
jewels; grow it deliberately.

The initial cases are format-faithful synthetic documents (marked
`"synthetic": true` in `meta.json`) so the suite runs fully offline. They are
progressively replaced/augmented with real primary-source documents fetched
via `meta.json.sourceUrl`; real documents are preferred for every new case.
