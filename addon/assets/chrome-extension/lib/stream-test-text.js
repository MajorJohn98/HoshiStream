// Wording for the pre-add stream test card (decision 0029), shared by Add
// Media and the Chrome companion. It imports nothing, so both can load it.
// Two identical copies exist: assets/manage/components/stream-test-text.js
// and assets/chrome-extension/lib/stream-test-text.js. Edit one and copy it
// over the other; a test fails while they differ.

const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";

export const ACTIVE_STREAM_TEST_PHASES = new Set([
  "queued",
  "metadata",
  "measuring",
]);

export function isStreamTestActive(test) {
  return ACTIVE_STREAM_TEST_PHASES.has(test?.phase);
}

const ACTIVE_BADGES = {
  queued: { tone: "warn", label: "Queued" },
  metadata: { tone: "warn", label: "Finding peers" },
  measuring: { tone: "warn", label: "Measuring" },
};

const VERDICT_BADGES = {
  smooth: { tone: "ok", label: "Smooth" },
  tight: { tone: "warn", label: "Tight" },
  too_slow: { tone: "bad", label: "Won't keep up" },
  inconclusive: { tone: "idle", label: "Inconclusive" },
};

export function streamTestBadge(test) {
  if (!test) return { tone: "idle", label: "Not tested" };
  if (isStreamTestActive(test)) return ACTIVE_BADGES[test.phase];
  const verdict = VERDICT_BADGES[test.verdict?.level];
  if (verdict) return verdict;
  if (test.phase === "failed") return { tone: "bad", label: "Test failed" };
  if (test.phase === "cancelled") return { tone: "idle", label: "Cancelled" };
  return { tone: "idle", label: "Finished" };
}

export function mbpsLabel(value) {
  const rounded =
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded + " Mbps";
}

export function durationLabel(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const INCONCLUSIVE = {
  no_metadata: "Inconclusive: no peers sent the torrent's file list in time.",
  no_peers: "Inconclusive: no peers sent any data.",
  few_samples: "Inconclusive: the test ended before it had enough readings.",
  unknown_bitrate:
    "Inconclusive: the file's bitrate couldn't be read. Compare the figures below.",
  stream_started: "Inconclusive: playback started, so the test stopped early.",
};

const BOTTLENECKS = {
  swarm: "The swarm is the limit.",
  line: "Your line is the limit.",
  limit: "TorrServer's download limit is the limit.",
};

export function streamTestSummary(test) {
  if (!test)
    return "Checks whether this torrent downloads faster than it plays, before you save it. The test contacts peers and takes up to 90 seconds.";
  if (isStreamTestActive(test)) return test.message || "Testing…";
  const verdict = test.verdict;
  if (!verdict) return test.message;
  if (verdict.level === "inconclusive")
    return INCONCLUSIVE[verdict.reason] ?? "Inconclusive.";
  if (verdict.level === "smooth")
    return "Should play smoothly: peers deliver it faster than it plays.";
  const lead =
    verdict.level === "tight"
      ? "Tight: it plays, with little room for slow peers or busy scenes."
      : "Won't keep up.";
  const limit = BOTTLENECKS[verdict.bottleneck];
  return limit ? lead + " " + limit : lead;
}

function peersLabel(peers) {
  return peers === undefined
    ? ""
    : ` (${peers} ${peers === 1 ? "peer" : "peers"})`;
}

/** One line of the figures behind the verdict, e.g. "Needs 9.8 Mbps · …". */
export function streamTestFigures(test) {
  if (!test || isStreamTestActive(test)) return "";
  const parts = [];
  if (test.bitrate) parts.push("needs " + mbpsLabel(test.bitrate.mbps));
  const swarm = test.swarm;
  if (swarm?.sustainedMbps !== undefined)
    parts.push(
      "peers deliver " +
        (swarm.atLeast ? "at least " : "") +
        mbpsLabel(swarm.sustainedMbps) +
        peersLabel(swarm.peers),
    );
  else if (swarm?.peakMbps !== undefined)
    parts.push(
      "peers peaked at " + mbpsLabel(swarm.peakMbps) + peersLabel(swarm.peers),
    );
  if (test.line) parts.push("your line " + mbpsLabel(test.line.mbps));
  if (test.limitMbps)
    parts.push("TorrServer limit " + mbpsLabel(test.limitMbps));
  const text = parts.join(" · ");
  return text && text[0].toUpperCase() + text.slice(1);
}

/** Live figures while a test runs. */
export function streamTestProgress(test) {
  if (!isStreamTestActive(test) || test.phase === "queued") return "";
  const parts = [`${test.elapsedSeconds} s of up to ${test.budgetSeconds} s`];
  const progress = test.progress;
  if (progress?.downloadMbps !== undefined)
    parts.push(mbpsLabel(progress.downloadMbps) + " now");
  if (progress?.peers !== undefined)
    parts.push(
      `${progress.peers} ${progress.peers === 1 ? "peer" : "peers"}` +
        (progress.seeders ? `, ${progress.seeders} seeding` : ""),
    );
  if (progress?.bytes) parts.push(fmt(progress.bytes) + " downloaded");
  if (test.bitrate) parts.push("needs " + mbpsLabel(test.bitrate.mbps));
  return parts.join(" · ");
}

/** What the owner can do when the file won't keep up, or only just does. */
export function streamTestRemedies(test) {
  const remedies = test?.verdict?.remedies;
  if (!remedies) return [];
  const list = [
    remedies.fitsCache === false
      ? `Pausing to buffer won't help: it needs ${fmt(remedies.bufferBytes)}, more than TorrServer's ${fmt(test.cacheWindowBytes)} read-ahead cache.`
      : `Start it, then pause about ${durationLabel(remedies.waitSeconds)} to buffer (${fmt(remedies.bufferBytes)}${remedies.fitsCache ? "; fits the cache" : ""}).`,
  ];
  if (remedies.copySeconds !== undefined)
    list.push(
      `Save it, then make a disk copy before watching (about ${durationLabel(remedies.copySeconds)}).`,
    );
  if (remedies.targetMbps !== undefined)
    list.push(
      `Pick a release of ${mbpsLabel(remedies.targetMbps)} or less` +
        (remedies.targetBytes
          ? ` (about ${fmt(remedies.targetBytes)} for this runtime).`
          : "."),
    );
  if (remedies.betterSeeded) list.push("Pick a release with more seeders.");
  return list;
}

/**
 * Caveats about how firm the measurement is. `lineAdvice` ends the stale
 * line note; the companion can't measure the line, so it says where to.
 */
export function streamTestNotes(
  test,
  { lineAdvice = "Measure the line to update it." } = {},
) {
  const verdict = test?.verdict;
  if (!verdict || isStreamTestActive(test)) return [];
  const notes = [];
  if (test.stoppedBy === "complete")
    notes.push("The whole file arrived during the test.");
  if (verdict.flags?.atLeast)
    notes.push(
      "The test reached its data limit early, so peers may deliver faster than shown.",
    );
  if (verdict.flags?.stillSpeedingUp)
    notes.push("Still speeding up: more peers were joining as the test ended.");
  if (verdict.flags?.sharedWithDiskCopy)
    notes.push(
      "A disk copy was downloading during the test and shared your line.",
    );
  if (verdict.lineStale)
    notes.push(
      "Peers delivered faster than your last line reading. " + lineAdvice,
    );
  if (verdict.suggestTestLonger) notes.push("Test longer for a firmer result.");
  return notes;
}

function agoLabel(iso, now) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "at an unknown time";
  const minutes = Math.max(0, Math.round((now - time) / 6e4));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  return hours < 24 ? hours + " h ago" : Math.round(hours / 24) + " days ago";
}

