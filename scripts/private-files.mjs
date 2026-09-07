import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const aclScript = `
$ErrorActionPreference = 'Stop'
$directory = $env:HOSHISTREAM_PRIVATE_DIRECTORY -eq 'true'
$acl = if ($directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
foreach ($identity in @($sid, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inheritance, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $env:HOSHISTREAM_PRIVATE_PATH -AclObject $acl
`;

export async function restrictAccess(path, { directory = false } = {}) {
  if (process.platform !== "win32") {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", aclScript],
    {
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        HOSHISTREAM_PRIVATE_PATH: path,
        HOSHISTREAM_PRIVATE_DIRECTORY: String(directory),
      },
    },
  );
}
