import * as bcrypt from 'bcryptjs';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto, ip?: string) {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      await this.audit.record({
        action: 'auth.login.failed',
        entity: 'User',
        metadata: { email, ip, reason: 'not_found_or_inactive' },
      });
      throw new UnauthorizedException('Неверный email или пароль');
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      await this.audit.record({
        userId: user.id,
        action: 'auth.login.failed',
        entity: 'User',
        entityId: user.id,
        metadata: { email, ip, reason: 'bad_password' },
      });
      throw new UnauthorizedException('Неверный email или пароль');
    }

    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });
    await this.audit.record({
      userId: user.id,
      action: 'auth.login.success',
      entity: 'User',
      entityId: user.id,
      metadata: { email, ip },
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
  }

  async createUser(dto: CreateUserDto, actorUserId?: string) {
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        role: dto.role,
        passwordHash: await bcrypt.hash(dto.password, 12),
      },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    await this.audit.record({
      userId: actorUserId,
      action: 'admin.user.create',
      entity: 'User',
      entityId: user.id,
      metadata: { email: user.email, role: user.role },
    });

    return user;
  }

  async listUsers() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
  }
}