function episodeLabel(file) {
  if (file.season === undefined || file.episode === undefined) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `S${pad(file.season)}E${pad(file.episode)} · `;
}

export function streamTestFileLabel(file) {
  return (
    episodeLabel(file) + file.name.split("/").pop() + " · " + fmt(file.size)
  );
}

export function streamTestRows(test, now = Date.now()) {
  if (!test) return [];
  const { file, swarm, line } = test;
  const finished = !isStreamTestActive(test);
  return [
    file ? ["File", episodeLabel(file) + file.name] : null,
    file ? ["File size", fmt(file.size)] : null,
    test.bitrate ? ["Average bitrate", mbpsLabel(test.bitrate.mbps)] : null,
    test.bitrate?.durationSeconds
      ? ["Duration", durationLabel(test.bitrate.durationSeconds)]
      : null,
    swarm?.sustainedMbps !== undefined
      ? [
          "Sustained swarm rate",
          (swarm.atLeast ? "At least " : "") + mbpsLabel(swarm.sustainedMbps),
        ]
      : null,
    // What peers sent, overhead and out-of-order pieces included; a limit or
    // line caps this, not the in-order rate above.
    swarm?.downloadMbps !== undefined &&
    swarm.downloadMbps !== swarm.sustainedMbps
      ? ["TorrServer download rate", mbpsLabel(swarm.downloadMbps)]
      : null,
    swarm?.peakMbps !== undefined
      ? ["Peak swarm rate", mbpsLabel(swarm.peakMbps)]
      : null,
    swarm?.peers !== undefined
      ? ["Peers", `${swarm.peers} connected · ${swarm.seeders ?? 0} seeding`]
      : null,
    line
      ? [
          "Your line",
          mbpsLabel(line.mbps) +
            (line.source === "measured"
              ? " · measured " + agoLabel(line.measuredAt, now)
              : " · configured, not yet measured"),
        ]
      : null,
    test.limitMbps
      ? ["TorrServer download limit", mbpsLabel(test.limitMbps)]
      : null,
    test.cacheWindowBytes
      ? ["Read-ahead cache", fmt(test.cacheWindowBytes)]
      : null,
    swarm?.bytes ? ["Downloaded during the test", fmt(swarm.bytes)] : null,
    finished && test.phase === "done"
      ? [
          "Test length",
          `${test.elapsedSeconds} s of up to ${test.budgetSeconds} s` +
            (test.mode === "extended" ? " · longer test" : ""),
        ]
      : null,
  ].filter(Boolean);
}
