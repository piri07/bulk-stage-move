import {
  BadRequestException,
  createParamDecorator,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { UUID_PATTERN } from './uuid';

export const WORKSPACE_HEADER = 'x-workspace-id';

type ScopedRequest = Request & { workspaceId?: string };

/**
 * Tenancy boundary for every CRM route: X-Workspace-Id must be a UUID, and it is stashed on the
 * request for @WorkspaceId(). The guard deliberately does not look the workspace up. Reads are
 * scoped by workspace_id in SQL, so an unknown workspace simply sees nothing, and writes hit the
 * foreign key. Skipping the lookup keeps a round trip off every interactive request.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const header = request.headers[WORKSPACE_HEADER];
    if (typeof header !== 'string' || !UUID_PATTERN.test(header)) {
      throw new BadRequestException(`${WORKSPACE_HEADER} header must be a UUID`);
    }
    request.workspaceId = header.toLowerCase();
    return true;
  }
}

export const WorkspaceId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const { workspaceId } = context.switchToHttp().getRequest<ScopedRequest>();
    if (workspaceId === undefined) {
      // A programming error, not a client one: the route is missing @UseGuards(WorkspaceGuard).
      throw new Error('@WorkspaceId() used on a route without WorkspaceGuard');
    }
    return workspaceId;
  },
);
