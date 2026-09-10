# Relay Shield wire contract (version 2)

This PSK protocol authenticates the two endpoints and encrypts RPC payloads even when the Hub knows every Hub credential and controls delivery. It does not provide forward secrecy: later disclosure of the pairing master secret exposes recorded sessions. The Hub can deny service and observe routing, timings, sizes and request identifiers. Endpoint compromise and malicious code running with endpoint privileges are outside this boundary.

The shared implementation is [relay-crypto.js](../../extension/relay-crypto.js). This prototype must receive independent protocol review before live RPC integration. Self-review and interoperability results are recorded below; they are not a claim of external cryptographic audit.

## Pairing and derivation

The extension creates a fresh, uniformly random 32-byte master secret with `crypto.getRandomValues`; it never sends that secret or the driver ID to the Hub. The user transfers the complete driver ID out of band. Hub URLs, HTTP headers, logs and WebSocket messages must receive only the separately derived Hub token. Revocation requires a fresh master secret, not a new route around an existing secret.

`B64` means canonical RFC 4648 base64url without padding. `J` means UTF-8 encoding of ECMAScript `JSON.stringify` output. All cryptographic structures below are arrays in the specified order; received object property order has no cryptographic significance. Every protocol binary field uses B64. Origin is an exact URL origin, without path, query, credentials or trailing slash: HTTPS, or HTTP only for localhost, 127.0.0.1 and [::1]. Integration must check the actual selected transport origin against the paired origin before connecting; transcript binding alone cannot inspect a transport.

`K(label, context) = HKDF-SHA256(IKM=master, salt=J(["bro-relay",2,origin]), info=J([label,context]), length=32 bytes)`.

Hub token is `B64(K("hub-auth",null))`. Route is the first 16 characters of `B64(SHA256(UTF8(hubToken)))`, preserving the Hub's token-to-route ownership check. Driver ID is `br2.` followed by `B64(J([origin,route,B64(master)]))`. Pairing parsing rejects legacy `br-` IDs with a re-pair instruction; it cannot upgrade a secret already known to the Hub. Endpoint constructors verify the route against the derived Hub token. Parsing alone validates encoding and structure, not this derivation.

## Authenticated session

Client sends `{v:2,route,origin,client}`, where `client` is a fresh 32-byte challenge. Device instances create a fresh 32-byte `epoch` on startup and every reconnect. Each accepted hello creates an independent fresh 32-byte `nonce`. The transcript is:

`T = ["bro-relay",2,origin,route,client,epoch,nonce]`.

The device returns `{v:2,epoch,nonce,proof}` with `proof = B64(HMAC-SHA256(K("endpoint-auth",T),J(["device",T])))`. The client verifies this before returning `{v:2,nonce,proof}` with the analogous `J(["client",T])` proof. The device accepts the final message only against its own unexpired pending state and consumes that state once, including failed authentication attempts. No executor may receive a request before this client proof succeeds.

Session ID is `B64(SHA256(J(T)))`. Directional AES-256-GCM keys are `K("aead-client",T)` and `K("aead-device",T)`. Distinct role labels prevent reflection. Fresh client challenges prevent replayed device challenges from completing new client handshakes. Fresh device epoch and per-handshake nonce prevent an old client proof from completing after reconnect, even when the Hub replays the old hello. A duplicate hello creates a different pending handshake, never recreates an old session.

## Envelopes, nonces and replay

Envelope fields are exactly `{session,direction,requestId,sequence,ciphertext}`. Direction is `client` for requests and `device` for responses. Request ID is 1–128 ASCII letters, digits, underscore or hyphen. Sequence is a nonnegative JSON integer below the message limit. Each sender starts at zero and reserves/increments synchronously before awaiting encryption; encryptions may finish out of order without nonce reuse.

The 12-byte AES-GCM nonce is eight zero bytes followed by the sequence as a big-endian unsigned 32-bit integer. Independent keys allow both directions to begin at zero. Additional authenticated data is `J(["bro-relay",2,session,direction,requestId,sequence])`. Plaintext is `J(payload)`; ciphertext includes the 16-byte GCM authentication tag and is B64 encoded. All fields are authenticated or checked against the authenticated session. Unknown fields are rejected.

