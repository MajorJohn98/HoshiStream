using System.Text;
using System.Text.Json;

namespace HoshiStream.Windows;

internal sealed record Activation(int Version, string Command, string? Value = null);

internal sealed record LaunchOptions(string? RuntimeRoot, Activation Activation, bool ActivateFromStdin = false, string? StateDirectory = null)
{
    public static LaunchOptions Parse(string[] args)
    {
        string? root = null;
        string? state = null;
        Activation? activation = null;
        var stdin = false;
        foreach (var arg in args)
        {
            if (arg.StartsWith("--runtime-root=", StringComparison.Ordinal))
            {
                if (root is not null) throw new ArgumentException("Duplicate runtime root.");
                root = arg["--runtime-root=".Length..];
                if (!Path.IsPathFullyQualified(root)) throw new ArgumentException("Absolute runtime root required.");
                continue;
            }
            if (arg.StartsWith("--state-dir=", StringComparison.Ordinal))
            {
                if (state is not null) throw new ArgumentException("Duplicate state directory.");
                state = arg["--state-dir=".Length..];
                if (!Path.IsPathFullyQualified(state)) throw new ArgumentException("Absolute state directory required.");
                continue;
            }
            if (arg == "--activate-stdin")
            {
                if (activation is not null || stdin) throw new ArgumentException("Duplicate activation.");
                stdin = true;
                continue;
            }
            if (stdin) throw new ArgumentException("Stdin activation cannot have another action.");
            var next = arg switch
            {
                "--open-library" => new Activation(1, "open-library"),
                "--ensure-running" => new Activation(1, "ensure-running"),
                "--shutdown" => new Activation(1, "shutdown"),
                "--register-magnet" => new Activation(1, "register-magnet"),
                "--unregister-integrations" => new Activation(1, "unregister-integrations"),
                _ when arg.StartsWith("--open-url=", StringComparison.Ordinal) => Contracts.TokenlessActivation(arg[11..]),
                _ when arg.StartsWith("--magnet=", StringComparison.Ordinal) => new Activation(1, "magnet", arg[9..]),
                _ when arg.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase) => new Activation(1, "magnet", arg),
                _ => throw new ArgumentException("Unknown launch option.")
            };
            if (activation is not null || next.Command is not ("register-magnet" or "unregister-integrations")
                && !Contracts.ValidActivation(next))
                throw new ArgumentException("Invalid activation.");
            activation = next;
        }
        return new(root, activation ?? new Activation(1, "default"), stdin, state);
    }
}

internal static class Contracts
{
    public static bool ValidMagnet(string? value) => value is not null
        && Encoding.UTF8.GetByteCount(value) <= 16_384
        && !value.Any(char.IsControl)
        && value.StartsWith("magnet:?", StringComparison.OrdinalIgnoreCase)
        && !value.Contains('#')
        && Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Host.Length == 0;

    private static Uri? LoopbackUri(string? value) => value is not null && value.Length <= 4096
        && !value.Any(char.IsControl) && !value.Contains('\\')
        && Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == "http"
        && (uri.Host == "127.0.0.1" || uri.Host == "localhost" || uri.Host == "[::1]")
        && uri.UserInfo.Length == 0 && uri.Query.Length == 0 ? uri : null;

    public static bool LoopbackManagementUrl(string? value) => LoopbackUri(value) is { } uri
        && uri.AbsolutePath.StartsWith("/manage/", StringComparison.Ordinal)
        && uri.AbsolutePath.Length > "/manage/".Length;

    public static Activation TokenlessActivation(string value)
    {
        var uri = LoopbackUri(value);
        if (uri is null || uri.AbsolutePath is not ("/manage" or "/manage/")
            || uri.Fragment is not ("" or "#/library" or "#/welcome"))
            throw new ArgumentException("Command-line URLs must not contain credentials. Use stdin activation.");
        return new(1, uri.Fragment == "#/welcome" ? "open-welcome" : "open-library");
    }

    public static async Task<Activation> ReadStdinActivationAsync(Stream input, CancellationToken cancellation)
    {
        using var document = await PipeMessages.ReadAsync(input, 65_536, cancellation);
        var activation = document.Deserialize<Activation>(Json);
        if (activation is null || !ValidActivation(activation) || activation.Command is not ("open-url" or "open-library"))
            throw new InvalidDataException("Invalid stdin activation.");
        return activation;
    }

    public static bool ValidActivation(Activation value) => value.Version == 1 && value.Command switch
    {
        "default" or "ensure-running" or "open-library" or "open-welcome" or "shutdown" => value.Value is null,
        "open-url" => LoopbackManagementUrl(value.Value),
        "magnet" => ValidMagnet(value.Value),
        _ => false
    };

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { MaxDepth = 12 };
}
