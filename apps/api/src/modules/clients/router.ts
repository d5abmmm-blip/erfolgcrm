/**
 * tRPC роутер для clients/contacts.
 *
 * RBAC:
 * - list / get / search / create / update / addContact / updateContact — staffProcedure (director + dispatcher)
 * - archive / deleteContact — directorProcedure (необратимые действия)
 *
 * CreateClientInput — discriminatedUnion('type'). Legal требует displayName, individual — fullName.
 * Server разбирает fullName в displayName формата «Фамилия И.О.» если displayName не задан.
 */
import { z } from 'zod';
import { ClientType, ClientSubtype, ClientStatus } from '@erfolg/shared';
import { router, staffProcedure, directorProcedure } from '../../trpc/trpc';
import { buildDisplayNameFromFio } from '../../lib/person-name';
import {
  addContactCmd,
  archiveClientCmd,
  createClientCmd,
  deleteContactCmd,
  getClientQuery,
  listClientsQuery,
  searchClientsQuery,
  updateClientCmd,
  updateContactCmd,
} from './service';

const legalCreateSchema = z.object({
  type: z.literal(ClientType.enum.legal),
  subtype: ClientSubtype.optional(),
  displayName: z.string().trim().min(1).max(200),
  inn: z.string().trim().regex(/^\d{10}$|^\d{12}$/, 'ИНН должен быть 10 или 12 цифр').nullable().optional(),
  kpp: z.string().trim().regex(/^\d{9}$/, 'КПП должен быть 9 цифр').nullable().optional(),
  ogrn: z.string().trim().regex(/^\d{13}$|^\d{15}$/, 'ОГРН/ОГРНИП — 13 или 15 цифр').nullable().optional(),
  legalAddress: z.string().trim().max(500).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  treasuryAccount: z.string().trim().max(20).nullable().optional(),
  eksAccount: z.string().trim().max(20).nullable().optional(),
  personalAccount: z.string().trim().max(20).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const individualCreateSchema = z.object({
  type: z.literal(ClientType.enum.individual),
  /** Полное ФИО — обязательно. server конструирует displayName формата «Фамилия И.О.». */
  individualFullName: z.string().trim().min(2).max(200),
  individualPhone: z.string().trim().min(5).max(50).optional(),
  individualAddress: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const createClientSchema = z.discriminatedUnion('type', [
  legalCreateSchema,
  individualCreateSchema,
]);

// buildDisplayNameFromFio живёт в lib/person-name.ts — та же логика нужна при
// переводе лида в клиента, а копий этого правила в проекте и так было три.

const updateClientSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    subtype: ClientSubtype.nullable().optional(),
    inn: z.string().trim().nullable().optional(),
    kpp: z.string().trim().nullable().optional(),
    ogrn: z.string().trim().nullable().optional(),
    legalAddress: z.string().trim().max(500).nullable().optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    treasuryAccount: z.string().trim().max(20).nullable().optional(),
    eksAccount: z.string().trim().max(20).nullable().optional(),
    personalAccount: z.string().trim().max(20).nullable().optional(),
    individualFullName: z.string().trim().min(2).max(200).nullable().optional(),
    individualPhone: z.string().trim().min(5).max(50).nullable().optional(),
    individualAddress: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const contactCreateSchema = z.object({
  clientId: z.string().uuid(),
  fullName: z.string().trim().min(2).max(200),
  phone: z.string().trim().min(5).max(50),
  email: z.string().trim().email().max(200).nullable().optional(),
  position: z.string().trim().max(100).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

const contactUpdateSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200).optional(),
    phone: z.string().trim().min(5).max(50).optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    position: z.string().trim().max(100).nullable().optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

export const clientsRouter = router({
  list: staffProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(100).optional(),
          status: ClientStatus.optional(),
          page: z.number().int().positive().max(1000).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listClientsQuery(ctx.db, ctx.tenant, input ?? {}),
    ),

  get: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getClientQuery(ctx.db, ctx.tenant, input.id)),

  search: staffProcedure
    .input(z.object({ q: z.string().trim().min(1).max(100) }))
    .query(({ ctx, input }) => searchClientsQuery(ctx.db, ctx.tenant, input.q)),

  create: staffProcedure
    .input(createClientSchema)
    .mutation(({ ctx, input }) => {
      const audit = { ip: ctx.ip, userAgent: ctx.userAgent };
      if (input.type === 'individual') {
        return createClientCmd(ctx.db, ctx.tenant, ctx.session, audit, {
          type: 'individual',
          displayName: buildDisplayNameFromFio(input.individualFullName),
          individualFullName: input.individualFullName,
          individualPhone: input.individualPhone ?? null,
          individualAddress: input.individualAddress ?? null,
          notes: input.notes ?? null,
        });
      }
      return createClientCmd(ctx.db, ctx.tenant, ctx.session, audit, {
        type: 'legal',
        subtype: input.subtype ?? null,
        displayName: input.displayName,
        inn: input.inn ?? null,
        kpp: input.kpp ?? null,
        ogrn: input.ogrn ?? null,
        legalAddress: input.legalAddress ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        treasuryAccount: input.treasuryAccount ?? null,
        eksAccount: input.eksAccount ?? null,
        personalAccount: input.personalAccount ?? null,
        notes: input.notes ?? null,
      });
    }),

  update: staffProcedure
    .input(z.object({ id: z.string().uuid(), patch: updateClientSchema }))
    .mutation(({ ctx, input }) =>
      updateClientCmd(
        ctx.db,
        ctx.tenant,
        ctx.session,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.id,
        input.patch,
      ),
    ),

  archive: directorProcedure
    .input(z.object({ id: z.string().uuid(), reason: z.string().max(500).optional() }))
    .mutation(({ ctx, input }) =>
      archiveClientCmd(
        ctx.db,
        ctx.tenant,
        ctx.session,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.id,
        input.reason,
      ),
    ),

  addContact: staffProcedure.input(contactCreateSchema).mutation(({ ctx, input }) =>
    addContactCmd(
      ctx.db,
      ctx.tenant,
      ctx.session,
      { ip: ctx.ip, userAgent: ctx.userAgent },
      input,
    ),
  ),

  updateContact: staffProcedure
    .input(z.object({ id: z.string().uuid(), patch: contactUpdateSchema }))
    .mutation(({ ctx, input }) =>
      updateContactCmd(
        ctx.db,
        ctx.tenant,
        ctx.session,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.id,
        input.patch,
      ),
    ),

  deleteContact: directorProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      deleteContactCmd(
        ctx.db,
        ctx.tenant,
        ctx.session,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        input.id,
      ),
    ),
});
