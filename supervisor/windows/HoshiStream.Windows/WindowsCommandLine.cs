using System.Text;

namespace HoshiStream.Windows;

internal static class WindowsCommandLine
{
    // CRT quoting, including embedded quotes and trailing backslashes.
    // CreateProcess has no ArgumentList overload; it receives this encoding of it.
    public static string QuoteArgument(string value)
    {
        if (value.IndexOf('\0') >= 0) throw new ArgumentException("NUL in argument.");
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
}
