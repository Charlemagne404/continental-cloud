export class CloudError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'CloudError';
  }
}

export const fail = {
  badRequest: (message: string) => new CloudError('BAD_REQUEST', message, 400),
  unauthorized: () => new CloudError('UNAUTHORIZED', 'Authentication is required.', 401),
  forbidden: (message = 'This operation is not allowed.') => new CloudError('FORBIDDEN', message, 403),
  notFound: (message = 'The requested item was not found.') => new CloudError('NOT_FOUND', message, 404),
  conflict: (message: string) => new CloudError('CONFLICT', message, 409),
  tooLarge: (message: string) => new CloudError('PAYLOAD_TOO_LARGE', message, 413),
  unavailable: (message: string) => new CloudError('STORAGE_UNAVAILABLE', message, 503),
};
