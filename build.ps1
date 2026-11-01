# 打包为 xpi：pwsh -File build.ps1 [-Version 1.0.0]
param(
	[string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root ("zhinfo-{0}.xpi" -f $Version)

if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }

$include = @('.json', '.js', '.css', '.xhtml', '.ftl', '.svg', '.png')
$files = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {
	$include -contains $_.Extension -and $_.Name -ne 'build.ps1' -and $_.Extension -ne '.xpi' -and $_.Name -notlike '_*'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
	foreach ($f in $files) {
		$rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
		[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel) | Out-Null
	}
}
finally {
	$zip.Dispose()
}

Write-Host ("已生成：{0}（{1} 个文件）" -f $out, $files.Count)
Write-Host "安装：Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File…"