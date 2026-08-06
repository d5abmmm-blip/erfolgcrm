import { z } from 'zod';

/** Schema для inline-формы добавления контакта в карточке клиента. */
export const addContactSchema = z.object({
  fullName: z.string().trim().min(2, 'Введите ФИО').max(200, 'Слишком длинное ФИО'),
  phone: z.string().trim().min(5, 'Введите телефон').max(50, 'Слишком длинный телефон'),
  email: z.string().trim().email('Некорректный email').or(z.literal('')),
  position: z.string().trim().max(120).or(z.literal('')),
  isPrimary: z.boolean(),
});

export type AddContactValues = z.infer<typeof addContactSchema>;
