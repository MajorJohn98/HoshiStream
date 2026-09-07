using System.Text.Json;

namespace HoshiStream.Windows;

internal static class PipeMessages
{
    public static async Task<JsonDocument> ReadAsync(Stream stream, int maximum, CancellationToken cancellation)
    {
        var bytes = new byte[maximum + 1];
        var count = 0;
        while (count < bytes.Length)
        {
            var read = await stream.ReadAsync(bytes.AsMemory(count, 1), cancellation);
            if (read == 0) throw new EndOfStreamException();
            if (bytes[count] == '\n')
                return JsonDocument.Parse(bytes.AsMemory(0, count), new JsonDocumentOptions { MaxDepth = 12 });
            count++;
        }
        throw new InvalidDataException("Pipe request exceeded its limit.");
    }

    public static async Task WriteAsync(Stream stream, object value, CancellationToken cancellation)
    {
        await stream.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(value, Contracts.Json), cancellation);
        await stream.WriteAsync(new byte[] { 10 }, cancellation);
        await stream.FlushAsync(cancellation);
    }
}
