import { z } from 'zod';

/** Schema для редактирования заметок к черновику счёта. */
export const invoiceNotesSchema = z.object({
  notes: z.string().max(2000, 'Слишком длинный комментарий'),
});

export type InvoiceNotesValues = z.infer<typeof invoiceNotesSchema>;
