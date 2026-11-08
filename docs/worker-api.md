# Locke worker API — `locke-worker/1`

How a GPU worker (first partner: **windows-pilot**, which drives Fooocus and FaceFusion) takes Locke jobs and
returns results. The worker **pulls**: it only makes outbound HTTPS calls to Locke and opens no port.

Status (2026-11-08): **v1, frozen for `face_swap`, implemented in Locke** (tested end to end, `test/e2e.mjs`; rate limits not enforced yet); `generate`, `enhance` and `blur` parameters are drafts
and may change before those types go live. Test first against the
mock server and the test vectors in [`worker-api/`](worker-api/), then against Locke with a `test` worker.

| File | What it is |
|---|---|
| [`worker-api/locke-worker-crypto.mjs`](worker-api/locke-worker-crypto.mjs) | Reference implementation of §4 (Node ≥ 20, no dependencies). |
| [`worker-api/vectors.json`](worker-api/vectors.json) | Test vectors for §4. `node vectors.mjs` checks them (also cross-checked with Python `cryptography`). |
| [`worker-api/mock-server.mjs`](worker-api/mock-server.mjs) | Mock of this API serving fake `face_swap` jobs, with real encryption. |
| [`worker-api/example-worker.mjs`](worker-api/example-worker.mjs) | Minimal worker client (its "engine" returns the image unchanged). |

---

## 0. Conventions

- **Base URL:** `https://locke.home-warlock.com/apps/locke/api/worker/v1`. Mock: `http://<host>:8787/apps/locke/api/worker/v1`.
- **Auth:** every call sends `Authorization: Bearer <worker key>`. Send the key only to the configured base URL and
  don't follow redirects. `User-Agent: windows-pilot/<version> (locke-worker/1)`.
- **Bodies:** JSON (`application/json`, UTF-8), except inputs and results, which are raw bytes
  (`application/octet-stream`).
- **Binary in JSON:** base64url **without padding** (RFC 4648 §5).
- **Times:** RFC 3339, UTC, milliseconds: `2026-11-08T12:00:00.000Z`.
- **Ids** (`wrk_…`, `job_…`, `lse_…`, `in_…`, `ch_…`): opaque, random, match `^[A-Za-z0-9_-]{1,64}$`. They reveal
  nothing about the user or the content.
- **Errors:** any non-2xx response has the body `{"error": "<code>"}` (some add fields). See §6.3.
- **Compatibility:** ignore unknown JSON fields. A breaking change gets a new path (`/v2`).

## 1. Identity and keys

### 1.1 Worker key (bearer)
- A Locke admin creates the worker in Locke (Settings → GPU workers). Locke shows the **worker id** and the
  **worker key** once. Format: `lkw_` + 43 base64url characters. Locke stores only a hash.
- The operator copies the key into the worker's secret store (for windows-pilot: a Docker secret file). It's never
  sent through a chat or ticket.
- The key allows only the endpoints in §3. Revoking it in Locke takes effect immediately (`401`).
- **Rotation:** the admin issues a new key and the old one stops working. The worker generates a new key pair on
  rotation (§1.2).
- A worker is created in mode **`test`** (receives only test jobs, §7.3) or **`live`**. Start in `test`.

### 1.2 Worker key pair (encryption)
- On first start the worker generates an **X25519** key pair. The private key never leaves the worker. The public
  key (32 raw bytes, base64url) is sent in `hello`.
- **Storage at rest:** encrypted. For a Linux container where DPAPI isn't available, this is accepted as equivalent:
  the worker key is a Docker secret file; the private key is stored in a Docker volume, AES-256-GCM encrypted with
  a key derived by HKDF-SHA256 from the worker key (random 16-byte salt stored next to it,
  info `"windows-pilot key-store"`). Consequence: a new worker key means a new key pair, which is what §1.1 asks.
- **Fingerprint:** first 8 bytes of SHA-256(public key) in hex, groups of 4 (`cf4b d6f8 b729 19c5`). Both Locke and
  the worker show it so the operator can compare them.
- **Trust:** the first public key presented with a newly issued worker key is trusted. Any later change puts the
  worker in `pending_approval`: Locke sends no job until an admin approves the new fingerprint.

