export class LeapifyError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LeapifyError'
  }
}

export const unauthorized = (message = 'Unauthorized') =>
  new LeapifyError(401, 'UNAUTHORIZED', message)

export const domainRestricted = () =>
  new LeapifyError(
    403,
    'DOMAIN_RESTRICTED',
    'Only @dlsu.edu.ph email addresses are allowed',
  )

export const forbidden = (message = 'Forbidden') =>
  new LeapifyError(403, 'FORBIDDEN', message)

export const notFound = (resource = 'Resource') =>
  new LeapifyError(404, 'NOT_FOUND', `${resource} not found`)

export const badRequest = (message = 'Bad request') =>
  new LeapifyError(400, 'BAD_REQUEST', message)

export const conflict = (message = 'Conflict') =>
  new LeapifyError(409, 'CONFLICT', message)

export const tooManyRequests = (message = 'Too many requests') =>
  new LeapifyError(429, 'TOO_MANY_REQUESTS', message)

export const serviceUnavailable = (message = 'Service temporarily unavailable') =>
  new LeapifyError(503, 'SERVICE_UNAVAILABLE', message)

export const internalError = (message = 'Internal server error') =>
  new LeapifyError(500, 'INTERNAL_ERROR', message)
