using System.Diagnostics;
using System.Text.Json.Serialization;

namespace HoshiStream.Windows;

internal sealed record ProcessUsage(double CpuPercent, long RssBytes, int Processes);
internal sealed record ResourceReport(
    bool Available,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ProcessUsage? Addon = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ProcessUsage? TorrServer = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ProcessUsage? Ffmpeg = null);
internal sealed record ProcessSample(int Pid, long CreationTime, string Group, long CpuTicks, long RssBytes, long Timestamp);

internal static class ResourceSamples
{
    public static ResourceReport Measure(IReadOnlyDictionary<int, ProcessSample> before,
        IReadOnlyDictionary<int, ProcessSample> after, int ownerPid)
    {
        if (!after.TryGetValue(ownerPid, out var addon) || addon.Group != "addon"
            || !before.ContainsKey(ownerPid)) return new(false);
        var groups = new Dictionary<string, List<ProcessSample>>
        { ["addon"] = [], ["torrServer"] = [], ["ffmpeg"] = [] };
        foreach (var current in after.Values)
        {
            if (!groups.TryGetValue(current.Group, out var group)) continue;
            if (!before.TryGetValue(current.Pid, out var previous)
                || previous.CreationTime != current.CreationTime || previous.Group != current.Group
                || current.CpuTicks < previous.CpuTicks || current.Timestamp <= previous.Timestamp || current.RssBytes < 0)
                return new(false);
            group.Add(current);
        }
        ProcessUsage Sum(string name)
        {
            double cpu = 0;
            long rss = 0;
            foreach (var current in groups[name])
            {
                var previous = before[current.Pid];
                var seconds = (double)(current.Timestamp - previous.Timestamp) / Stopwatch.Frequency;
                cpu += (current.CpuTicks - previous.CpuTicks) / (double)TimeSpan.TicksPerSecond / seconds * 100;
                rss = checked(rss + current.RssBytes);
            }
            if (!double.IsFinite(cpu) || cpu < 0) throw new InvalidDataException("Invalid process sample.");
            return new(cpu, rss, groups[name].Count);
        }
        return new(true, Sum("addon"), Sum("torrServer"), Sum("ffmpeg"));
    }
}