## 2. Presence and states

Locke shows the worker to users as:

| State | Condition |
|---|---|
| **online, idle** | an authenticated call within `offlineAfterSeconds` (60 s), accepting, no job |
| **busy** | holds a lease |
| **paused** | last `hello`/`heartbeat` said `accepting: false` (e.g. the GPU is used by something else). Users see "GPU busy with other tasks, your jobs will wait". |
| **offline** | no call for 60 s |
| **key pending** | public key changed, waiting for admin approval |

- A worker **may stay paused for as long as it wants**. Jobs wait in the queue (`waiting_for_gpu`); nothing expires
  because of it.
- A pending `claim` (long poll) counts as presence. When the worker isn't claiming, it sends `heartbeat` every
  `heartbeatSeconds` (30 s).
- `claim` means accepting. `heartbeat {accepting:false}` means "temporarily not accepting jobs".

## 3. Endpoints

### 3.1 `POST /hello`
Call it at start, after a `401` once the key is fixed, and whenever capabilities change. Idempotent; at most once
a minute (use `heartbeat` for presence).

Request:
```json
{
  "protocol": "locke-worker/1",
  "software": { "name": "windows-pilot", "version": "1.4.0" },
  "publicKey": "PmPABaAOeWJFFXQYKgQB6IlXkRN4jlQ3JoV9aQ8cxj0",
  "gpu": { "name": "NVIDIA GeForce RTX 4070", "vramMb": 12282 },
  "accepting": false,
  "capabilities": {
    "maxConcurrency": 1,
    "resultFormats": ["png", "jpeg"],
    "faceSwap": {
      "maxCharacters": 2,
      "maxFacesPerCharacter": 8,
      "genders": ["any", "woman", "man"],
      "ages": ["any", "young", "adult", "senior"],
      "ageAliases": { "young": "adult" },
      "distinctFilters": true
    },
    "generate": null,
    "enhance": null,
    "blur": null,
    "edit": null
  }
}
```

Capabilities:
- A job type that is `null` or absent is **not supported**: Locke never sends it to this worker.
- `genders` / `ages`: the values this worker handles. Locke never sends a character with another value.
  Values: genders `any | woman | man`; ages `any | child | teen | young | adult | senior`.
- `ageAliases`: ages the worker treats as another one. Locke applies them before checking overlaps.
- `distinctFilters: true`: the worker can't have two characters competing for the same face. Locke then never sends
  two characters whose filters overlap (§5.2).
- `maxCharacters`, `maxFacesPerCharacter`: upper bounds Locke respects.
- When no registered worker supports what a user asks for (e.g. a Teen character), Locke refuses it **at submit
  time** with a clear message ("No GPU worker supports this face swap") rather than queueing it forever.
- `maxConcurrency`: jobs the worker can hold at once. Locke uses `min(worker, Locke setting)`.

Response `200`:
```json
{
  "workerId": "wrk_8Jq2…",
  "keyStatus": "active",
  "mode": "test",
  "fingerprint": "cf4b d6f8 b729 19c5",
  "serverTime": "2026-11-08T12:00:00.000Z",
  "settings": {
    "claimWaitMaxSeconds": 30,
    "heartbeatSeconds": 30,
    "offlineAfterSeconds": 60,
    "leaseSeconds": 60,
    "progressIntervalSeconds": 15,
    "maxConcurrency": 1,
    "maxInputBytes": 26214400,
    "maxResultBytes": 26214400,
    "maxJobSeconds": { "face_swap": 600, "generate": 1800, "enhance": 600, "blur": 300 }
  }
}
```
`keyStatus`: `active | pending_approval`. While pending, `claim` returns `403 key_pending`. `mode`: `test | live`.
Errors: `400 unsupported_protocol | invalid_public_key | invalid_capabilities`.

### 3.2 `POST /heartbeat`
Request `{"accepting": true}` → `200 {"keyStatus": "active", "queued": 3, "serverTime": "…"}`.
`queued` = jobs waiting that this worker could take (a count only). windows-pilot can use it to decide when to
switch the GPU to FaceFusion.

