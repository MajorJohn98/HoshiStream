export const manifest = {
  id: "com.john.private-torrent-streamer",
  version: "0.2.0",
  name: "HoshiStream",
  description: "Private local library for legally owned or authorized media",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["hoshi:"],
  behaviorHints: { p2p: true },
  catalogs: [
    {
      type: "movie",
      id: "private-movies",
      name: "Private Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "private-series",
      name: "Private Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
};
