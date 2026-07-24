import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

const RECENT_FACT_REFRESH_MINUTES = 15;
const FACT_REFRESH_TRANSACTION_TIMEOUT_MS = 120_000;

type FactMartDb = PrismaService | Prisma.TransactionClient;

@Injectable()
export class FactMartsService {
  private readonly logger = new Logger(FactMartsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async refreshAll() {
    const startedAt = Date.now();
    await this.prisma.$transaction(async (tx) => {
      await this.refreshDealFacts(undefined, tx);
      await this.refreshEmailThreadFacts(undefined, tx);
    }, { timeout: FACT_REFRESH_TRANSACTION_TIMEOUT_MS });
    const counts = await this.factCounts();
    this.logger.log(`Fact marts full refresh completed in ${Date.now() - startedAt}ms`);
    return counts;
  }

  async refreshRecentlyChanged(minutes = RECENT_FACT_REFRESH_MINUTES) {
    const cutoff = new Date(Date.now() - Math.max(1, minutes) * 60_000);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT deal_id AS id
      FROM (
        SELECT deal."id" AS deal_id
        FROM "Deal" deal
        WHERE deal."updatedAt" >= ${cutoff}
           OR deal."deletedAt" >= ${cutoff}
           OR deal."closedAt" >= ${cutoff}

        UNION ALL

        SELECT history."dealId" AS deal_id
        FROM "DealStageHistory" history
        WHERE history."movedAt" >= ${cutoff}

        UNION ALL

        SELECT state."dealId" AS deal_id
        FROM "EmailThreadState" state
        WHERE state."updatedAt" >= ${cutoff}
      ) changed
      WHERE deal_id IS NOT NULL
    `;
    return this.refreshDeals(rows.map((row) => row.id));
  }

  async refreshDeals(dealIds: string[]) {
    const ids = [...new Set(dealIds.filter(Boolean))];
    if (ids.length === 0) return { dealCurrent: 0, stageTransitions: 0, stageIntervals: 0, emailThreads: 0 };
    await this.prisma.$transaction(async (tx) => {
      await this.refreshDealFacts(ids, tx);
      await this.refreshEmailThreadFacts(ids, tx);
    }, { timeout: FACT_REFRESH_TRANSACTION_TIMEOUT_MS });
    return this.factCounts(ids);
  }

  async refreshDealExternalIds(externalIds: string[]) {
    const ids = [...new Set(externalIds.filter(Boolean).map(String))];
    if (ids.length === 0) return { dealCurrent: 0, stageTransitions: 0, stageIntervals: 0, emailThreads: 0 };
    const rows = await this.prisma.deal.findMany({
      where: { externalId: { in: ids } },
      select: { id: true },
    });
    return this.refreshDeals(rows.map((row) => row.id));
  }

  async refreshEmailThreadFactsForDeals(dealIds: string[]) {
    const ids = [...new Set(dealIds.filter(Boolean))];
    if (ids.length === 0) return { emailThreads: 0 };
    return this.refreshEmailThreadFactsOnly(ids);
  }

  async refreshEmailThreadFactsOnly(dealIds?: string[]) {
    const ids = dealIds === undefined ? undefined : [...new Set(dealIds.filter(Boolean))];
    if (ids?.length === 0) return { emailThreads: 0 };
    await this.prisma.$transaction(async (tx) => {
      await this.refreshEmailThreadFacts(ids, tx);
    }, { timeout: FACT_REFRESH_TRANSACTION_TIMEOUT_MS });
    return {
      emailThreads: await this.prisma.factEmailThreadState.count(
        ids ? { where: { dealId: { in: ids } } } : undefined,
      ),
    };
  }

  private async refreshDealFacts(dealIds?: string[], db: FactMartDb = this.prisma) {
    await this.refreshFactDealCurrent(dealIds, db);
    await this.refreshFactStageTransitions(dealIds, db);
    await this.refreshFactStageIntervals(dealIds, db);
  }

  private async refreshFactDealCurrent(dealIds?: string[], db: FactMartDb = this.prisma) {
    const ids = this.normalizedIds(dealIds);
    if (ids.length) {
      await db.$executeRaw`DELETE FROM "fact_deal_current" WHERE "deal_id" IN (${Prisma.join(ids)})`;
    } else {
      await db.$executeRaw`DELETE FROM "fact_deal_current"`;
    }

    const where = ids.length ? Prisma.sql`WHERE deal."id" IN (${Prisma.join(ids)})` : Prisma.empty;
    await db.$executeRaw`
      INSERT INTO "fact_deal_current" (
        "deal_id", "deal_external_id", "pipeline_id", "pipeline_name", "stage_id", "stage_name",
        "stage_position", "stage_color", "stage_is_won", "stage_is_lost", "responsible_id",
        "responsible_name", "responsible_external_id", "group_id", "group_name", "contact_id",
        "contact_external_id", "contact_name", "contact_email", "loss_reason_id", "loss_reason_name",
        "title", "amount", "currency", "source", "tags", "custom_fields", "closed_at",
        "expected_close_at", "created_at", "updated_at", "deleted_at", "fact_updated_at"
      )
      SELECT
        deal."id",
        deal."externalId",
        pipeline."id",
        pipeline."name",
        stage."id",
        stage."name",
        stage."position",
        stage."color",
        stage."isWon",
        stage."isLost",
        manager."id",
        manager."name",
        manager."externalId",
        crm_group."id",
        crm_group."name",
        contact."id",
        contact."externalId",
        contact."name",
        contact."email",
        loss_reason."id",
        loss_reason."name",
        deal."title",
        deal."amount",
        deal."currency",
        deal."source",
        deal."tags",
        deal."customFields",
        deal."closedAt",
        deal."expectedCloseAt",
        deal."createdAt",
        deal."updatedAt",
        deal."deletedAt",
        NOW()
      FROM "Deal" deal
      JOIN "Pipeline" pipeline ON pipeline."id" = deal."pipelineId"
      JOIN "PipelineStage" stage ON stage."id" = deal."stageId"
      LEFT JOIN "CrmUser" manager ON manager."id" = deal."responsibleId"
      LEFT JOIN "CrmGroup" crm_group ON crm_group."id" = manager."groupId"
      LEFT JOIN "Contact" contact ON contact."id" = deal."contactId"
      LEFT JOIN "LossReason" loss_reason ON loss_reason."id" = deal."lossReasonId"
      ${where}
    `;
  }

  private async refreshFactStageTransitions(dealIds?: string[], db: FactMartDb = this.prisma) {
    const ids = this.normalizedIds(dealIds);
    if (ids.length) {
      await db.$executeRaw`DELETE FROM "fact_stage_transition" WHERE "deal_id" IN (${Prisma.join(ids)})`;
    } else {
      await db.$executeRaw`DELETE FROM "fact_stage_transition"`;
    }

    const where = ids.length ? Prisma.sql`WHERE history."dealId" IN (${Prisma.join(ids)})` : Prisma.empty;
    await db.$executeRaw`
      INSERT INTO "fact_stage_transition" (
        "id", "deal_id", "deal_external_id", "deal_title", "deal_amount", "deal_currency",
        "pipeline_id", "pipeline_name", "from_stage_id", "from_stage_name", "to_stage_id",
        "to_stage_name", "to_stage_position", "to_stage_is_won", "to_stage_is_lost",
        "responsible_id", "responsible_name", "group_id", "group_name", "moved_at",
        "moved_by_id", "source", "fact_updated_at"
      )
      SELECT
        history."id",
        deal."id",
        deal."externalId",
        deal."title",
        deal."amount",
        deal."currency",
        pipeline."id",
        pipeline."name",
        from_stage."id",
        from_stage."name",
        to_stage."id",
        to_stage."name",
        to_stage."position",
        to_stage."isWon",
        to_stage."isLost",
        manager."id",
        manager."name",
        crm_group."id",
        crm_group."name",
        history."movedAt",
        history."movedById",
        history."source",
        NOW()
      FROM "DealStageHistory" history
      JOIN "Deal" deal ON deal."id" = history."dealId"
      JOIN "PipelineStage" to_stage ON to_stage."id" = history."toStageId"
      JOIN "Pipeline" pipeline ON pipeline."id" = to_stage."pipelineId"
      LEFT JOIN "PipelineStage" from_stage ON from_stage."id" = history."fromStageId"
      LEFT JOIN "CrmUser" manager ON manager."id" = deal."responsibleId"
      LEFT JOIN "CrmGroup" crm_group ON crm_group."id" = manager."groupId"
      ${where}
    `;
  }

  private async refreshFactStageIntervals(dealIds?: string[], db: FactMartDb = this.prisma) {
    const ids = this.normalizedIds(dealIds);
    if (ids.length) {
      await db.$executeRaw`DELETE FROM "fact_deal_stage_interval" WHERE "deal_id" IN (${Prisma.join(ids)})`;
    } else {
      await db.$executeRaw`DELETE FROM "fact_deal_stage_interval"`;
    }

    const selectedWhere = ids.length ? Prisma.sql`WHERE deal."id" IN (${Prisma.join(ids)})` : Prisma.empty;
    await db.$executeRaw`
      INSERT INTO "fact_deal_stage_interval" (
        "id", "deal_id", "deal_external_id", "pipeline_id", "pipeline_name", "stage_id", "stage_name",
        "stage_position", "stage_is_won", "stage_is_lost", "responsible_id", "responsible_name",
        "responsible_external_id", "group_id", "group_name", "entered_at", "exited_at",
        "duration_seconds", "is_current", "fact_updated_at"
      )
      WITH selected_deals AS (
        SELECT deal.*
        FROM "Deal" deal
        ${selectedWhere}
      ),
      ordered_history AS (
        SELECT
          history."id",
          history."dealId",
          history."fromStageId",
          history."toStageId",
          history."movedAt",
          LEAD(history."movedAt") OVER (PARTITION BY history."dealId" ORDER BY history."movedAt", history."id") AS next_moved_at,
          ROW_NUMBER() OVER (PARTITION BY history."dealId" ORDER BY history."movedAt", history."id") AS rn
        FROM "DealStageHistory" history
        JOIN selected_deals deal ON deal."id" = history."dealId"
      ),
      first_history AS (
        SELECT *
        FROM ordered_history
        WHERE rn = 1
      ),
      intervals AS (
        SELECT
          md5(deal."id" || ':initial') AS id,
          deal."id" AS deal_id,
          first_history."fromStageId" AS stage_id,
          deal."createdAt" AS entered_at,
          first_history."movedAt" AS exited_at,
          false AS is_current
        FROM selected_deals deal
        JOIN first_history ON first_history."dealId" = deal."id"
        WHERE first_history."fromStageId" IS NOT NULL
          AND deal."createdAt" < first_history."movedAt"

        UNION ALL

        SELECT
          ordered_history."id",
          ordered_history."dealId",
          ordered_history."toStageId",
          ordered_history."movedAt",
          ordered_history.next_moved_at,
          ordered_history.next_moved_at IS NULL
        FROM ordered_history

        UNION ALL

        SELECT
          md5(deal."id" || ':current'),
          deal."id",
          deal."stageId",
          deal."createdAt",
          NULL::timestamp,
          true
        FROM selected_deals deal
        WHERE NOT EXISTS (
          SELECT 1
          FROM ordered_history
          WHERE ordered_history."dealId" = deal."id"
        )
      )
      SELECT
        intervals.id,
        deal."id",
        deal."externalId",
        pipeline."id",
        pipeline."name",
        stage."id",
        stage."name",
        stage."position",
        stage."isWon",
        stage."isLost",
        manager."id",
        manager."name",
        manager."externalId",
        crm_group."id",
        crm_group."name",
        intervals.entered_at,
        intervals.exited_at,
        CASE
          WHEN intervals.exited_at IS NULL THEN NULL
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM intervals.exited_at - intervals.entered_at)))::integer
        END,
        intervals.is_current,
        NOW()
      FROM intervals
      JOIN selected_deals deal ON deal."id" = intervals.deal_id
      JOIN "PipelineStage" stage ON stage."id" = intervals.stage_id
      JOIN "Pipeline" pipeline ON pipeline."id" = stage."pipelineId"
      LEFT JOIN "CrmUser" manager ON manager."id" = deal."responsibleId"
      LEFT JOIN "CrmGroup" crm_group ON crm_group."id" = manager."groupId"
      WHERE intervals.stage_id IS NOT NULL
    `;
  }

  private async refreshEmailThreadFacts(dealIds?: string[], db: FactMartDb = this.prisma) {
    const ids = this.normalizedIds(dealIds);
    if (ids.length) {
      await db.$executeRaw`DELETE FROM "fact_email_thread_state" WHERE "deal_id" IN (${Prisma.join(ids)})`;
    } else {
      await db.$executeRaw`DELETE FROM "fact_email_thread_state"`;
    }

    const where = ids.length ? Prisma.sql`WHERE state."dealId" IN (${Prisma.join(ids)})` : Prisma.empty;
    await db.$executeRaw`
      INSERT INTO "fact_email_thread_state" (
        "id", "deal_id", "deal_external_id", "deal_title", "deal_amount", "deal_currency", "pipeline_id",
        "pipeline_name", "stage_id", "stage_name", "stage_is_won", "stage_is_lost", "responsible_id",
        "responsible_name", "responsible_external_id", "group_id", "group_name", "contact_id",
        "contact_external_id", "contact_name", "contact_email", "thread_id", "last_incoming_note_external_id",
        "last_incoming_at", "last_outgoing_at", "last_message_at", "subject", "summary", "body", "from",
        "to", "attach_count", "delivery_status", "messages", "is_pending", "source_updated_at",
        "fact_updated_at"
      )
      SELECT
        state."id",
        deal."id",
        deal."externalId",
        deal."title",
        deal."amount",
        deal."currency",
        pipeline."id",
        pipeline."name",
        stage."id",
        stage."name",
        stage."isWon",
        stage."isLost",
        manager."id",
        manager."name",
        manager."externalId",
        crm_group."id",
        crm_group."name",
        contact."id",
        contact."externalId",
        contact."name",
        contact."email",
        state."threadId",
        state."lastIncomingNoteExternalId",
        state."lastIncomingAt",
        state."lastOutgoingAt",
        state."lastMessageAt",
        state."subject",
        state."summary",
        state."body",
        state."from",
        state."to",
        state."attachCount",
        state."deliveryStatus",
        state."messages",
        state."isPending",
        state."updatedAt",
        NOW()
      FROM "EmailThreadState" state
      JOIN "Deal" deal ON deal."id" = state."dealId"
      JOIN "Pipeline" pipeline ON pipeline."id" = deal."pipelineId"
      JOIN "PipelineStage" stage ON stage."id" = deal."stageId"
      LEFT JOIN "CrmUser" manager ON manager."id" = deal."responsibleId"
      LEFT JOIN "CrmGroup" crm_group ON crm_group."id" = manager."groupId"
      LEFT JOIN "Contact" contact ON contact."id" = deal."contactId"
      ${where}
    `;
  }

  private async factCounts(dealIds?: string[]) {
    const ids = this.normalizedIds(dealIds);
    if (!ids.length) {
      const [dealCurrent, stageTransitions, stageIntervals, emailThreads] = await Promise.all([
        this.prisma.factDealCurrent.count(),
        this.prisma.factStageTransition.count(),
        this.prisma.factDealStageInterval.count(),
        this.prisma.factEmailThreadState.count(),
      ]);
      return { dealCurrent, stageTransitions, stageIntervals, emailThreads };
    }

    const [dealCurrent, stageTransitions, stageIntervals, emailThreads] = await Promise.all([
      this.prisma.factDealCurrent.count({ where: { dealId: { in: ids } } }),
      this.prisma.factStageTransition.count({ where: { dealId: { in: ids } } }),
      this.prisma.factDealStageInterval.count({ where: { dealId: { in: ids } } }),
      this.prisma.factEmailThreadState.count({ where: { dealId: { in: ids } } }),
    ]);
    return { dealCurrent, stageTransitions, stageIntervals, emailThreads };
  }

  private normalizedIds(ids?: string[]) {
    return [...new Set((ids ?? []).filter(Boolean))];
  }
}
