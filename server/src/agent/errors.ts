/** Another worker claimed the run. Whoever catches this stops at once and writes nothing more. */
export class LostLease extends Error {
  constructor() {
    super('This run was taken over by another worker.');
  }
}