### 3.3 `POST /jobs/claim`
Long poll. Request (all optional):
```json
{ "waitSeconds": 30, "types": ["face_swap"] }
```
- `waitSeconds`: 0–`claimWaitMaxSeconds`. Use an HTTP timeout of `waitSeconds + 15` s.
- `types`: only these job types (e.g. only what the currently loaded engine does). Default: all supported types.

Responses:
- `204` (no body): nothing within the wait. Claim again.
- `200`: one job, now leased to this worker:

```json
{
  "jobId": "job_test_0001",
  "leaseId": "lse_Qm9v…",
  "leaseExpiresAt": "2026-11-08T12:01:00.000Z",
  "deadlineAt": "2026-11-08T12:10:00.000Z",
  "attempt": 1,
  "maxAttempts": 3,
  "type": "face_swap",
  "envelope": {
    "alg": "X25519-HKDF-SHA256/A256GCM",
    "epk": "k0SAccpEjdHoKzA9T1uRBYEgdUL_JhY9LFmryY4Q_Bg",
    "wrappedKey": "eCdsr5y1LNGgUIqGdW1t-4-dQS_fiyeWjHyAFQewypu4y8ZvyEpP83991ISt9dDiOK3P6Gby4h4FnLgv"
  },
  "params": "<base64url sealed blob, §4.3>",
  "inputs": [ { "id": "in_test_target", "bytes": 2483021 }, { "id": "in_test_face1", "bytes": 312844 } ],
  "maxResults": 1
}
```
- `params` is inline (small). Inputs are fetched separately (§3.4). `bytes` is the encrypted size.
- `type` is also inside the params; if they differ, fail with `invalid_input`.
- `deadlineAt`: the lease can't be renewed beyond it (`maxJobSeconds` for the type).
- Errors: `409 hello_required` (no `hello` since the key was issued), `409 concurrency_limit`, `403 key_pending`,
  `403 worker_disabled`.

### 3.4 `GET /jobs/{jobId}/inputs/{inputId}`
Header `X-Locke-Lease: <leaseId>`. `200` body: the sealed input (raw bytes, §4.3). Can be fetched again during the
lease. Errors: `409 lease_lost`, `404 job_not_found | input_not_found`.

### 3.5 `POST /jobs/{jobId}/progress`
Request `{"leaseId": "lse_…", "progress": 0.4}` (`progress` 0–1, or `null` if unknown).
Response `200 {"leaseExpiresAt": "…", "cancel": false}`.
- Send it every `progressIntervalSeconds` (15 s); every 10 s is fine, not more often than every 5 s.
- Every lease-bound call (progress, input download, result upload) renews the lease to
  `now + leaseSeconds`, capped by `deadlineAt`.
- `cancel: true` (the user cancelled): stop, wipe the job's data, then send `fail` with `cancelled`.
- **Lease lost:** `409 lease_lost` (expired, given to another attempt, or cancelled and released) or
  `404 job_not_found`. Stop immediately, wipe, and send **nothing** more for this job.

### 3.6 `PUT /jobs/{jobId}/results/{n}`
Header `X-Locke-Lease: <leaseId>`, `Content-Type: application/octet-stream`. Body: the sealed result (raw bytes,
§4.3). `n` = 1…`maxResults`, decimal.
- Plaintext: a **PNG or JPEG** (the params' `output.format` when given). **No metadata:** no EXIF/XMP/comments, no
  PNG `tEXt`/`iTXt`/`zTXt`/`eXIf` chunks. Fooocus writes the prompt into PNG text chunks by default: strip them.
  Locke rejects a result that carries metadata.
- Size: at most `maxResultBytes` (25 MiB) encrypted.
- `face_swap` and `blur` keep the input's pixel dimensions.
- Uploading the same `n` again replaces it (use a fresh nonce).
- Response `200 {"n": 1, "bytes": 2483021}`. Errors: `413 too_large`, `409 lease_lost`, `400 invalid_result_number`,
  `422 decrypt_failed | unsupported_format | metadata_present`.

### 3.7 `POST /jobs/{jobId}/complete`
Request `{"leaseId": "lse_…", "resultCount": 1}`. Locke checks that results 1…`resultCount` are present and valid.
Response `200 {}`. Idempotent: repeating it with the same lease returns `200`.
Error `422 missing_result {"n": 1}`: upload it and complete again, or `fail`.

### 3.8 `POST /jobs/{jobId}/fail`
Request:
```json
{ "leaseId": "lse_…", "code": "out_of_memory", "retryable": true, "stage": "engine" }
```
- `stage` (optional): `params | download | engine | upload`.
- **No free-text message.** Free text could leak a prompt or a file name.

| `code` | Meaning | Usual `retryable` |
|---|---|---|
| `unsupported` | asked for something this worker can't do (shouldn't happen, §3.1) | false |
| `invalid_input` | params or an input image unreadable or inconsistent | false |
| `decrypt_failed` | envelope, params or input doesn't decrypt (Locke alerts the admin) | false |
| `no_face_found` | no face in the image matches any character | false |
| `out_of_memory` | GPU out of memory | true |
| `model_missing` | a model or file the engine needs is missing | false |
| `engine_unavailable` | engine crashed or became unavailable after the claim | true |
| `timeout` | the work couldn't finish before `deadlineAt` | true |
| `cancelled` | after `cancel: true` | false |
| `internal` | anything else | true |

