import { z } from 'zod';

/**
 * Форма контактного лица клиента — одна и та же для «добавить» и «изменить».
 *
 * Границы повторяют `contactCreateSchema`/`contactUpdateSchema` на сервере
 * (apps/api/src/modules/clients/router.ts): ФИО 2–200, телефон 5–50, email до
 * 200, должность до 100. Расходиться им нельзя — иначе экран пропустит то, что
 * сервер отвергнет сырой ошибкой.
 */
export const contactFormSchema = z.object({
  fullName: z.string().trim().min(2, 'Введите ФИО').max(200, 'Слишком длинное ФИО'),
  phone: z.string().trim().min(5, 'Введите телефон').max(50, 'Слишком длинный телефон'),
  email: z.string().trim().email('Некорректный email').max(200).or(z.literal('')),
  position: z.string().trim().max(100, 'Слишком длинная должность').or(z.literal('')),
  isPrimary: z.boolean(),
});

export type ContactFormValues = z.infer<typeof contactFormSchema>;
