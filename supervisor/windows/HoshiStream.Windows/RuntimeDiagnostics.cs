using System.Text.Json;

namespace HoshiStream.Windows;

internal static class RuntimeDiagnostics
{
    public static string? Classify(string line)
    {
        if (line.StartsWith('{'))
        {
            try
            {
                using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 16 });
                if (document.RootElement.TryGetProperty("event", out var value) && value.ValueKind == JsonValueKind.String)
                    return value.GetString() switch
                    {
                        "native_ready" => "native_ready",
                        "native_start_failed" => document.RootElement.TryGetProperty("error", out var error)
                            && error.ValueKind == JsonValueKind.String
                                ? ClassifyFailure(error.GetString()!) ?? "native_start_failed"
                                : "native_start_failed",
                        "torrserver_spawn_failed" => "torrserver_spawn_failed",
                        "native_shutdown_failed" => "native_shutdown_failed",
                        "addon_shutdown_failed" => "addon_shutdown_failed",
                        "native_control_cleanup_failed" => "native_control_cleanup_failed",
                        "forced_exit" => "runtime_forced_exit",
                        "chrome_bridge_registered" => "chrome_bridge_registered",
                        "chrome_bridge_registration_failed" => "chrome_bridge_registration_failed",
                        _ => null
                    };
            }
            catch (JsonException) { return null; }
        }
        return ClassifyFailure(line);
    }

    private static string? ClassifyFailure(string line)
    {
        if (line.Contains("Port ", StringComparison.Ordinal) && line.Contains("already in use", StringComparison.Ordinal))
            return "runtime_port_in_use";
        if (line.Contains("owns this state directory", StringComparison.Ordinal))
            return "runtime_state_already_owned";
        if (line.Contains("ENOENT", StringComparison.Ordinal))
            return "runtime_required_file_missing";
        if (line.Contains("EACCES", StringComparison.Ordinal) || line.Contains("EPERM", StringComparison.Ordinal))
            return "runtime_file_access_denied";
        return null;
    }

    public static bool ShouldRecover(int? exitCode, string? startupFailure) => exitCode != 0
        && startupFailure is not ("runtime_state_already_owned" or "runtime_port_in_use");
}
