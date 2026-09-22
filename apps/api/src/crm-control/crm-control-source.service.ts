import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { indexCrmControlSourcesForDeals, normalizeCrmControlWebhookRows } from './crm-control-source.normalizer';
import {
  CrmControlSourceCursor, CrmControlSourceWindow, CrmControlSourceWindowRequest,
  CrmControlTalkBindingProof, CrmControlWebhookSourceRow,
} from './crm-control-source.types';

const finiteDate = (date: Date): boolean => date instanceof Date && Number.isFinite(date.getTime());

/** Internal worker reader. No network, writes, implicit account selection or per-deal database queries. */
@Injectable()
export class CrmControlSourceService {
  constructor(private readonly prisma: PrismaService) {}

  async loadWindow(request: CrmControlSourceWindowRequest): Promise<CrmControlSourceWindow> {
    const pageSize = request.pageSize ?? 500;
    const maxRows = request.maxRows ?? 10_000;
    if (!request.connectionId.trim() || !finiteDate(request.receivedFrom) || !finiteDate(request.receivedTo)
      || request.receivedFrom >= request.receivedTo || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000
      || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 50_000) throw new Error('Некорректные границы чтения источников CRM.');
    if (request.after && (!request.after.id.trim() || !finiteDate(request.after.receivedAt)
      || request.after.receivedAt < request.receivedFrom || request.after.receivedAt >= request.receivedTo)) {
      throw new Error('Некорректный курсор чтения источников CRM.');
    }
    const rows: CrmControlWebhookSourceRow[] = [];
    let cursor: CrmControlSourceCursor | undefined = request.after;
    let reachedEnd = false;
    while (rows.length < maxRows) {
      const take = Math.min(pageSize, maxRows - rows.length);
      // Read once per run, with the indexed account prefix and a bounded time window.
      // Do not filter by mutable processing status: even an unfamiliar status still contains source facts.
      const where: Prisma.RawAmoEventInboxWhereInput = {
        connectionId: request.connectionId,
        entity: { in: ['message', 'outgoing_message'] }, action: 'add',
        receivedAt: { gte: request.receivedFrom, lt: request.receivedTo },
        ...(cursor ? { OR: [{ receivedAt: { gt: cursor.receivedAt } }, { receivedAt: cursor.receivedAt, id: { gt: cursor.id } }] } : {}),
      };
      const page = await this.prisma.rawAmoEventInbox.findMany({
        where, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take,
        select: { id: true, connectionId: true, entity: true, action: true, payload: true, receivedAt: true },
      });
      rows.push(...page);
      const last = page.at(-1);
      if (last) cursor = { receivedAt: last.receivedAt, id: last.id };
      if (page.length < take) { reachedEnd = true; break; }
    }
    return {
      connectionId: request.connectionId, receivedFrom: request.receivedFrom, receivedTo: request.receivedTo,
      rowsRead: rows.length, messages: normalizeCrmControlWebhookRows(rows),
      readAfter: request.after ?? null, limitReached: !reachedEnd, datasetReadComplete: reachedEnd && !request.after,
      nextCursor: reachedEnd ? null : cursor ?? null, sourceCoverage: 'UNVERIFIED',
    };
  }

  async loadForDeals(request: CrmControlSourceWindowRequest & {
    dealExternalIds: readonly string[]; observedAt: Date; talkBindings?: readonly CrmControlTalkBindingProof[];
  }) {
    const window = await this.loadWindow(request);
    const index = indexCrmControlSourcesForDeals(window.messages, request);
    return { window, index };
  }
}