**Retries:**
- `retryable: true`: Locke re-queues the job (after 30 s, then 2 min) up to `maxAttempts` (3) attempts in total,
  then marks it failed with the last code.
- An expired lease (worker vanished) counts as an attempt.
- `retryable: false` fails the job at once; `cancelled` is never retried.
- A retried job keeps its `jobId` with a new lease and envelope.

## 4. Encryption

HTTPS is not enough: Cloudflare terminates TLS in front of Locke. So every job is encrypted end to end between
Locke and the worker.

### 4.1 Job key envelope (`alg` = `X25519-HKDF-SHA256/A256GCM`)
Locke creates a random 32-byte **job key** per job and seals it for the worker's public key when the job is claimed:

1. Locke generates an ephemeral X25519 key pair; `epk` = its 32-byte public key.
2. `shared = X25519(ephemeral private, worker public)`. **Reject** an all-zero `shared`.
3. `kek = HKDF-SHA256(IKM = shared, salt = epk ‖ workerPublicKey (64 bytes), info = UTF-8 "locke-worker/v1 job-key", L = 32)`.
4. `wrappedKey = AES-256-GCM(kek, jobKey, AAD = UTF-8 "locke/v1|{jobId}|job-key")` in the blob format of §4.2
   (12 + 32 + 16 = 60 bytes).

The worker reverses it:
- `shared = X25519(worker private, epk)`;
- the same HKDF;
- open `wrappedKey` with the same AAD;
- check that the job key is 32 bytes.

### 4.2 Blob format
`nonce (12 random bytes) ‖ ciphertext ‖ GCM tag (16 bytes)`, AES-256-GCM.
- Base64url when inside JSON (`params`, `wrappedKey`); raw bytes when it's an HTTP body (inputs, results).
- Never reuse a nonce: draw a fresh random one for every blob, re-uploads included.

### 4.3 What is sealed with the job key
| Blob | Sealed by | AAD (UTF-8, exact) |
|---|---|---|
| params (JSON, UTF-8) | Locke | `locke/v1\|{jobId}\|params` |
| each input | Locke | `locke/v1\|{jobId}\|input\|{inputId}` |
| result `n` | worker | `locke/v1\|{jobId}\|result\|{n}` (`n` decimal, no leading zero) |

The AAD binds each blob to its job and role: a blob replayed into another job or slot fails to decrypt. Wipe the
job key from memory when the job ends.

### 4.4 Test vectors
[`worker-api/vectors.json`](worker-api/vectors.json) gives:
- a fixed worker key pair and its fingerprint;
- the ephemeral key and the envelope;
- the job key, sealed params and a sealed input, with their plaintexts;
- a result with a fixed nonce and its expected sealed bytes;
- two cases that must fail (wrong job id in an AAD).

Values are base64url, or hex when the field name ends in `Hex`.

## 5. Job parameters (decrypted `params`)

Common fields: `"v": 1`, `"type"`, and `"output": {"format": "png" | "jpeg"}` (optional, default `png`).
Test jobs add `"test": true` (§7.3); process them normally.

