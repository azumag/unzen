# Evidence base-field runtime boundary

`validateEvidenceEnvelope()` treats required base-envelope fields as runtime caller input even after the top-level object check. Required scalar reads (`evidenceKind`, `runId`, and `capturedAt`) therefore use the same bounded property-read helper as other runtime snapshots. A throwing accessor is treated as an absent/invalid value under the existing validation taxonomy; the thrown value is never inspected or stringified.

Required `payload` presence is also checked through a bounded own-property operation. A Proxy whose `getOwnPropertyDescriptor` trap throws cannot escape validation; the payload is treated as unavailable and validation fails closed with the existing `invalid-envelope` issue.

This boundary does not alter successful-path schema/readiness semantics, does not eagerly read payload contents, and does not change artifact or independent-verification behavior. Captured `artifact` and `verification` claim objects remain separate runtime-boundary audit units.
