import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/**
 * Route ids are bigint identities. Accept only positive integers JS represents exactly, so an
 * oversized id is a clean 400 rather than a Postgres "out of range" error.
 */
@Injectable()
export class ParseIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const id = /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new BadRequestException('id must be a positive integer');
    }
    return id;
  }
}
