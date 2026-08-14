/**
 * Журнал учёта посещений (табель) — кто из сотрудников в какой день был на работе.
 *
 * Заводится РУКАМИ в десктопной CRM (решение владельца 2026-08-14): у инженеров на
 * телефоне никаких отметок «пришёл/ушёл» нет — их контакт с программой сознательно
 * минимизируют. Ведёт журнал диспетчер или директор.
 *
 * Инвариант, который держит уникальный индекс: у сотрудника на один день ровно одна
 * отметка. Правка дня = UPDATE той же строки, а не вторая запись — иначе месяц с
 * исправлениями давал бы два разных «итого» в зависимости от того, какую строку взять.
 *
 * На зарплату журнал НЕ влияет: ЗП считается по окладу + бонусу + сделке (см. #88),
 * часов в этой формуле нет. Табель — учётный документ, не расчётный.
 *
 * RLS включается отдельным *enable_rls*.sql (см. setup-rls.ts).
 */
import {
  date,
  index,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pk, tenantId } from './_shared';

/**
 * Вид дня. Коды в печатном табеле: present=Я, day_off=В, sick=Б, vacation=ОТ,
 * business_trip=К, absent=Н, unpaid_leave=ДО.
 */
export const attendanceStatusEnum = pgEnum('attendance_status', [
  'present',
  'day_off',
  'sick',
  'vacation',
  'business_trip',
  'absent',
  'unpaid_leave',
]);

export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: pk(),
    tenantId: tenantId(),
    /** FK на users.id (app-enforced, как и в остальных модулях). */
    userId: uuid('user_id').notNull(),
    /** День табеля в таймзоне организации. Без времени — время лежит отдельно. */
    workDate: date('work_date').notNull(),
    status: attendanceStatusEnum('status').notNull(),
    /**
     * Приход и уход — только у явки. `time` без таймзоны: табель ведут по местному
     * времени организации, переводить его в UTC и обратно незачем.
     */
    arrivedAt: time('arrived_at'),
    leftAt: time('left_at'),
    note: text('note'),
    // Без deleted_at сознательно: «снять отметку» — это DELETE строки. Мягкое
    // удаление здесь ловушка — погашенная строка продолжала бы держать
    // уникальный индекс, и поставить день заново стало бы нельзя.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Один сотрудник — один день. Основа upsert'а.
    uniqueIndex('attendance_records_uniq').on(t.tenantId, t.userId, t.workDate),
    // «Кто был на работе в этом месяце» — единственный запрос страницы и печати.
    index('attendance_records_tenant_date_idx').on(t.tenantId, t.workDate),
  ],
);
