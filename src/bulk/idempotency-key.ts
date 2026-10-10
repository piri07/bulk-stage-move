import { BadRequestException } from '@nestjs/common';

// Visible ASCII, no spaces: room for a UUID or any other client-generated token.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

/**
 * The key is required. Without one, a retry can't be told apart from a deliberate second move.
 */
export function parseIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || !IDEMPOTENCY_KEY.test(raw)) {
    throw new BadRequestException(
      'Idempotency-Key header is required: 1-255 visible ASCII characters, such as a UUID ' +
        'generated once per user action and reused for its retries',
    );
  }
  return raw;
}
