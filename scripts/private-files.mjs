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

// Environment for spawning Windows PowerShell 5.1 (`powershell.exe`). When the
// parent is PowerShell 7 (`pwsh`, the default shell on GitHub's Windows runners
// and common in developer terminals) its PSModulePath points at PS 7 modules.
// Inheriting it makes 5.1 try to load the PS 7 build of
// Microsoft.PowerShell.Security, and Set-Acl fails with
// CouldNotAutoloadMatchingModule. Dropping the variable lets 5.1 use its own
// default module path.
export function windowsPowerShellEnvironment(extra = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== "psmodulepath") environment[key] = value;
  }
  return { ...environment, ...extra };
}

export async function restrictAccess(path, { directory = false } = {}) {
  if (process.platform !== "win32") {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", aclScript],
    {
      // Windows PowerShell cold-starts .NET; the first launch on a loaded
      // machine (or many parallel test workers) can exceed 10 s.
      timeout: 30_000,
      windowsHide: true,
      env: windowsPowerShellEnvironment({
        HOSHISTREAM_PRIVATE_PATH: path,
        HOSHISTREAM_PRIVATE_DIRECTORY: String(directory),
      }),
    },
  );
}
