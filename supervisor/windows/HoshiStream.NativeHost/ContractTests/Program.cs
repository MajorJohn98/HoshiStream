using HoshiStream.NativeHost;
using HoshiStream.Windows;

namespace HoshiStream.Browser.ContractTests;

internal static class Program
{
    private static async Task Main()
    {
        string state = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "Hoshi State's & test"));
        string[] brokerArgs = DesktopActivationLauncher.BrokerArguments(state);
        LaunchOptions broker = LaunchOptions.Parse(brokerArgs);
        Require(broker.StateDirectory == state && !broker.ActivateFromStdin, "Broker state/primary contract mismatch");

        var secondaryStart = DesktopActivationLauncher.SecondaryStart(
            Path.Combine(Path.GetTempPath(), "HoshiStream.exe"), state);
        LaunchOptions secondary = LaunchOptions.Parse(secondaryStart.ArgumentList.ToArray());
        Require(secondary.StateDirectory == state && secondary.ActivateFromStdin, "Forward-only state contract mismatch");
        Require(secondaryStart.RedirectStandardInput && !secondaryStart.UseShellExecute, "Forwarder lacks private stdin");

        const string url = "http://127.0.0.1:7001/manage/private-contract-token#/entry/hoshi%3Afixture";
        foreach (DesktopActivation action in new[] { new DesktopActivation(1, "open-library"), new(1, "open-url", url) })
        {
            using var input = new MemoryStream();
            input.Write(DesktopActivationLauncher.Payload(action));
            input.WriteByte(10);
            input.Position = 0;
            Activation actual = await Contracts.ReadStdinActivationAsync(input, CancellationToken.None);
            Require(actual.Command == action.Command && actual.Value == action.Value, "Stdin activation contract mismatch");
        }
        Require(!string.Join(" ", brokerArgs.Concat(secondaryStart.ArgumentList)).Contains("private-contract-token", StringComparison.Ordinal),
            "Credential entered wrapper command arguments");
        bool rejected = false;
        try { LaunchOptions.Parse(["--open-url=" + url]); }
        catch (ArgumentException) { rejected = true; }
        Require(rejected, "Tokenized URL was accepted on the tray command line");
        Console.WriteLine("Browser and tray activation contracts passed.");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
