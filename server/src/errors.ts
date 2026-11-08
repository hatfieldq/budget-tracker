// Errors thrown by services. The HTTP layer (app.ts) turns them into status codes.

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(what: string) {
    super(404, `${what} not found`);
  }
}