A receiver retains at most the last 128 sequence numbers relative to its highest successfully authenticated sequence. Already accepted sequences and sequences at or below `highest - 128` are rejected. Valid out-of-order packets inside this window are accepted once. In-flight sequence reservations prevent duplicate concurrent decryptions; after decryption, freshness is checked again before returning plaintext. Authentication failures release their in-flight reservation and never advance the window. At most eight decryptions may be in flight per session. The caller dispatches only successful `open()` results. Replay state must not be reconstructed from request caches or persisted across connections.

## Lifecycle and limits

The implementation's exported `LIMITS` is authoritative for enforcement. Version 2 fixes 16 total active plus pending sessions per device, a 30-second handshake deadline, 10-minute session lifetime, one million messages per directional key, 128 KiB request plaintext and 16 MiB response plaintext. These are UTF-8 JSON byte limits, so embedded base64 image bytes count toward the response limit. Handshake slots are reserved before asynchronous work; concurrent accepts cannot exceed the quota. Expired state is cleaned on device operations. Closing an individual session immediately releases its device slot; device close releases all state. There is no idle timer or persisted session state.

After an encrypted close-RPC acknowledgment, close the session locally; SDK cleanup should use `finally` so a lost acknowledgment still releases local state. Each transport disconnect must call `device.close()` or `session.close()`. Reconnect creates a new device/client object and repeats the handshake. An old retained device session checks its owning device's closed state even after an asynchronous decryption. Client and device deadlines are local and may differ slightly; expiry at either endpoint requires a new handshake. No transparent retransmission or exactly-once execution across sessions is promised. A lost response after execution is an uncertain operation outcome and must not trigger an automatic mutation retry.

The transport must cap frame/body sizes before JSON parsing, serialize only known wire objects, and apply connection/rate limits; this module cannot bound buffers already allocated by its caller. The Hub may fill unauthenticated pending slots and deny availability, but cannot turn that into authenticated execution.

## API and failures

`await createPairing(origin)` returns the driver ID. `parsePairing(driverId)` returns frozen `{origin,route,secret}`. `await deriveHubToken(pairing)` returns only the Hub credential. `await createClient(pairing)` returns `{hello,finish(challenge)}`; the one-shot finish returns `{finish,session}`. `await createDevice(pairing)` returns `{accept(hello),finish(clientFinish),getSession(id),close()}`; its finish returns the authenticated session. Sessions provide `{id,expires,seal(requestId,payload),open(envelope),close()}`. Open returns `{requestId,payload}`. Callers retain the original driver ID separately; they must not serialize the parsed pairing as network state.

Protocol rejection codes are `invalid_pairing`, `invalid_message`, `authentication_failed`, `session_expired`, `replay`, and `quota_exceeded`. Treat every rejection as no execution; do not send plaintext error details or secrets over the relay. Runtime crypto failures and malformed non-JSON local inputs may additionally reject with platform errors. Never catch a crypto error and fall back to plaintext or legacy authentication.

## Verification and review status

Run `node --test tests/relay-crypto.test.mjs`; for the explicit Chromium gate, install the repository's Playwright browser and run `RELAY_CRYPTO_BROWSER=1 node --test tests/relay-crypto.test.mjs`. The fixed vector is stored in [the test](../../tests/relay-crypto.test.mjs). Its random inputs are master `00` repeated 32 times, epoch `01` repeated 32 times, client challenge `02` repeated 32 times and server nonce `03` repeated 32 times; origin is `https://relay.example`. The deterministic RNG exists only in test-created realms and cannot be configured through the production API.

Self-review covered domain separation, role reflection, origin/route binding, restart replay, asynchronous sequence reservation and quota races. Node and Chromium produced the same complete handshake, Hub token, session ID and both directional ciphertext vectors, and exchanged real Unicode JSON payloads. Adversarial tests cover payload/header modification, concurrent duplicate delivery, stale windows, forged proofs, old handshake injection after reconnect, session mixing and local deadlines. Independent protocol review remains a release gate; its reviewer and findings must be added here before slice 05 is accepted.
