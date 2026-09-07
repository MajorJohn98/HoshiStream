namespace HoshiStream.Windows;

internal static class IntegrationCommands
{
    public static bool IsOwned(IReadOnlyList<string> arguments, string executable, bool magnet)
    {
        if (arguments.Count == 0 || !arguments[0].Equals(executable, StringComparison.OrdinalIgnoreCase)) return false;
        var hasMagnet = false;
        var options = new HashSet<string>(StringComparer.Ordinal);
        foreach (var argument in arguments.Skip(1))
        {
            if (argument == "--magnet=%1")
            {
                if (!magnet || hasMagnet) return false;
                hasMagnet = true;
                continue;
            }
            var equals = argument.IndexOf('=');
            if (equals < 0) return false;
            var name = argument[..equals];
            if (name is not ("--runtime-root" or "--state-dir") || !options.Add(name)
                || !Path.IsPathFullyQualified(argument[(equals + 1)..])) return false;
        }
        return hasMagnet == magnet;
    }
}
