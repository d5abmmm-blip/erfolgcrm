# Ежедневный бэкап рабочей базы ErfolgCRM (dev-машина, Windows).
#
# Что делает:
#   1. pg_dump -Fc внутри docker-контейнера (бинарный формат, сжатый);
#   2. проверяет дамп через pg_restore --list (битый дамп = ошибка сразу,
#      а не в день аварии);
#   3. забирает файл на хост в $BackupDir;
#   4. копирует во второй каталог-зеркало (другой диск / папка Яндекс.Диска);
#   5. удаляет дампы старше $KeepDays дней в обоих каталогах;
#   6. пишет строку в backup.log.
#
# Запуск руками:  powershell -File scripts\backup-dev.ps1
# По расписанию:  регистрируется задачей «ErfolgCRM DB Backup» (см. README ниже
#                 по файлу) — ежедневно в 03:30, догоняет пропуск при включении.
#
# Настройка через переменные окружения (необязательно):
#   ERFOLG_BACKUP_DIR    — куда складывать (по умолчанию D:\ErfolgCRM-backups)
#   ERFOLG_BACKUP_MIRROR — зеркало (по умолчанию C:\ErfolgCRM-backups;
#                          укажите папку Яндекс.Диска для облачной копии;
#                          пустая строка '-' = зеркало выключено)
#   ERFOLG_BACKUP_KEEP   — сколько дней хранить (по умолчанию 14)

$ErrorActionPreference = 'Stop'

$Container = 'erfolgcrm-postgres-dev'
$DbUser    = 'erfolg'
$DbName    = 'erfolg_dev'
$BackupDir = if ($env:ERFOLG_BACKUP_DIR) { $env:ERFOLG_BACKUP_DIR } else { 'D:\ErfolgCRM-backups' }
$Mirror    = if ($null -ne $env:ERFOLG_BACKUP_MIRROR) { $env:ERFOLG_BACKUP_MIRROR } else { 'C:\ErfolgCRM-backups' }
$KeepDays  = if ($env:ERFOLG_BACKUP_KEEP) { [int]$env:ERFOLG_BACKUP_KEEP } else { 14 }

$stamp    = Get-Date -Format 'yyyy-MM-dd_HHmm'
$fileName = "erfolg_dev_$stamp.dump"
$tmpInContainer = "/tmp/$fileName"
$logFile  = Join-Path $BackupDir 'backup.log'

function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Write-Host $line
  if (Test-Path $BackupDir) { Add-Content -Path $logFile -Value $line -Encoding UTF8 }
}

try {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

  # Контейнер жив?
  $running = docker ps --filter "name=$Container" --format '{{.Names}}'
  if ($running -ne $Container) { throw "Контейнер $Container не запущен" }

  # 1. Дамп внутри контейнера (бинарный поток через PowerShell портится — поэтому файл).
  docker exec $Container pg_dump -U $DbUser -Fc -f $tmpInContainer $DbName
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump завершился с ошибкой' }

  # 2. Проверка читаемости дампа.
  $tocLines = docker exec $Container pg_restore --list $tmpInContainer 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'pg_restore --list не смог прочитать дамп — бэкап битый' }
  $tocCount = ($tocLines | Measure-Object -Line).Lines
  if ($tocCount -lt 50) { throw "Подозрительно маленький дамп (всего $tocCount объектов)" }

  # 3. Забираем на хост.
  $hostPath = Join-Path $BackupDir $fileName
  docker cp "${Container}:$tmpInContainer" $hostPath | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $hostPath)) { throw 'docker cp не отдал файл' }
  docker exec $Container rm -f $tmpInContainer | Out-Null
  $sizeMb = [math]::Round((Get-Item $hostPath).Length / 1MB, 2)

  # 4. Зеркало (второй диск / Яндекс.Диск). Сбой зеркала бэкап не валит.
  $mirrorNote = 'зеркало выключено'
  if ($Mirror -and $Mirror -ne '-') {
    try {
      New-Item -ItemType Directory -Force -Path $Mirror | Out-Null
      Copy-Item $hostPath -Destination (Join-Path $Mirror $fileName) -Force
      $mirrorNote = "зеркало: $Mirror"
    } catch {
      $mirrorNote = "зеркало НЕДОСТУПНО ($($_.Exception.Message))"
    }
  }

  # 5. Ротация в обоих каталогах.
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  foreach ($dir in @($BackupDir, $Mirror)) {
    if ($dir -and $dir -ne '-' -and (Test-Path $dir)) {
      Get-ChildItem $dir -Filter 'erfolg_dev_*.dump' |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object { Remove-Item $_.FullName -Force -Confirm:$false }
    }
  }

  Write-Log "OK  $fileName  ${sizeMb}МБ, объектов в дампе: $tocCount, $mirrorNote"
  exit 0
} catch {
  Write-Log "ОШИБКА  $($_.Exception.Message)"
  exit 1
}
