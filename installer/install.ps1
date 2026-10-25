<#
    MaxBridge — установщик моста MAX ↔ DeepSeek Harness.

    Что делает:
      1. проверяет токен бота (GET /me);
      2. ловит chat_id — просит написать боту и читает /updates;
      3. копирует плагин в %LOCALAPPDATA%\MaxBridge\max-bridge;
      4. подключает его к профилю desktop (зависимость, бандлы, pnpm);
      5. сохраняет токен в ~/.dsh/max-bot.json;
      6. перезапускает приложение.

    Запуск: powershell -ExecutionPolicy Bypass -File install.ps1
#>

param(
    [switch]$Headless,
    [switch]$NoRestart,
    [string]$Token = $env:MAX_TOKEN,
    [long]$ChatId = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$ApiBase = 'https://platform-api2.max.ru'
$DshHome = Join-Path $env:USERPROFILE '.dsh'
$ProfileDir = Join-Path $DshHome 'profiles\desktop'
$PluginSrc = Join-Path $PSScriptRoot 'max-bridge'
$PluginDst = Join-Path $env:LOCALAPPDATA 'MaxBridge\max-bridge'

# ---------------------------------------------------------------- утилиты ---

function Invoke-MaxApi {
    param([string]$Path, [string]$Token)
    # curl -k: Bot API MAX отдаёт сертификат с цепочкой Минцифры,
    # которой нет в стандартном хранилище Windows.
    $raw = & curl.exe -k -s --max-time 20 -H "Authorization: $Token" "$ApiBase$Path" 2>$null
    if (-not $raw) { return $null }
    try { return $raw | ConvertFrom-Json } catch { return $null }
}

function Write-Log {
    param([string]$Text)
    if ($Headless) { Write-Host $Text; return }
    $box.AppendText("$Text`r`n")
    $box.SelectionStart = $box.Text.Length
    $box.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
}

# --------------------------------------------------------------- установка ---

function Install-Bridge {
    param([string]$Token, [long]$ChatId)

    Write-Log 'Копирую плагин…'
    New-Item -ItemType Directory -Force -Path (Split-Path $PluginDst) | Out-Null
    if (Test-Path $PluginDst) { Remove-Item $PluginDst -Recurse -Force }
    Copy-Item $PluginSrc $PluginDst -Recurse -Force
    Write-Log "  плагин: $PluginDst"

    Write-Log 'Сохраняю токен…'
    New-Item -ItemType Directory -Force -Path $DshHome | Out-Null
    $account = @{ token = $Token; chat_id = $ChatId } | ConvertTo-Json -Compress
    $tokenFile = Join-Path $DshHome 'max-bot.json'
    # Важно: без BOM. Set-Content -Encoding UTF8 в PowerShell 5.1 пишет BOM,
    # а JSON.parse в плагине на нём падает — токен перестаёт читаться.
    [IO.File]::WriteAllText($tokenFile, $account, (New-Object Text.UTF8Encoding($false)))
    # На Windows права 0600 не действуют: закрываем ACL на текущего пользователя.
    & icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1 | Out-Null
    Write-Log "  чат: $ChatId"

    if (-not (Test-Path $ProfileDir)) {
        Write-Log "Профиль не найден: $ProfileDir"
        Write-Log 'Сначала запустите DeepSeek Harness хотя бы один раз.'
        return $false
    }

    Write-Log 'Подключаю к профилю…'
    $link = Join-Path $ProfileDir 'node_modules\@local\max-bridge'
    New-Item -ItemType Directory -Force -Path (Split-Path $link) | Out-Null
    if (Test-Path $link) { cmd /c rmdir "$link" 2>$null | Out-Null }
    cmd /c mklink /J "$link" "$PluginDst" | Out-Null

    $pkgPath = Join-Path $ProfileDir 'package.json'
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    if (-not $pkg.dependencies) {
        $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
    }
    $pkg.dependencies | Add-Member -NotePropertyName '@local/max-bridge' -NotePropertyValue "link:$($PluginDst -replace '\\','/')" -Force
    $bundles = @($pkg.dsh.profile.bundles)
    if ($bundles -notcontains '@local/max-bridge') { $bundles += '@local/max-bridge' }
    $pkg.dsh.profile.bundles = $bundles
    [IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    Write-Log '  зависимости профиля обновлены'

    # pnpm из поставки Harness — если он есть.
    $runtime = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies'
    $node = Join-Path $runtime 'node\bin\node.exe'
    $pnpm = Join-Path $runtime 'pnpm\bin\pnpm.mjs'
    if ((Test-Path $node) -and (Test-Path $pnpm)) {
        Write-Log 'Устанавливаю зависимости (pnpm)…'
        Push-Location $ProfileDir
        try { & $node $pnpm install --prefer-offline 2>&1 | ForEach-Object { Write-Log "  $_" } }
        finally { Pop-Location }
    }

    if ($NoRestart) {
        Write-Log 'Перезапуск пропущен (-NoRestart). Запустите приложение вручную.'
        return $true
    }

    Write-Log 'Перезапускаю приложение…'
    Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    $exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
    if (Test-Path $exe) {
        # Через планировщик: приложение должно подняться в пользовательской
        # сессии. Прямой Start-Process из установщика, запущенного службой
        # или по SSH, попадает в служебную сессию и сразу завершается.
        $task = 'MaxBridgeStart'
        & schtasks /create /tn $task /tr "`"$exe`"" /sc once /st 23:59 /it /f 2>&1 | Out-Null
        $started = $false
        if ($LASTEXITCODE -eq 0) {
            & schtasks /run /tn $task 2>&1 | Out-Null
            $started = $LASTEXITCODE -eq 0
        }
        if (-not $started) { Start-Process $exe }
    }
    return $true
}

# --- режим без интерфейса: установка по готовым токену и chat_id -----------
if ($Headless) {
    if (-not $Token) { Write-Host 'нужен -Token или MAX_TOKEN'; exit 1 }
    if (-not $ChatId) { Write-Host 'нужен -ChatId'; exit 1 }
    $ok = Install-Bridge -Token $Token -ChatId $ChatId
    exit $(if ($ok) { 0 } else { 1 })
}

# -------------------------------------------------------------------- окно ---

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MAX Bridge — установка'
$form.Size = New-Object System.Drawing.Size(620, 520)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 32)
$form.ForeColor = [System.Drawing.Color]::White

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Мост MAX ↔ DeepSeek Harness'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(20, 16)
$form.Controls.Add($title)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = 'Вставьте токен бота из business.max.ru → Чат-боты → Настройки'
$hint.AutoSize = $true
$hint.ForeColor = [System.Drawing.Color]::FromArgb(160, 160, 170)
$hint.Location = New-Object System.Drawing.Point(22, 50)
$form.Controls.Add($hint)

$txtToken = New-Object System.Windows.Forms.TextBox
$txtToken.Location = New-Object System.Drawing.Point(22, 78)
$txtToken.Size = New-Object System.Drawing.Size(560, 28)
$txtToken.Font = New-Object System.Drawing.Font('Consolas', 10)
$form.Controls.Add($txtToken)

$btnCheck = New-Object System.Windows.Forms.Button
$btnCheck.Text = 'Проверить'
$btnCheck.Location = New-Object System.Drawing.Point(22, 116)
$btnCheck.Size = New-Object System.Drawing.Size(140, 32)
$form.Controls.Add($btnCheck)

$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Text = 'Установить'
$btnInstall.Location = New-Object System.Drawing.Point(172, 116)
$btnInstall.Size = New-Object System.Drawing.Size(140, 32)
$btnInstall.Enabled = $false
$form.Controls.Add($btnInstall)

$btnPair = New-Object System.Windows.Forms.Button
$btnPair.Text = 'Поймать чат'
$btnPair.Location = New-Object System.Drawing.Point(322, 116)
$btnPair.Size = New-Object System.Drawing.Size(140, 32)
$btnPair.Enabled = $false
$form.Controls.Add($btnPair)

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.ScrollBars = 'Vertical'
$box.ReadOnly = $true
$box.Location = New-Object System.Drawing.Point(22, 162)
$box.Size = New-Object System.Drawing.Size(560, 300)
$box.Font = New-Object System.Drawing.Font('Consolas', 9)
$box.BackColor = [System.Drawing.Color]::FromArgb(18, 18, 22)
$box.ForeColor = [System.Drawing.Color]::FromArgb(200, 230, 200)
$form.Controls.Add($box)

$state = @{ token = $null; botName = $null; chatId = $null }

# ------------------------------------------------------------------ логика ---

$btnCheck.Add_Click({
    $token = $txtToken.Text.Trim()
    if (-not $token) { Write-Log 'Вставьте токен.'; return }
    Write-Log 'Проверяю токен…'
    $me = Invoke-MaxApi -Path '/me' -Token $token
    if ($me -and $me.username) {
        $state.token = $token
        $state.botName = $me.name
        Write-Log "  бот найден: @$($me.username) ($($me.name))"
        $btnInstall.Enabled = $true
        $btnPair.Enabled = $true
    } else {
        Write-Log '  токен не подошёл — проверьте, что скопирован целиком'
    }
})

$btnPair.Add_Click({
    if (-not $state.token) { Write-Log 'Сначала проверьте токен.'; return }
    Write-Log 'Жду сообщение боту — напишите ему в MAX любое слово…'
    $deadline = (Get-Date).AddSeconds(90)
    $marker = ''
    while ((Get-Date) -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        $updates = Invoke-MaxApi -Path "/updates?timeout=5&limit=10$marker" -Token $state.token
        if ($updates -and $updates.marker) { $marker = "&marker=$($updates.marker)" }
        foreach ($u in @($updates.updates)) {
            $m = $u.message
            if ($m -and $m.sender -and -not $m.sender.is_bot -and $m.recipient.chat_id) {
                $state.chatId = [long]$m.recipient.chat_id
                Write-Log "  чат найден: $($state.chatId)"
                return
            }
        }
        Start-Sleep -Milliseconds 800
    }
    Write-Log '  сообщение не пришло за 90 секунд — нажмите ещё раз и напишите боту'
})

$btnInstall.Add_Click({
    if (-not $state.token) { Write-Log 'Сначала проверьте токен.'; return }
    if (-not $state.chatId) { Write-Log 'Сначала нажмите «Поймать чат» и напишите боту.'; return }
    $btnInstall.Enabled = $false
    $btnCheck.Enabled = $false
    $btnPair.Enabled = $false
    try {
        $ok = Install-Bridge -Token $state.token -ChatId $state.chatId
        Write-Log $(if ($ok) { 'Готово. Напишите боту — он ответит.' } else { 'Установка не завершена.' })
    } catch {
        Write-Log "Ошибка: $($_.Exception.Message)"
    }
})

[void]$form.ShowDialog()
