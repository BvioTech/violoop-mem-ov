# Memory model failures and recovery

Device remains the authority for provider selection and credentials. The memory
service owns only its random loopback token; migration must never persist a
provider key or select a different provider after an error.

The companion Device change removes the migration-only DeepSeek Pro override.
It follows the existing mode-scoped memory feature / medium-tier / main-model
policy, excludes the small local model for migration, and returns a `violoop`
metadata object on the OpenAI-compatible response.

The response error contains `code`, `retryable`, `action`, model/provider,
`credential_source`, and request IDs when available. The model gateway preserves
the response and `x-request-id`; migration timings retain safe correlation
metadata. The `model_error` parser also supports older SDK messages such as
`Error code: 502 - {'error': {'message': '401 Authentication Fails ...'}}`.

Authentication, billing and model-configuration errors pause the migration
before it spends requests on untouched batches. They receive no automatic
retry round. The last error and issue file retain structured repair guidance;
the source batch is unchanged. After repairing configuration, an explicit
Start retries the failed batch with a fresh durable attempt identity and then
continues pending work. Completed batches are never replayed.

Temporary connection, service and rate-limit errors keep the existing three
automatic retry rounds (10/30/60 seconds). Cancellation and standby do not
silently select another provider. No new global account circuit breaker,
credential store, database migration or package release is introduced.

Verification: `npm run test:memory-errors` covers older nested authentication
errors, structured errors, mixed success/failure batches, restart, transient
retry budgets and manual recovery without rewriting source evidence. The
Device repository adds real-SDK HTTP simulation tests. Neither test performs
real provider inference or establishes output quality.

Companion: `BvioTech/violoop-device`, branch
`fix/memory-model-contract-20261116`. Both changes are additive and can be
reviewed separately; install both for complete diagnostics and batch recovery.
