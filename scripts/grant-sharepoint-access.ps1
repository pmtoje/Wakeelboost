<#
.SYNOPSIS
  Give the WakeelBoost app registration Write access to ONE SharePoint site or OneDrive (Sites.Selected).

.DESCRIPTION
  Run by a Microsoft 365 administrator (Global Administrator, Privileged Role Administrator or
  SharePoint Administrator) AFTER the "WakeelBoost Work Desk" app is registered with the Microsoft Graph
  application permission Sites.Selected and admin consent is granted (see docs/SHAREPOINT.md).

  Uses the Microsoft Graph PowerShell SDK. It grants access to the one site given, then lists the site's
  app permissions so you can confirm. It changes nothing else.

.EXAMPLE
  # Trial: Paul Toje's OneDrive
  ./grant-sharepoint-access.ps1 -AppId <application-client-id> `
    -Site "sterlingbankng-my.sharepoint.com:/personal/paul_toje_altbank_ng"

.EXAMPLE
  # Later: the WakeelBoost team site
  ./grant-sharepoint-access.ps1 -AppId <application-client-id> `
    -Site "sterlingbankng.sharepoint.com:/sites/WakeelBoost"
#>
param(
  [Parameter(Mandatory = $true)][string]$AppId,
  [Parameter(Mandatory = $true)][string]$Site,
  [string]$DisplayName = "WakeelBoost Work Desk",
  [ValidateSet("read", "write")][string]$Role = "write"
)
$ErrorActionPreference = "Stop"

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Sites)) {
  Write-Host "Installing the Microsoft Graph PowerShell module for the current user..."
  Install-Module Microsoft.Graph.Sites -Scope CurrentUser -Force
}
Import-Module Microsoft.Graph.Sites

# Sign in as the administrator. Sites.FullControl.All is needed only to grant the permission; the
# WakeelBoost app itself receives access to this one site only.
Connect-MgGraph -Scopes "Sites.FullControl.All" -NoWelcome

$siteObj = Get-MgSite -SiteId $Site
Write-Host "Site: $($siteObj.WebUrl)  (id $($siteObj.Id))"

$body = @{
  roles               = @($Role)
  grantedToIdentities = @(@{ application = @{ id = $AppId; displayName = $DisplayName } })
}
New-MgSitePermission -SiteId $siteObj.Id -BodyParameter $body | Out-Null
Write-Host "Granted '$Role' on this site to $DisplayName ($AppId)."

Write-Host "`nApp permissions now on this site:"
Get-MgSitePermission -SiteId $siteObj.Id | ForEach-Object {
  $apps = $_.GrantedToIdentitiesV2.Application + $_.GrantedToIdentities.Application | Where-Object { $_ }
  foreach ($a in $apps) { Write-Host ("  {0} ({1}): {2}" -f $a.DisplayName, $a.Id, ($_.Roles -join ", ")) }
}
Write-Host "`nNext, on the WakeelBoost server: npm run storage:check-sharepoint"
Disconnect-MgGraph | Out-Null
