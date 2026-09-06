# ADR 0021: Native macOS magnet-link handler

Date: 2026-09-06
Status: Accepted

## Context

Users should be able to open a magnet link in HoshiStream just as they can in a
torrent client, without copying it or granting a browser extension access to
every website.

## Decision

The macOS app declares the `magnet:` URL scheme and offers an explicit
**Use HoshiStream for Magnet Links** menu action using the macOS default-handler
API. Installing the app does not programmatically replace another default.
The user has explicitly authorized making HoshiStream the default on this Mac.

Incoming links wait for the local server to start, with at most 16 queued links
and a 60-second deadline. The supervisor submits the source to the authenticated
loopback import API. That API validates a single BitTorrent v1 identity and issues
an opaque, random review ticket. Tickets live in memory for ten minutes, are
bounded to 32, and are cleared on restart.

Only the ticket ID goes into the management-page fragment. The source is never
placed in browser URLs or native logs. The authenticated management page reads
the ticket and prefills the existing editable Add Media form. Creating or reading
a ticket neither saves an entry nor resolves the torrent. Saving and optional
source checks remain explicit actions in the existing flow.

## Consequences

Magnet clicks can work from any browser or application using the system handler;
the Chrome extension remains useful for page-link capture and torrent files.
Cold starts are supported. Expired links need another click or manual entry.
Windows URL handling remains outside this macOS-first phase.
