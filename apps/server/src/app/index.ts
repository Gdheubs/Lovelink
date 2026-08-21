/**
 * The application ring: one file per use case.
 *
 * A use case is a class with a constructor that takes ports and a single
 * `execute` method. That uniformity is not ceremony — it is what lets the HTTP
 * edge, the socket edge, the smoke test and the admin tool all invoke the same
 * logic the same way, and it is what makes "authorization is checked
 * server-side" verifiable by reading one file rather than three transports.
 *
 * RULES FOR THIS DIRECTORY (enforced by eslint, see eslint.config.js)
 *  - No vendor imports. Take a port.
 *  - No imports from /adapters. Ports arrive via the constructor.
 *  - No `new Date()` and no `Math.random()`. Take Clock and IdGenerator.
 *  - Every use case checks authorization itself. Never assume the edge did it.
 *
 * `UseCases` is the bundle the composition root assembles and hands to the
 * edges. Keeping it as one named type means adding a use case is a compile
 * error at every construction site rather than a runtime `undefined`.
 */

// Phase 1 (identity) adds the auth and profile use cases to this bundle.
export type UseCases = Record<never, never>;

/**
 * Assemble every use case from the port bundle. Called once, at boot, by the
 * composition root in /src/main.ts.
 */
export function createUseCases(): UseCases {
  return {};
}
