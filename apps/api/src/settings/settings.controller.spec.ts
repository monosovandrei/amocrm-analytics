import { ForbiddenException } from '@nestjs/common';
import { PlatformBusinessRole, UserRole } from '../generated/prisma';
import { SettingsController } from './settings.controller';

describe('SettingsController', () => {
  const dto = {
    departmentKey: 'sales' as const,
    stageId: 'stage-1',
    isEnabled: true,
    slaDays: 5,
  };

  function createController() {
    const settings = {
      updateRopStageSla: jest.fn().mockResolvedValue({ id: 'rule-1' }),
    };
    return { controller: new SettingsController(settings as any), settings };
  }

  it('allows ROP users to update ROP stage SLA', async () => {
    const { controller, settings } = createController();

    await expect(controller.updateRopStageSla({ user: { id: 'rop-1', role: UserRole.ROP } }, dto)).resolves.toEqual({ id: 'rule-1' });

    expect(settings.updateRopStageSla).toHaveBeenCalledWith(dto, 'rop-1');
  });

  it('allows business ROP users to update ROP stage SLA', async () => {
    const { controller, settings } = createController();

    await expect(
      controller.updateRopStageSla({ user: { id: 'owner-1', businessRole: PlatformBusinessRole.ROP } }, dto),
    ).resolves.toEqual({ id: 'rule-1' });

    expect(settings.updateRopStageSla).toHaveBeenCalledWith(dto, 'owner-1');
  });

  it('rejects ordinary users from updating ROP stage SLA', async () => {
    const { controller, settings } = createController();

    expect(() => controller.updateRopStageSla({ user: { id: 'user-1', businessRole: PlatformBusinessRole.MANAGER } }, dto)).toThrow(
      ForbiddenException,
    );

    expect(settings.updateRopStageSla).not.toHaveBeenCalled();
  });
});
