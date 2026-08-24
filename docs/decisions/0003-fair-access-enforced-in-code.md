# ADR 0003 — polite by construction: rate limits enforced in code

**Status:** accepted

Docket depends on the continued goodwill of free public endpoints. Politeness is therefore not
documentation — it is construction:

- **Strict sliding-window limiter** (`lib/rate-limiter.ts`): never more than N requests in any
  rolling window. Chosen over a classic token bucket deliberately: a bucket of capacity 10
  refilling at 10/s permits 20 requests in the first rolling second (burst + refill), which
  violates the invariant as SEC fair access states it. The unit test proves the rolling-window
  property with a virtual clock.
- **One limiter per source per process**, shared by construction (the EDGAR client owns its
  limiter; everything EDGAR goes through one client), so concurrency cannot multiply rates.
- **Mandatory declared User-Agent** for EDGAR — the client won't construct without a contact,
  and the CLI explains why instead of defaulting to anonymity.
- **Automatic backoff** on 403/429/5xx with exponential waits (EDGAR blocks abusive IPs for
  ~10 minutes; the client slows down long before that), and 404s pass through un-retried
  (they're data: holidays, unpublished days).
- **Conditional-GET plumbing** (`fetch_cache` table) so repeat fetches of index files can be
  ETag-cheap.

Sync is sequential across sources by default — rate limits are per-origin so parallel would
still be polite, but sequential keeps failure attribution and logs readable, and the bottleneck
is the limiter anyway.
