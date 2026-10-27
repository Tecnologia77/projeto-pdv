# Publica só a correção da foto do produto no pdvstock.com.br.
# Baixa o site que já está no ar, troca o ai.js e o cache do index.html,
# e faz o deploy. Não usa a cópia antiga do Git para app.js nem delivery.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Instale o Node.js (https://nodejs.org) e abra o PowerShell de novo."
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  throw "curl.exe não encontrado. Use o PowerShell do Windows 10 ou mais novo."
}

$dest = Join-Path $env:TEMP "pdvstock-foto-deploy"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest | Out-Null

$files = @(
  "index.html",
  "delivery.html",
  "app.js",
  "styles.css",
  "style.css",
  "pwa.js",
  "firebase-config.js",
  "qz-security.js",
  "qz-certificate.txt",
  "delivery.js",
  "delivery.css",
  "delivery-logic.js",
  "manifest.webmanifest",
  "manifest-delivery.webmanifest",
  "favicon.ico",
  "404.html",
  "icons/app-icon-48.png",
  "icons/app-icon-128.png",
  "icons/app-icon-192.png",
  "icons/app-icon-256.png",
  "icons/app-icon-512.png",
  "icons/app-icon-512-maskable.png"
)

foreach ($f in $files) {
  $out = Join-Path $dest ($f -replace "/", "\")
  $dir = Split-Path $out -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  Write-Host "Baixando $f"
  & curl.exe -fsSL "https://pdvstock.com.br/$f" -o $out
  if ($LASTEXITCODE -ne 0) { throw "Falhou ao baixar $f" }
}

Write-Host "Baixando a correção da foto"
$ai = Join-Path $dest "ai.js"
& curl.exe -fsSL "https://raw.githubusercontent.com/Tecnologia77/projeto-pdv/cursor/fix-product-photo-imgbb-aaa8/ai.js" -o $ai
if ($LASTEXITCODE -ne 0) { throw "Não consegui baixar o ai.js novo do GitHub." }
$aiText = [System.IO.File]::ReadAllText($ai)
if ($aiText -notmatch "IMGBB_PLACEHOLDER_SHA256") {
  throw "O ai.js baixado não é a versão corrigida."
}

$indexPath = Join-Path $dest "index.html"
$html = [System.IO.File]::ReadAllText($indexPath)
$html2 = [regex]::Replace($html, "ai\.js\?v=\d+", "ai.js?v=202610271900")
if ($html2 -notmatch "ai\.js\?v=202610271900") {
  throw "Não achei a tag do ai.js no index.html do site."
}
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($indexPath, $html2, $utf8)

$firebaseJson = '{"hosting":{"site":"adega-brothers","public":".","ignore":["firebase.json","**/.*","**/node_modules/**"]}}'
$firebaserc = '{"projects":{"default":"adega-brothers"}}'
[System.IO.File]::WriteAllText((Join-Path $dest "firebase.json"), $firebaseJson, $utf8)
[System.IO.File]::WriteAllText((Join-Path $dest ".firebaserc"), $firebaserc, $utf8)

Set-Location $dest
Write-Host "Se pedir login, entre com a conta Google do projeto Firebase adega-brothers."
& npx --yes firebase-tools@14 deploy --only hosting --project adega-brothers
if ($LASTEXITCODE -ne 0) { throw "O deploy falhou. Rode: npx --yes firebase-tools@14 login" }
Write-Host "Pronto. No navegador da loja aperte Ctrl+F5 antes de testar a foto."
