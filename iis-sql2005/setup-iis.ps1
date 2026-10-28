# Run as Administrator on the Windows Server 2008 R2 box (PowerShell 2.0). Copy this folder to C:\lab\nbahub
# first, with App_Code\Api.cs as C:\lab\nbahub\Api.cs, and replace @FEEDER_PW@ in roster_db.sql with the
# feeder's password (the file is deleted after it runs).
$ErrorActionPreference = 'Stop'
function Say($m) { "[{0:HH:mm:ss}] $m" -f (Get-Date) }
Set-ExecutionPolicy RemoteSigned -Force
Import-Module ServerManager
$f = 'Web-Server','Web-Static-Content','Web-Default-Doc','Web-Http-Errors','Web-Http-Logging','Web-Request-Monitor','Web-Filtering','Web-Asp-Net','Web-Net-Ext','Web-ISAPI-Ext','Web-ISAPI-Filter','Web-Mgmt-Console'
$r = Add-WindowsFeature $f; Say "IIS features: success=$($r.Success) restart=$($r.RestartNeeded) changed=$(@($r.FeatureResult).Count)"
Import-Module WebAdministration
if (-not (Test-Path IIS:\AppPools\NbaHub)) { New-WebAppPool NbaHub | Out-Null }
Set-ItemProperty IIS:\AppPools\NbaHub -Name managedRuntimeVersion -Value v2.0
Set-ItemProperty IIS:\AppPools\NbaHub -Name managedPipelineMode -Value 0
Set-ItemProperty IIS:\AppPools\NbaHub -Name processModel.identityType -Value 4
$site = 'C:\inetpub\nbahub'
New-Item -ItemType Directory -Force "$site\App_Code" | Out-Null
Copy-Item C:\lab\nbahub\index.html, C:\lab\nbahub\logo.svg, C:\lab\nbahub\web.config $site -Force
Copy-Item C:\lab\nbahub\Api.cs "$site\App_Code\Api.cs" -Force
if (Test-Path 'IIS:\Sites\Default Web Site') { Stop-Website 'Default Web Site'; Set-ItemProperty 'IIS:\Sites\Default Web Site' -Name serverAutoStart -Value $false }
if (-not (Test-Path 'IIS:\Sites\NbaHub')) { New-Website -Name NbaHub -Port 80 -PhysicalPath $site -ApplicationPool NbaHub | Out-Null }
Start-Website NbaHub
Say "site: $((Get-Item 'IIS:\Sites\NbaHub').State) on port 80, pool $((Get-Item IIS:\AppPools\NbaHub).managedRuntimeVersion)"
$sqlcmd = 'C:\Program Files\Microsoft SQL Server\90\Tools\Binn\SQLCMD.EXE'
$out = & $sqlcmd -S 'tcp:127.0.0.1,1433' -E -b -i C:\lab\nbahub\roster_db.sql 2>&1; Say "roster_db: exit $LASTEXITCODE"; $out | Select-Object -Last 6
Remove-Item C:\lab\nbahub\roster_db.sql -Force   # contained the feeder password
& netsh advfirewall firewall add rule name="Lab HTTP 80" dir=in action=allow protocol=TCP localport=80 remoteip=localsubnet | Out-Null
$ErrorActionPreference = 'Continue'
foreach ($u in '/api/health', '/api/roster', '/api/mvp', '/') {
  try { $b = (New-Object Net.WebClient).DownloadString("http://localhost$u"); Say "GET $u -> $($b.Length) bytes: $($b.Substring(0, [Math]::Min(160, $b.Length)))" }
  catch { Say "GET $u FAILED: $($_.Exception.Message)" }
}
