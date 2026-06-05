import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

type AuditInput = {
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

type AuditListQuery = {
  limit?: number;
  action?: string;
  entity?: string;
  userId?: string;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId ?? null,
          action: input.action,
          entity: input.entity,
          entityId: input.entityId ?? null,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error: any) {
      this.logger.warn(`Audit log write failed: ${error.message}`);
    }
  }

  async list(query: AuditListQuery) {
    const take = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    return this.prisma.auditLog.findMany({
      where: {
        action: query.action,
        entity: query.entity,
        userId: query.userId,
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        user: {
          select: { id: true, email: true, name: true, role: true },
        },
      },
    });
  }
}