### 5.1 `face_swap` (v1, frozen)
```json
{
  "v": 1,
  "type": "face_swap",
  "image": "in_target",
  "match": "largest",
  "characters": [
    { "ref": "ch_1", "faces": ["in_f1", "in_f2"], "mainFace": "in_f1", "gender": "woman", "age": "adult" },
    { "ref": "ch_2", "faces": ["in_f3"], "mainFace": "in_f3", "gender": "man", "age": "any" }
  ],
  "output": { "format": "png" }
}
```

**Fields:**
- `image`: input id of the picture to modify. The job produces **one** result with the same dimensions.
- `characters`: 1…`maxCharacters`.
  - `ref` is opaque and per job. A character's name is never sent.
  - `faces`: 1…`maxFacesPerCharacter` input ids. Each is a photo of that character cropped to one face. If a
    photo still holds several faces, use the largest.
  - `mainFace`: one of `faces`, the user's preferred and best photo. Using it first and building one identity from
    all the photos (FaceFusion's multi-source reference) is exactly the intent. If only one photo can be used, use
    `mainFace`.
  - `gender`, `age`: which faces in the image this character replaces, judged on each detected face's apparent
    gender and age. `any` = no constraint on that axis. Only values the worker declared are sent.
- `match`: `largest` (the only value in v1). Each character replaces the **largest** face that matches its filters
  (FaceFusion: selector mode "one", order large → small, gender/age filters).

**Outcomes:**
- At least one face replaced → complete.
- No face matches any character → `fail no_face_found`.
- Some characters matched and others didn't → complete.
- Faces the worker's own policy excludes (e.g. a face detected as a minor when the character's age is `any`) are
  left untouched. That isn't an error.

### 5.2 Overlapping characters
After applying `ageAliases`, two characters **overlap** when both hold:
- their genders are equal or one is `any`;
- their ages are equal or one is `any`.

