/** Kontract said no, or couldn't be reached. `status` is what to answer the person with; `message` is for them. */
export class KontractError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
