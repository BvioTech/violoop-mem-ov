# Pure local embeddings

The existing permission-protected native socket exposes `GET /models/embeddings` (profile/readiness) and `POST /models/embeddings` (encode). Managed runtime only; an external backend returns unavailable. The endpoint reuses the existing private gateway and its bounded BGE queue, and neither imports old memory nor writes working-memory records.

Profile version 1: model `bge-m3`, 1024 dimensions, plain text format `plain-v1`, SHA256 revision of the bytes loaded into the native embedder, max batch 16, max input 4000 characters. POST requires `{version:1,model,revision,input:[...]}`. A mismatched revision fails rather than mixing caches across weights. Replacing the model file on disk while old weights remain loaded makes the endpoint unavailable until reload.

Requests are bounded, cancelled on client disconnect, and subject to the existing standby/background gate. The private gateway bearer token and URL never leave the service. A changed profile or failed encoding cannot be returned as a successful vector batch.

Run `node --test service/test/embedding_api.js service/test/background.js service/test/managed.js`. Matching PC and Edge code is needed for the product cutover; these worktree changes have not been deployed.
