---
name: Source drift / parse failure
about: A primary source changed its format, endpoint, or behavior
title: "[drift] <source>: <what changed>"
labels: ["source-drift"]
---

**Source:** <!-- edgar | senate-efd | house-clerk | usaspending | lda | finra -->

**What changed?**
<!-- New endpoint shape, moved URL, new document layout, parse failures, canary red, … -->

**Evidence**
<!-- Canary report excerpt, a failing document URL, or a diff of the format. -->

**A document that reproduces it**
<!-- The primary-source URL. If the parser now misparses it, this document should become a
     golden fixture with hand-verified expected output as part of the fix. -->
