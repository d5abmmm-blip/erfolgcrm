-- Фича №3 «Трек как посылку» — публичный токен отслеживания заявки.
--
-- Случайный UUID генерируется по кнопке «Ссылка для клиента» (не при создании заявки).
-- По нему публичная страница /track/:token без логина показывает стадию ремонта (PII-free).
-- Отзыв ссылки = обнуление токена. Частичный UNIQUE: NULL не конфликтуют между собой.
--
-- Code-совместимо: колонка nullable, дефолта нет — существующие заявки не трогаются,
-- RLS на tickets уже настроена (новых таблиц нет → setup-rls не требуется).

ALTER TABLE "tickets" ADD COLUMN "public_track_token" uuid;--> statement-breakpoint

CREATE UNIQUE INDEX "tickets_track_token_uniq"
  ON "tickets" ("public_track_token")
  WHERE "public_track_token" IS NOT NULL;
