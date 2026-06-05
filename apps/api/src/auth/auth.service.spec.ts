import * as bcrypt from 'bcryptjs';
import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../generated/prisma';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const jwt = { signAsync: jest.fn().mockResolvedValue('jwt-token') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes audit log on successful login', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'admin@example.com',
      name: 'Admin',
      role: UserRole.ADMIN,
      isActive: true,
      passwordHash,
    });
    const service = new AuthService(prisma as any, jwt as any, audit as any);

    const result = await service.login({ email: 'ADMIN@example.com', password: 'password123' }, '127.0.0.1');

    expect(result.accessToken).toBe('jwt-token');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'auth.login.success',
        entity: 'User',
      }),
    );
  });

  it('writes audit log on failed password', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'admin@example.com',
      role: UserRole.ADMIN,
      isActive: true,
      passwordHash,
    });
    const service = new AuthService(prisma as any, jwt as any, audit as any);

    await expect(service.login({ email: 'admin@example.com', password: 'wrongpass' }, '127.0.0.1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'auth.login.failed',
        metadata: expect.objectContaining({ reason: 'bad_password' }),
      }),
    );
  });

  it('writes audit log when admin creates a user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-2',
      email: 'rop@example.com',
      name: 'ROP',
      role: UserRole.ROP,
      isActive: true,
    });
    const service = new AuthService(prisma as any, jwt as any, audit as any);

    await service.createUser(
      { email: 'rop@example.com', name: 'ROP', role: UserRole.ROP, password: 'password123' },
      'admin-1',
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'admin.user.create',
        entityId: 'user-2',
      }),
    );
  });
});