With `distinctFilters: true`, Locke never sends overlapping characters: it tells the user at submit time ("Give
these characters different gender or age"). The worker still answers `unsupported` if it receives some.

### 5.3 `enhance` (draft)
```json
{ "v": 1, "type": "enhance", "image": "in_…", "strength": "balanced", "output": { "format": "png" } }
```
`strength`: `subtle | balanced | strong`. One result; it may upscale up to `capabilities.enhance.maxScale`.
Capability: `"enhance": { "strengths": ["subtle", "balanced", "strong"], "maxScale": 2 }`.

### 5.4 `blur` (draft)
```json
{ "v": 1, "type": "blur", "image": "in_…", "strength": 60, "output": { "format": "png" } }
```
- **Background** blur: the subject stays sharp.
- `strength` is an integer 0–100: 0 = no visible blur, 100 = the worker's strongest. A linear mapping to the engine's
  blur radius is fine.
- Same dimensions as the input. Capability: `"blur": {}`.

### 5.5 `generate` (draft)
```json
{
  "v": 1, "type": "generate",
  "positive": ["a woman reading by a window", "golden hour"],
  "negative": ["blurry", "extra fingers"],
  "style": "photo-cinematic",
  "aspect": "portrait",
  "count": 2,
  "mode": "quality",
  "references": ["in_r1", "in_r2"],
  "character": { "ref": "ch_1", "faces": ["in_f1"], "mainFace": "in_f1" },
  "seed": null,
  "output": { "format": "png" }
}
```

**Style presets belong to the worker.** It lists them in
`"generate": { "styles": [ { "id": "photo-cinematic", "label": "Photography" } ], "counts": [1, 2, 3, 4] }`, and
Locke shows exactly those in Create. So there's nothing to map.

Other fields:
- `positive` / `negative`: the enabled prompt fragments, in order. Join them with `", "`.
- `aspect`: `square | portrait | landscape`. The worker picks the resolution (e.g. SDXL 1024², 896×1152, 1152×896).
- `count` = number of results (1–4) = `maxResults`.
- `mode`: `fast | quality`.
- `references`: 0–4 ordered input ids (image prompts).
- `character`: optional. Apply that face to the generated person. How (image prompt, or a face swap afterwards) is
  up to the worker.
- `seed`: an integer, or `null` for random.

### 5.6 `edit`
Not in v1. Locke never sends it.

## 6. Operations

### 6.1 Network
- No Cloudflare Access policy on the worker path today; no extra headers needed.
- If one is added later, Locke will issue a Cloudflare service token. Make extra request headers
  (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) configurable now; they are secrets, so store them like the
  worker key.

### 6.2 Limits
| | |
|---|---|
| Claim long poll | ≤ 30 s |
| Lease | 60 s, renewed by each lease-bound call |
| Progress | every 15 s (10 s fine, ≥ 5 s) |
| Max job duration | `maxJobSeconds` (face_swap 10 min) |
| Input / result size | ≤ 25 MiB each, encrypted |
| Inputs per face_swap job | 1 + up to 8 per character |
| Rate limit | 120 requests/min per worker → `429` with `Retry-After` |

### 6.3 Error handling
| Response | Worker does |
|---|---|
| `401 invalid_key` | Key revoked or wrong. Stop all Locke activity and wipe any job. Show "Locke key rejected" in windows-pilot. Retry `hello` at most every 15 min, or when the operator replaces the key. |
| `403 key_pending` | Show the fingerprint and "approve it in Locke". `hello` every 60 s, no claim. |
| `403 worker_disabled` | Disabled by an admin. Like paused: `heartbeat` every 60 s. |
| `409 lease_lost`, `404 job_not_found` (job calls) | Abandon the job silently and wipe it. |
| `409 concurrency_limit` | You already hold a job; finish it first. |
| `429` | Wait `Retry-After` seconds. |
| `5xx`, network error, timeout | Exponential back-off with full jitter: 1, 2, 4, 8, 16, 32, then 60 s cap; reset after a success. During a job, keep working and retry the call while the lease lasts. If the lease expires during the outage, the job is lost (Locke re-queues it): wipe it. |

### 6.4 Privacy rules (non-negotiable)
- Decrypt params and inputs only in memory, or in a per-job temp folder that is deleted when the job ends. Also
  delete it on failure, and at the next start after a crash.
- Fooocus and FaceFusion keep no copy: output, history and log folders redirected or disabled for Locke jobs; no
  metadata embedding.
- Logs may contain:
  - job ids, input ids, attempt and type;
  - timings and sizes;
  - HTTP statuses and error codes.

  Never: params, prompts, images, the worker key, the private key or job keys.
- Never show Locke jobs or their images in windows-pilot's own UI or history. Status only, e.g.
  "Locke worker: online, idle / running a job".
- No telemetry, and no crash dumps containing job data.

## 7. Testing

### 7.1 Crypto
Check your implementation against `vectors.json` first. Reference: `node docs/worker-api/vectors.mjs`.

### 7.2 Mock server
```sh
cd docs/worker-api
docker run --rm -p 8787:8787 -v "$PWD:/m:ro" -e MOCK_WORKER_KEY=lkw_test -e MOCK_IMAGES=/m/images -e MOCK_OUT=/tmp \
  node:22-alpine node /m/mock-server.mjs
```

What it does:
- Serves 3 `face_swap` jobs at start. `MOCK_IMAGES` is an optional folder with `target.png|jpg` and
  `face1…face8.png|jpg`; without it, the inputs are a 1×1 PNG.
- Validates bodies, leases and results: it decrypts each result and checks the format and metadata.
- From a container, reach it at `http://host.docker.internal:8787/apps/locke/api/worker/v1`.

More jobs, same bearer key:
```sh
curl -XPOST -H 'Authorization: Bearer lkw_test' 'http://localhost:8787/mock/enqueue?scenario=two_characters'
```
- Scenarios: `basic`, `two_characters`, `cancel` (`cancel: true` on the 2nd progress), `bad_params`.
- `GET /mock/state` lists jobs and their outcome.
- `example-worker.mjs` runs the whole flow against it.

### 7.3 Test jobs on the real Locke
Once the API is live, the admin creates the worker in **`test`** mode and uses "Send a test job" in Locke:
- It queues a `face_swap` job built from synthetic images, with `"test": true` in params.
- Only the admin sees the result, then it's discarded.
- A `test` worker never receives user jobs. Switch it to `live` in Locke when ready.
